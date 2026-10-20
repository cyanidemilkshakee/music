//! Local filesystem admission shared by import, scan and playback.
//! Namespace checks must run before any operation which could contact a share.
use crate::error::AppError;
use std::path::{Component, Path, PathBuf};
use tokio::{fs, io::AsyncReadExt};

pub fn validate_local_namespace(path: &Path) -> Result<(), AppError> {
    let text = path
        .to_str()
        .ok_or_else(|| AppError::bad_request("Paths must be valid Unicode."))?;
    if text.is_empty() || text.len() > 32768 || text.chars().any(char::is_control) {
        return Err(AppError::bad_request("Invalid local path."));
    }
    // canonicalize() produces this prefix for ordinary local Windows drives.
    // All other verbatim/device namespaces, UNC and file: URLs are forbidden.
    let plain = text.strip_prefix("\\\\?\\").unwrap_or(text);
    if plain.starts_with(['\\', '/']) && (plain.starts_with("\\\\") || plain.starts_with("//"))
        || text.starts_with("\\??\\")
        || text.starts_with("\\\\.\\")
        || text.to_ascii_lowercase().starts_with("file:")
        || text.contains("://")
        || text.starts_with("\\\\?\\")
            && !(plain.as_bytes().get(1) == Some(&b':')
                && plain
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphabetic)
                && plain.as_bytes().get(2) == Some(&b'\\'))
        || !path.is_absolute()
        || path.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err(AppError::bad_request(
            "Only absolute local paths are allowed; network and device paths are blocked.",
        ));
    }
    #[cfg(windows)]
    {
        let bytes = plain.as_bytes();
        if bytes.get(1) != Some(&b':')
            || !bytes.first().is_some_and(u8::is_ascii_alphabetic)
            || plain[2..].contains(':')
        {
            return Err(AppError::bad_request(
                "Drive paths without alternate data streams are required.",
            ));
        }
        for part in plain[2..].split(['\\', '/']).filter(|s| !s.is_empty()) {
            let base = part
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            if part.ends_with([' ', '.'])
                || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"]
                    .contains(&base.as_str())
                || ["COM", "LPT"].iter().any(|prefix| {
                    base.strip_prefix(prefix)
                        .is_some_and(|number| matches!(number, "¹" | "²" | "³"))
                })
                || base.len() == 4
                    && (base.starts_with("COM") || base.starts_with("LPT"))
                    && matches!(base.as_bytes()[3], b'1'..=b'9')
            {
                return Err(AppError::bad_request(
                    "Ambiguous or device path components are blocked.",
                ));
            }
        }
        // This query examines the drive mapping, before inspecting any file.
        // A mapped network drive is just as remote as UNC.
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetDriveTypeW(root: *const u16) -> u32;
        }
        let drive: Vec<u16> = format!("{}:\\", bytes[0] as char)
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let kind = unsafe { GetDriveTypeW(drive.as_ptr()) };
        if !matches!(kind, 2 | 3 | 6) {
            return Err(AppError::bad_request(
                "Only local disk drives are supported.",
            ));
        }
    }
    Ok(())
}

