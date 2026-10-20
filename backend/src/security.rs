//! Per-user launch credentials and narrowly scoped native media capabilities.
use crate::{config::Config, error::AppError, routes::AppState};
use axum::{extract::State, Json};
use fs2::FileExt;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use std::{
    fs::{File, OpenOptions},
    path::Path,
};

pub fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub async fn prepare_data_dir(config: &mut Config) -> anyhow::Result<File> {
    let path = if config.data_dir.is_absolute() {
        config.data_dir.clone()
    } else {
        std::env::current_dir()?.join(&config.data_dir)
    };
    if path.parent().is_none() || path.file_name().is_none() || path.join(".git").exists() {
        anyhow::bail!("DATA_DIR must be a dedicated Local Amp data directory.");
    }
    for variable in ["HOME", "USERPROFILE", "LOCALAPPDATA"] {
        if std::env::var_os(variable).is_some_and(|base| Path::new(&base) == path) {
            anyhow::bail!("DATA_DIR must be a dedicated subdirectory, not a user profile root.");
        }
    }
    crate::path_policy::validate_local_path(&path).await?;
    std::fs::create_dir_all(&path)?;
    config.data_dir = crate::path_policy::validate_directory(&path).await?;
    private_permissions(&config.data_dir, true)?;
    let lock_path = config.data_dir.join("server.lock");
    crate::path_policy::validate_local_path(&lock_path).await?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;
    private_permissions(&lock_path, false)?;
    lock.try_lock_exclusive().map_err(|_| {
        anyhow::anyhow!("This data directory is already in use by another Local Amp server.")
    })?;
    Ok(lock)
}

pub fn write_launch_file(config: &Config, token: &str) -> anyhow::Result<()> {
    let target = config.data_dir.join("launch.json");
    let temporary = tempfile::Builder::new()
        .prefix("launch-")
        .tempfile_in(&config.data_dir)?;
    private_permissions(temporary.path(), false)?;
    serde_json::to_writer(
        temporary.as_file(),
        &serde_json::json!({
            "app":"LocalAmp", "processId":std::process::id(), "port":config.port, "bootstrapToken":token
        }),
    )?;
    temporary.as_file().sync_all()?;
    temporary.persist(&target).map_err(|error| error.error)?;
    private_permissions(&target, false)?;
    let page = config.data_dir.join("launch.html");
    let temporary = tempfile::Builder::new()
        .prefix("launch-page-")
        .tempfile_in(&config.data_dir)?;
    private_permissions(temporary.path(), false)?;
    let mut output = temporary.as_file();
    use std::io::Write;
    write!(output,"<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\"><meta http-equiv=\"refresh\" content=\"0;url=http://127.0.0.1:{}/#local-amp={}\"><title>Open Local Amp</title></head><body style=\"background:#101014;color:white\">Opening Local Amp…</body></html>",config.port,token)?;
    output.sync_all()?;
    temporary.persist(&page).map_err(|error| error.error)?;
    private_permissions(&page, false)?;
    Ok(())
}

#[cfg(unix)]
fn private_permissions(path: &Path, directory: bool) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        path,
        std::fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
    )
}

#[cfg(windows)]
fn private_permissions(path: &Path, directory: bool) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
                SDDL_REVISION_1, SE_FILE_OBJECT,
            },
            GetSecurityDescriptorDacl, DACL_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION,
        },
    };
    let sddl = if directory {
        "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;OW)"
    } else {
        "D:P(A;;FA;;;SY)(A;;FA;;;OW)"
    };
    let descriptor_text: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: terminated UTF-16 buffers stay alive; Windows allocates descriptor.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            descriptor_text.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = std::ptr::null_mut();
    // SAFETY: descriptor is valid until LocalFree below; DACL references it.
    let extracted =
        unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) };
    let result = if extracted == 0 || present == 0 || dacl.is_null() {
        Err(std::io::Error::other(
            "Could not construct private credential permissions.",
        ))
    } else {
        // SAFETY: name and descriptor/DACL buffers remain valid for this call.
        let code = unsafe {
            SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                dacl,
                std::ptr::null(),
            )
        };
        if code == 0 {
            Ok(())
        } else {
            Err(std::io::Error::from_raw_os_error(code as i32))
        }
    };
    // SAFETY: allocated by ConvertStringSecurityDescriptor... using LocalAlloc.
    unsafe {
        LocalFree(descriptor);
    }
    result
}

