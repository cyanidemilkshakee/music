//! Resolve media tools once without the operating system's current-directory
//! executable search. Reject remote namespaces before inspecting the filesystem.
use crate::{config::Config, error::AppError, path_policy};
use std::path::{Component, Path, PathBuf};

fn executable_name(path: &Path) -> Option<PathBuf> {
    if path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return None;
    }
    let name = path.to_str()?;
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return None;
    }
    #[cfg(windows)]
    {
        if path.extension().is_none() {
            return Some(PathBuf::from(format!("{name}.exe")));
        }
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        {
            return None;
        }
    }
    Some(path.to_owned())
}

async fn executable_file(path: &Path) -> Result<Option<PathBuf>, AppError> {
    // These checks also admit missing local suffixes, so installing a missing
    // configured tool remains optional rather than preventing server startup.
    let resolved = path_policy::validate_local_path(path).await?;
    #[cfg(windows)]
    if !resolved
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return Err(AppError::bad_request(
            "Media tool paths must identify a local .exe file.",
        ));
    }
    let metadata = match tokio::fs::symlink_metadata(&resolved).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(AppError::bad_request("Media tool could not be inspected.")),
    };
    if !metadata.is_file() {
        return Err(AppError::bad_request(
            "Media tools must be local regular executable files.",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(AppError::bad_request(
                "Media tool file does not have executable permissions.",
            ));
        }
    }
    Ok(Some(resolved))
}

