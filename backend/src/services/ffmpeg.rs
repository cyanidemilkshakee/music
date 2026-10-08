use crate::{config::Config, db::Track, error::AppError};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::{
    fs,
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::{Mutex, RwLock, Semaphore},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct FfmpegService {
    config: Arc<Config>,
    processes: Arc<Semaphore>,
    transcodes: Arc<Semaphore>,
    locks: Arc<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>>,
    maintenance: Arc<RwLock<()>>,
    eviction: Arc<Mutex<()>>,
    shutdown: CancellationToken,
    health: Arc<Mutex<Option<(std::time::Instant, serde_json::Value)>>>,
}

async fn limited_read(mut input: impl AsyncRead + Unpin, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let count = input.read(&mut chunk).await?;
        if count == 0 {
            return Ok(bytes);
        }
        if bytes.len() + count > limit {
            return Err(std::io::Error::other(
                "Media tool output exceeded its safety limit.",
            ));
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
}
struct ActiveProcess;
impl Drop for ActiveProcess {
    fn drop(&mut self) {
        metrics::gauge!("media_active_processes").decrement(1.0);
    }
}

impl FfmpegService {
    pub fn new(config: Arc<Config>) -> Self {
        Self {
            processes: Arc::new(Semaphore::new(config.stream_concurrency.get())),
            transcodes: Arc::new(Semaphore::new(config.transcode_concurrency.get())),
            config,
            locks: Arc::new(Mutex::new(HashMap::new())),
            maintenance: Arc::new(RwLock::new(())),
            eviction: Arc::new(Mutex::new(())),
            shutdown: CancellationToken::new(),
            health: Arc::new(Mutex::new(None)),
        }
    }
    pub fn shutdown(&self) {
        self.shutdown.cancel();
    }

    pub fn path_to_ffmpeg_input(path: &str) -> String {
        let path = path
            .strip_prefix(r"\\?\UNC\")
            .map(|s| format!(r"\\{s}"))
            .unwrap_or_else(|| path.strip_prefix(r"\\?\").unwrap_or(path).to_owned());
        format!("file:{path}")
    }

    pub(crate) async fn run(
        &self,
        command: &mut Command,
        tool: &'static str,
        timeout: u64,
    ) -> Result<Vec<u8>, AppError> {
        let _permit = tokio::select! {
            permit = self.processes.acquire() => permit.map_err(|_| AppError::bad_request("Media service stopped."))?,
            _ = self.shutdown.cancelled() => return Err(AppError::bad_request("Media service stopped.")),
        };
        metrics::gauge!("media_active_processes").increment(1.0);
        let _active = ActiveProcess;
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::MediaUnavailable { tool }
            } else {
                e.into()
            }
        })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::bad_request("Missing media tool output."))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::bad_request("Missing media tool diagnostics."))?;
        let result = tokio::select! {
            result = tokio::time::timeout(Duration::from_millis(timeout), async {
                tokio::try_join!(child.wait(), limited_read(stdout, 4 * 1024 * 1024), limited_read(stderr, 64 * 1024))
            }) => result?,
            _ = self.shutdown.cancelled() => return Err(AppError::bad_request("Media service stopped.")),
        };
        let (status, stdout, stderr) = result?;
        if !status.success() {
            return Err(AppError::Media {
                message: format!("{tool} failed"),
                exit_code: status.code(),
                stderr: String::from_utf8_lossy(&stderr).into(),
            });
        }
        Ok(stdout)
    }

    pub async fn tool_health(&self) -> serde_json::Value {
        let mut cache = self.health.lock().await;
        if let Some((checked, health)) = &*cache {
            if checked.elapsed() < Duration::from_secs(30) {
                return health.clone();
            }
        }
        let check = |path: PathBuf, tool| async move {
            let result = self
                .run(
                    Command::new(path).arg("-version"),
                    tool,
                    self.config.ffprobe_timeout_ms,
                )
                .await;
            match result {
                Ok(bytes) => {
                    serde_json::json!({"ok":true,"version":String::from_utf8_lossy(&bytes).lines().next().unwrap_or("")})
                }
                Err(error) => serde_json::json!({"ok":false,"error":error.to_string()}),
            }
        };
        let (ffmpeg, ffprobe) = tokio::join!(
            check(self.config.ffmpeg_path.clone(), "FFmpeg"),
            check(self.config.ffprobe_path.clone(), "FFprobe")
        );
        let value = serde_json::json!({"ffmpeg":ffmpeg,"ffprobe":ffprobe});
        *cache = Some((std::time::Instant::now(), value.clone()));
        value
    }

    pub async fn probe_track_metadata(&self, path: &Path) -> Result<serde_json::Value, AppError> {
        let bytes = self
            .run(
                Command::new(&self.config.ffprobe_path)
                    .args([
                        "-v",
                        "error",
                        "-protocol_whitelist",
                        "file,pipe",
                        "-show_format",
                        "-show_streams",
                        "-print_format",
                        "json",
                    ])
                    .arg(Self::path_to_ffmpeg_input(&path.to_string_lossy())),
                "FFprobe",
                self.config.ffprobe_timeout_ms,
            )
            .await?;
        let value: serde_json::Value = serde_json::from_slice(&bytes)?;
        if !value["streams"]
            .as_array()
            .is_some_and(|streams| streams.iter().any(|s| s["codec_type"] == "audio"))
        {
            return Err(AppError::bad_request("File contains no audio stream."));
        }
        Ok(value)
    }

    pub fn cache_path_for_track(&self, track: &Track, format: &str) -> Result<PathBuf, AppError> {
        if !matches!(format, "flac" | "mp3" | "jpg") {
            return Err(AppError::bad_request("Unsupported cache format."));
        }
        let mut hash = sha1_smol::Sha1::new();
        hash.update(
            format!(
                "v2|{}|{}|{}|{}",
                track.id,
                track.path,
                track.modified_at.unwrap_or(0),
                track.size.unwrap_or(0)
            )
            .as_bytes(),
        );
        if format == "jpg" {
            // An explicit metadata refresh also refreshes artwork when the
            // source file keeps the same timestamp and size. Audio remains
            // reusable because metadata extraction does not change its data.
            hash.update(b"|metadataExtractedAt|");
            hash.update(
                track
                    .metadata_extracted_at
                    .as_deref()
                    .unwrap_or("")
                    .as_bytes(),
            );
        }
        Ok(self
            .config
            .data_dir
            .join("cache")
            .join(format!("{}.{}", hash.digest(), format)))
    }

    pub async fn is_usable_cache_file(path: &Path) -> bool {
        fs::metadata(path)
            .await
            .is_ok_and(|m| m.is_file() && m.len() > 0)
    }

    pub async fn ensure_decoded(&self, track: &Track, format: &str) -> Result<PathBuf, AppError> {
        let path = self.cache_path_for_track(track, format)?;
        let _maintenance = self.maintenance.read().await;
        let lock = {
            let mut locks = self.locks.lock().await;
            locks.retain(|_, lock| lock.strong_count() > 0);
            let lock = locks
                .get(&path)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| Arc::new(Mutex::new(())));
            locks.insert(path.clone(), Arc::downgrade(&lock));
            lock
        };
        let _lock = lock.lock().await;
        if Self::is_usable_cache_file(&path).await {
            if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&path) {
                let _ = file.set_modified(std::time::SystemTime::now());
            }
            return Ok(path);
        }
        let _transcode = self
            .transcodes
            .acquire()
            .await
            .map_err(|_| AppError::bad_request("Media service stopped."))?;
        let parent = path
            .parent()
            .ok_or_else(|| AppError::bad_request("Invalid cache directory."))?;
        fs::create_dir_all(parent).await?;
        let temporary = tempfile::Builder::new()
            .prefix("amp-")
            .suffix(&format!(".{format}"))
            .tempfile_in(parent)?;
        let mut command = Command::new(&self.config.ffmpeg_path);
        command
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
            ])
            .arg(Self::path_to_ffmpeg_input(&track.path));
        if format == "jpg" {
            command.args([
                "-an",
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                "-vf",
                "scale=512:512:force_original_aspect_ratio=decrease",
                "-codec:v",
                "mjpeg",
                "-q:v",
                "3",
                "-f",
                "image2",
            ]);
        } else {
            command.args(["-map", "0:a:0", "-vn", "-map_metadata", "0"]);
            if format == "flac" {
                command.args(["-codec:a", "flac", "-compression_level", "5", "-f", "flac"]);
            } else {
                command.args(["-codec:a", "libmp3lame", "-q:a", "2", "-f", "mp3"]);
            }
        }
        command.arg(temporary.path());
        self.run(
            &mut command,
            "FFmpeg",
            if format == "jpg" {
                self.config.ffprobe_timeout_ms
            } else {
                self.config.ffmpeg_timeout_ms
            },
        )
        .await?;
        if !Self::is_usable_cache_file(temporary.path()).await {
            return Err(AppError::bad_request(
                "Media conversion produced an empty file.",
            ));
        }
        if fs::metadata(temporary.path()).await?.len() > self.config.cache_max_bytes {
            return Err(AppError::bad_request(
                "Converted track exceeds CACHE_MAX_MB. Increase the limit or play the original.",
            ));
        }
        temporary.persist(&path).map_err(|e| e.error)?;
        self.evict(Some(&path), false).await?;
        metrics::counter!("media_cache_created_total").increment(1);
        Ok(path)
    }

    async fn evict(&self, keep: Option<&Path>, all: bool) -> Result<(usize, u64), AppError> {
        let _eviction = self.eviction.lock().await;
        let reserved: std::collections::HashSet<_> = self
            .locks
            .lock()
            .await
            .iter()
            .filter(|(_, lock)| lock.strong_count() > 0)
            .map(|(path, _)| path.clone())
            .collect();
        let root = self.config.data_dir.join("cache");
        let mut directory = match fs::read_dir(root).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
            Err(e) => return Err(e.into()),
        };
        let mut entries = Vec::new();
        let mut total: u64 = 0;
        while let Some(entry) = directory.next_entry().await? {
            let meta = match entry.metadata().await {
                Ok(meta) => meta,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if meta.is_file()
                && matches!(
                    entry.path().extension().and_then(|s| s.to_str()),
                    Some("mp3" | "flac" | "jpg")
                )
            {
                total += meta.len();
                entries.push((
                    meta.modified().unwrap_or(std::time::UNIX_EPOCH),
                    entry.path(),
                    meta.len(),
                ));
            }
        }
        entries.sort_by_key(|entry| entry.0);
        let (mut removed, mut bytes) = (0, 0);
        for (_, path, size) in entries {
            if !all && total <= self.config.cache_max_bytes {
                break;
            }
            if keep == Some(path.as_path()) || (!all && reserved.contains(&path)) {
                continue;
            }
            match fs::remove_file(path).await {
                Ok(()) => {
                    total = total.saturating_sub(size);
                    removed += 1;
                    bytes += size;
                }
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    tracing::debug!(%e,"Cache file in use; retry eviction later");
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        metrics::gauge!("media_cache_bytes").set(total as f64);
        Ok((removed, bytes))
    }

    pub async fn cache_usage(&self) -> Result<(usize, u64), AppError> {
        let mut entries = match fs::read_dir(self.config.data_dir.join("cache")).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
            Err(error) => return Err(error.into()),
        };
        let (mut count, mut bytes) = (0, 0);
        while let Some(entry) = entries.next_entry().await? {
            if entry
                .path()
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("amp-"))
            {
                continue;
            }
            if let Ok(meta) = entry.metadata().await {
                if meta.is_file() {
                    count += 1;
                    bytes += meta.len();
                }
            }
        }
        metrics::gauge!("media_cache_bytes").set(bytes as f64);
        Ok((count, bytes))
    }

    pub async fn clear_audio_cache(&self) -> Result<(usize, u64), AppError> {
        let _maintenance = self.maintenance.write().await;
        self.evict(None, true).await
    }
}