pub fn token_matches(expected: &str, candidate: &str) -> bool {
    if expected.len() != candidate.len() {
        return false;
    }
    expected
        .bytes()
        .zip(candidate.bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

pub fn capability_route(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or("");
    path == "/metrics"
        || path == "/metrics/"
        || ["/api/artwork/", "/api/audio/", "/api/original/"]
            .iter()
            .any(|prefix| path.starts_with(prefix))
        || path.starts_with("/api/scan/") && path.ends_with("/stream")
        || path.starts_with("/api/playlists/") && path.ends_with("/m3u")
}

pub fn signed_url(token: &str, uri: &str) -> String {
    // HMAC accepts keys of any length, so construction cannot fail for this key.
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(token.as_bytes()) else {
        return String::new();
    };
    mac.update(b"local-amp-resource-v1\0");
    mac.update(uri.as_bytes());
    let signature = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "{uri}{}access={signature}",
        if uri.contains('?') { '&' } else { '?' }
    )
}

pub fn capability_matches(token: &str, uri: &str) -> bool {
    if !capability_route(uri) {
        return false;
    }
    let split = uri
        .rsplit_once("&access=")
        .or_else(|| uri.rsplit_once("?access="));
    let Some((unsigned, signature)) = split else {
        return false;
    };
    if signature.len() != 64
        || !signature.bytes().all(|c| c.is_ascii_hexdigit())
        || unsigned.contains("access=")
    {
        return false;
    }
    let expected = signed_url(token, unsigned);
    token_matches(&expected, uri)
}

pub async fn identity() -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"app":"LocalAmp","version":env!("CARGO_PKG_VERSION"),"processId":std::process::id()}),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessRequest {
    paths: Vec<String>,
}

pub async fn access(
    State(state): State<AppState>,
    crate::routes::json::ApiJson(payload): crate::routes::json::ApiJson<AccessRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    if payload.paths.len() > 20
        || payload.paths.iter().any(|uri| {
            uri.len() > 4096
                || !uri.starts_with('/')
                || uri.starts_with("//")
                || uri.contains(['\r', '\n', '#', '\\'])
                || uri.contains("access=")
                || !capability_route(uri)
        })
    {
        return Err(AppError::bad_request(
            "Only bounded local resource URLs may be authorized.",
        ));
    }
    Ok(Json(
        serde_json::json!({"urls":payload.paths.iter().map(|uri| signed_url(&state.session_token, uri)).collect::<Vec<_>>()}),
    ))
}

pub fn decorate_media(data: &mut serde_json::Value, token: &str) {
    fn track(value: &mut serde_json::Value, token: &str) {
        let Some(id) = value.get("id").and_then(serde_json::Value::as_str) else {
            return;
        };
        if value.get("hasArtwork").and_then(serde_json::Value::as_bool) != Some(true) {
            return;
        }
        let revision = value
            .get("metadataExtractedAt")
            .or_else(|| value.get("modifiedAt"))
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v.to_string())
            })
            .unwrap_or_else(|| "0".into());
        let uri = format!(
            "/api/artwork/{}?v={}",
            urlencoding::encode(id),
            urlencoding::encode(&revision)
        );
        value["artworkUrl"] = serde_json::Value::String(signed_url(token, &uri));
    }
    for field in ["tracks", "recentTracks"] {
        if let Some(values) = data
            .get_mut(field)
            .and_then(serde_json::Value::as_array_mut)
        {
            for value in values {
                track(value, token);
            }
        }
    }
    if let Some(groups) = data
        .get_mut("groups")
        .and_then(serde_json::Value::as_array_mut)
    {
        for group in groups {
            if let Some(value) = group.get_mut("artworkTrack") {
                track(value, token);
            }
        }
    }
    if let Some(value) = data.get_mut("track") {
        track(value, token);
    }
    if let Some(uri) = data
        .get("audioUrl")
        .and_then(serde_json::Value::as_str)
        .filter(|uri| capability_route(uri))
    {
        data["audioUrl"] = serde_json::Value::String(signed_url(token, uri));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resource_grant_does_not_authorize_other_files_or_apis() {
        let token = new_token();
        let uri = signed_url(&token, "/api/audio/song?format=flac&v=1");
        assert!(capability_matches(&token, &uri));
        assert!(!capability_matches(&new_token(), &uri));
        assert!(!capability_matches(&token, &uri.replace("song", "other")));
        assert!(!capability_matches(
            &token,
            &uri.replace("format=flac", "format=mp3")
        ));
        assert!(!capability_matches(
            &token,
            &signed_url(&token, "/api/backup")
        ));
        assert!(!capability_matches(&token, &format!("{uri}&x=1")));
    }
    #[test]
    fn launch_secret_is_not_empty_or_predictable_process_metadata() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(token_matches(&a, &a));
        assert!(!token_matches(&a, &b));
    }

    #[test]
    fn grouped_artwork_receives_the_same_scoped_access_as_track_pages() {
        let token = new_token();
        let mut data = serde_json::json!({"groups":[{"artworkTrack":{"id":"cover","hasArtwork":true,"metadataExtractedAt":"revision"}}]});
        decorate_media(&mut data, &token);
        let uri = data["groups"][0]["artworkTrack"]["artworkUrl"]
            .as_str()
            .unwrap_or_default();
        assert!(uri.starts_with("/api/artwork/cover?v=revision&access="));
        assert!(capability_matches(&token, uri));
        assert!(!uri.contains(&token));
    }
}