async fn resolve_with_search(
    configured: &Path,
    search: Vec<PathBuf>,
    current_directory: &Path,
) -> Result<Option<PathBuf>, AppError> {
    if configured.is_absolute() {
        #[cfg(windows)]
        let configured = if configured.extension().is_none() {
            configured.with_extension("exe")
        } else {
            configured.to_owned()
        };
        #[cfg(not(windows))]
        let configured = configured.to_owned();
        return executable_file(&configured).await;
    }
    let name = executable_name(configured).ok_or_else(|| {
        AppError::bad_request(
            "Media tools require a simple executable name or an absolute local file path.",
        )
    })?;
    let current_key = path_policy::path_key(current_directory);
    for directory in search {
        // Never canonicalize or stat a relative, network, device or CWD entry.
        if path_policy::validate_local_namespace(&directory).is_err()
            || path_policy::path_key(&directory) == current_key
        {
            continue;
        }
        let Ok(directory) = path_policy::validate_directory(&directory).await else {
            continue;
        };
        if path_policy::path_key(&directory) == current_key {
            continue;
        }
        // Reparse directories and executable aliases are rejected by the shared
        // admission policy. An invalid PATH candidate does not hide later ones.
        if let Ok(Some(path)) = executable_file(&directory.join(&name)).await {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// Resolve a simple executable name from absolute local PATH directories, or
/// inspect an explicitly configured absolute path. No process is launched here.
pub async fn resolve(configured: &Path) -> Result<Option<PathBuf>, AppError> {
    let search = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default();
    let directory = std::env::current_dir()?;
    resolve_with_search(configured, search, &directory).await
}

async fn configured_or_unavailable(
    configured: &Path,
    tool: &str,
    data_directory: &Path,
) -> Result<PathBuf, AppError> {
    if let Some(path) = resolve(configured).await? {
        return Ok(path);
    }
    tracing::warn!(
        tool,
        "Media tool is missing from the configured local paths"
    );
    // Keep the existing actionable degraded mode, but never leave a bare name
    // for Command::spawn to find later in CWD. The private directory is acquired
    // before prepare() and this randomly named path is deliberately not created.
    let name = format!("{}-{tool}", uuid::Uuid::new_v4().simple());
    let missing = data_directory.join(".unavailable-tools").join(name);
    #[cfg(windows)]
    let missing = missing.with_extension("exe");
    path_policy::validate_local_namespace(&missing)?;
    Ok(missing)
}

/// Call after DATA_DIR has been validated and made private, before constructing
/// services. Both stored paths are absolute, including when a tool is absent.
pub async fn prepare(config: &mut Config) -> Result<(), AppError> {
    config.ffmpeg_path =
        configured_or_unavailable(&config.ffmpeg_path, "FFmpeg", &config.data_dir).await?;
    config.ffprobe_path =
        configured_or_unavailable(&config.ffprobe_path, "FFprobe", &config.data_dir).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn tool_name() -> &'static str {
        if cfg!(windows) {
            "fixture.exe"
        } else {
            "fixture"
        }
    }

    async fn fixture(directory: &Path) -> PathBuf {
        let executable = directory.join(tool_name());
        tokio::fs::write(&executable, b"local test executable fixture")
            .await
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))
                .await
                .unwrap();
        }
        executable
    }

    #[tokio::test]
    async fn path_search_skips_current_relative_remote_and_invalid_entries() {
        let root = tempfile::tempdir().unwrap();
        let current = root.path().join("current");
        let trusted = root.path().join("trusted");
        tokio::fs::create_dir(&current).await.unwrap();
        tokio::fs::create_dir(&trusted).await.unwrap();
        fixture(&current).await;
        let expected = fixture(&trusted).await;
        let result = resolve_with_search(
            Path::new(tool_name()),
            vec![
                PathBuf::new(),
                PathBuf::from("relative"),
                PathBuf::from(r"\\example.invalid\tools"),
                PathBuf::from("//example.invalid/tools"),
                PathBuf::from(r"\\?\UNC\example.invalid\tools"),
                current.clone(),
                root.path().join("absent"),
                trusted,
            ],
            &current,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result, tokio::fs::canonicalize(expected).await.unwrap());
    }

    #[tokio::test]
    async fn explicit_paths_are_admitted_without_falling_back_to_search() {
        let root = tempfile::tempdir().unwrap();
        let expected = fixture(root.path()).await;
        assert!(resolve_with_search(
            Path::new("relative/fixture"),
            vec![root.path().to_owned()],
            root.path(),
        )
        .await
        .is_err());
        for forbidden in [
            r"\\example.invalid\tools\fixture.exe",
            r"\\.\GLOBALROOT\Device\fixture.exe",
            "file://example.invalid/tools/fixture",
        ] {
            assert!(
                resolve_with_search(Path::new(forbidden), vec![], root.path())
                    .await
                    .is_err()
            );
        }
        let resolved = resolve_with_search(&expected, vec![], root.path())
            .await
            .unwrap()
            .unwrap();
        assert!(resolved.is_absolute());
        assert!(resolve_with_search(
            &root.path().join(if cfg!(windows) {
                "missing.exe"
            } else {
                "missing"
            }),
            vec![root.path().to_owned()],
            root.path(),
        )
        .await
        .unwrap()
        .is_none());
    }

    #[tokio::test]
    async fn missing_bare_names_never_return_a_spawnable_relative_path() {
        let root = tempfile::tempdir().unwrap();
        let missing = configured_or_unavailable(
            Path::new("local-amp-absent-6645877931"),
            "FFmpeg",
            root.path(),
        )
        .await
        .unwrap();
        assert!(missing.is_absolute());
        assert!(!missing.exists());
        assert!(path_policy::is_within(&missing, root.path()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn executable_and_directory_symlinks_are_skipped() {
        let root = tempfile::tempdir().unwrap();
        let trusted = root.path().join("trusted");
        tokio::fs::create_dir(&trusted).await.unwrap();
        let expected = fixture(&trusted).await;
        let linked_directory = root.path().join("linked-directory");
        std::os::unix::fs::symlink(&trusted, &linked_directory).unwrap();
        let linked_file_directory = root.path().join("linked-file");
        tokio::fs::create_dir(&linked_file_directory).await.unwrap();
        std::os::unix::fs::symlink(&expected, linked_file_directory.join(tool_name())).unwrap();
        let resolved = resolve_with_search(
            Path::new(tool_name()),
            vec![linked_directory, linked_file_directory, trusted],
            root.path(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(resolved, tokio::fs::canonicalize(expected).await.unwrap());
    }
}