#[cfg(test)]
mod cache_tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;
    use std::{
        net::{IpAddr, Ipv4Addr},
        num::NonZeroUsize,
    };

    fn service() -> FfmpegService {
        let one = NonZeroUsize::new(1).unwrap();
        FfmpegService::new(Arc::new(Config {
            port: 3000,
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            scan_concurrency: one,
            transcode_concurrency: one,
            stream_concurrency: one,
            max_scan_files: one,
            max_scan_failures: one,
            json_limit_bytes: 20971520,
            ffmpeg_path: "ffmpeg".into(),
            ffprobe_path: "ffprobe".into(),
            ffprobe_timeout_ms: 10000,
            ffmpeg_timeout_ms: 60000,
            data_dir: "fixture-data".into(),
            cache_max_bytes: 1073741824,
            max_concurrent_requests: 512,
        }))
    }

    #[test]
    fn metadata_refresh_invalidates_artwork_but_reuses_audio_conversions() {
        let service = service();
        let original: Track = serde_json::from_value(serde_json::json!({
            "id":"track","path":"C:/Music/track.flac","duration":180,
            "bitRate":0,"size":4096,"modifiedAt":1000,"hasArtwork":true,
            "metadataExtractedAt":"2026-10-03T00:00:00Z","tags":{}
        }))
        .unwrap();
        let mut refreshed = original.clone();
        refreshed.metadata_extracted_at = Some("2026-10-03T01:00:00Z".into());
        assert_ne!(
            service.cache_path_for_track(&original, "jpg").unwrap(),
            service.cache_path_for_track(&refreshed, "jpg").unwrap()
        );
        for format in ["flac", "mp3"] {
            assert_eq!(
                service.cache_path_for_track(&original, format).unwrap(),
                service.cache_path_for_track(&refreshed, format).unwrap()
            );
        }
        // Actual source changes still invalidate every media representation.
        for format in ["jpg", "flac", "mp3"] {
            let mut modified = original.clone();
            modified.modified_at = Some(1001);
            assert_ne!(
                service.cache_path_for_track(&original, format).unwrap(),
                service.cache_path_for_track(&modified, format).unwrap()
            );
            modified = original.clone();
            modified.size = Some(4097);
            assert_ne!(
                service.cache_path_for_track(&original, format).unwrap(),
                service.cache_path_for_track(&modified, format).unwrap()
            );
        }
    }
}