fn redirects(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

/// Validate existing ancestors, without following a symlink or reparse point.
/// Missing suffixes are permitted for unavailable backup entries or new cache files.
pub async fn validate_local_path(path: &Path) -> Result<PathBuf, AppError> {
    validate_local_namespace(path)?;
    let mut checked = PathBuf::new();
    let mut missing = false;
    for component in path.components() {
        if matches!(component, Component::CurDir) {
            continue;
        }
        checked.push(component.as_os_str());
        if matches!(component, Component::Prefix(_)) || missing {
            continue;
        }
        match fs::symlink_metadata(&checked).await {
            Ok(meta) if redirects(&meta) => {
                return Err(AppError::bad_request(
                    "Symbolic links and filesystem reparse points are blocked.",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => missing = true,
            Err(_) => return Err(AppError::bad_request("Local path could not be inspected.")),
        }
    }
    if !missing {
        let canonical = fs::canonicalize(&checked)
            .await
            .map_err(|_| AppError::bad_request("Local path could not be resolved."))?;
        validate_local_namespace(&canonical)?;
        // Inspect the result again in case resolution changed the path.
        if redirects(&fs::symlink_metadata(&canonical).await?) {
            return Err(AppError::bad_request("Filesystem redirects are blocked."));
        }
        Ok(canonical)
    } else {
        Ok(checked)
    }
}

pub async fn validate_directory(path: &Path) -> Result<PathBuf, AppError> {
    let path = validate_local_path(path).await?;
    if !fs::symlink_metadata(&path)
        .await
        .is_ok_and(|meta| meta.is_dir() && !redirects(&meta))
    {
        return Err(AppError::bad_request(
            "Music folder must be an existing local directory.",
        ));
    }
    Ok(path)
}

pub fn is_audio_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|extension| {
            [
                "aac", "aif", "aiff", "alac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma",
            ]
            .contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn audio_header(header: &[u8]) -> bool {
    header.starts_with(b"fLaC")
        || header.starts_with(b"OggS")
        || header.starts_with(b"ID3")
        || header.starts_with(b"ADIF")
        || header.starts_with(&[
            0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62,
            0xce, 0x6c,
        ])
        || header.len() >= 12
            && (matches!(&header[..4], b"RIFF" | b"RIFX" | b"RF64" | b"BW64")
                && &header[8..12] == b"WAVE"
                || header.starts_with(b"FORM") && matches!(&header[8..12], b"AIFF" | b"AIFC")
                || &header[4..8] == b"ftyp")
        || header.len() >= 2 && header[0] == 0xff && header[1] & 0xe0 == 0xe0
}

/// Read a validated local regular file without following a final link inserted
/// between inspection and open. Ancestor validation still runs immediately
/// before the open; mutation of those directories requires local write access.
pub async fn open_local_file(path: &Path) -> Result<fs::File, AppError> {
    let path = validate_local_path(path).await?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let file = options
        .open(&path)
        .await
        .map_err(|_| AppError::not_found("Local file is unavailable."))?;
    let meta = file.metadata().await?;
    if !meta.is_file() || redirects(&meta) {
        return Err(AppError::bad_request(
            "Only local regular files may be opened.",
        ));
    }
    Ok(file)
}

pub async fn validate_audio_path(path: &Path) -> Result<PathBuf, AppError> {
    if !is_audio_extension(path) {
        return Err(AppError::bad_request(
            "Only supported audio files are allowed.",
        ));
    }
    let path = validate_local_path(path).await?;
    let mut file = open_local_file(&path).await?;
    let meta = file.metadata().await?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(AppError::bad_request(
            "Audio must be a nonempty regular file.",
        ));
    }
    let mut header = [0; 64];
    let bytes = file.read(&mut header).await?;
    if !audio_header(&header[..bytes]) {
        return Err(AppError::bad_request(
            "File does not contain a supported audio format.",
        ));
    }
    Ok(path)
}

pub fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    {
        text.strip_prefix("\\\\?\\")
            .unwrap_or(&text)
            .replace('/', "\\")
            .to_lowercase()
    }
    #[cfg(not(windows))]
    {
        text.into_owned()
    }
}

pub fn is_within(path: &Path, root: &Path) -> bool {
    let path = path_key(path);
    let root = path_key(root);
    let separator = if cfg!(windows) { '\\' } else { '/' };
    path == root || path.starts_with(&format!("{}{separator}", root.trim_end_matches(separator)))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn forbidden_namespaces_are_rejected_lexically() {
        for path in [
            r"\\example.invalid\music\track.wav",
            r"\\?\UNC\example.invalid\music",
            r"\\.\GLOBALROOT\Device\HarddiskVolume1\track.wav",
            "//example.invalid/music",
            "file://example.invalid/music",
            "https://example.invalid/music",
            "relative.wav",
        ] {
            assert!(validate_local_namespace(Path::new(path)).is_err(), "{path}");
        }
        #[cfg(windows)]
        for path in [
            r"C:\music\track.wav:secret",
            r"C:\music\NUL.wav",
            r"C:\music\..\track.wav",
        ] {
            assert!(validate_local_namespace(Path::new(path)).is_err(), "{path}");
        }
    }

    #[test]
    fn containment_checks_component_boundaries_and_windows_canonical_aliases() {
        let root = if cfg!(windows) {
            Path::new(r"C:\music")
        } else {
            Path::new("/music")
        };
        let inside = if cfg!(windows) {
            Path::new(r"C:\music\song.wav")
        } else {
            Path::new("/music/song.wav")
        };
        let outside = if cfg!(windows) {
            Path::new(r"C:\music-private\song.wav")
        } else {
            Path::new("/music-private/song.wav")
        };
        assert!(is_within(inside, root));
        assert!(!is_within(outside, root));
        #[cfg(windows)]
        assert!(is_within(Path::new(r"\\?\c:\MUSIC\song.wav"), root));
    }

    #[tokio::test]
    async fn audio_admission_rejects_nonaudio_and_component_redirects() {
        let root = tempfile::tempdir().unwrap();
        let fake = root.path().join("fake.wav");
        fs::write(&fake, b"private text, not an audio file")
            .await
            .unwrap();
        assert!(validate_audio_path(&fake).await.is_err());
        let other = root.path().join("not-audio.txt");
        fs::write(&other, b"RIFFxxxxWAVE").await.unwrap();
        assert!(validate_audio_path(&other).await.is_err());
        #[cfg(unix)]
        {
            let redirect = root.path().join("redirect");
            std::os::unix::fs::symlink(root.path(), &redirect).unwrap();
            assert!(validate_local_path(&redirect.join("fake.wav"))
                .await
                .is_err());
        }
    }
}
