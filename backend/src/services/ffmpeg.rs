use crate::{config::Config, db::Track, error::AppError};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex, Weak},
    time::Duration,
};
use tokio::{
    fs,
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::{Mutex, Notify, OwnedSemaphorePermit, RwLock, Semaphore},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct FfmpegService {
    config: Arc<Config>,
    processes: Arc<Semaphore>,
    transcodes: Arc<Semaphore>,
    streams: Arc<Semaphore>,
    locks: Arc<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>>,
    maintenance: Arc<RwLock<()>>,
    eviction: Arc<Mutex<()>>,
    shutdown: CancellationToken,
    health: Arc<Mutex<Option<(std::time::Instant, serde_json::Value)>>>,
    staging: Arc<StdMutex<HashMap<PathBuf, u64>>>,
    staging_changed: Arc<Notify>,
}

struct StagingReservation {
    path: PathBuf,
    staging: Arc<StdMutex<HashMap<PathBuf, u64>>>,
    changed: Arc<Notify>,
}

impl Drop for StagingReservation {
    fn drop(&mut self) {
        self.staging
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.path);
        self.changed.notify_waiters();
    }
}

struct CacheEntry {
    path: PathBuf,
    bytes: u64,
    modified: std::time::SystemTime,
    staging: bool,
}

fn output_limit_error() -> AppError {
    AppError::bad_request(
        "Converted media reached TRANSCODE_MAX_MB. Increase the limit or play the original.",
    )
}

fn insufficient_space_error() -> AppError {
    AppError::Http {
        status: axum::http::StatusCode::INSUFFICIENT_STORAGE,
        message: "Not enough cache or free disk space for this conversion. Clear the cache, free disk space, or play the original.".into(),
        detail: None,
    }
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
            streams: Arc::new(Semaphore::new(config.stream_concurrency.get())),
            config,
            locks: Arc::new(Mutex::new(HashMap::new())),
            maintenance: Arc::new(RwLock::new(())),
            eviction: Arc::new(Mutex::new(())),
            shutdown: CancellationToken::new(),
            health: Arc::new(Mutex::new(None)),
            staging: Arc::new(StdMutex::new(HashMap::new())),
            staging_changed: Arc::new(Notify::new()),
        }
    }
    pub fn shutdown(&self) {
        self.shutdown.cancel();
    }

    async fn prepare_cache_directory(&self) -> Result<(), AppError> {
        let root = self.config.data_dir.join("cache");
        crate::path_policy::validate_local_path(&root).await?;
        fs::create_dir_all(&root).await?;
        crate::path_policy::validate_local_path(&root).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).await?;
        }
        Ok(())
    }

    /// Called only after the server acquires the exclusive DATA_DIR lease.
    pub(crate) async fn initialize_cache(&self) -> Result<(), AppError> {
        self.prepare_cache_directory().await?;
        self.evict(None, false).await?;
        Ok(())
    }

    pub(crate) async fn stream_permit(&self) -> Result<OwnedSemaphorePermit, AppError> {
        tokio::select! {
            permit = self.streams.clone().acquire_owned() => permit.map_err(|_| AppError::bad_request("Media service stopped.")),
            _ = self.shutdown.cancelled() => Err(AppError::bad_request("Media service stopped.")),
        }
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
        self.run_monitored(command, tool, timeout, None).await
    }

    async fn run_monitored(
        &self,
        command: &mut Command,
        tool: &'static str,
        timeout: u64,
        output: Option<(&Path, u64)>,
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
        let result: Result<_, AppError> = tokio::select! {
            result = tokio::time::timeout(Duration::from_millis(timeout), async {
                tokio::try_join!(child.wait(), limited_read(stdout, 4 * 1024 * 1024), limited_read(stderr, 64 * 1024))
            }) => result.map_err(AppError::from).and_then(|result| result.map_err(AppError::from)),
            error = self.monitor_output(output) => Err(error),
            _ = self.shutdown.cancelled() => Err(AppError::bad_request("Media service stopped.")),
        };
        // Reap a rejected conversion before releasing its output reservation or
        // deleting the staging file, including on Windows where unlink is blocked.
        if result.is_err() {
            let _ = child.kill().await;
        }
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

    async fn monitor_output(&self, output: Option<(&Path, u64)>) -> AppError {
        let Some((path, limit)) = output else {
            return std::future::pending().await;
        };
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        loop {
            interval.tick().await;
            // Read through a handle: Windows directory metadata may retain an
            // old size while FFmpeg still has the output file open.
            let metadata = match crate::path_policy::open_local_file(path).await {
                Ok(file) => file.metadata().await.map_err(AppError::from),
                Err(error) => Err(error),
            };
            match metadata {
                Ok(meta) if meta.len() >= limit => return output_limit_error(),
                Err(error) => return error,
                _ => {}
            }
            match fs2::available_space(path.parent().unwrap_or(path)) {
                Ok(available) if available < self.config.cache_min_free_bytes => {
                    return insufficient_space_error();
                }
                Err(error) => return error.into(),
                _ => {}
            }
        }
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
        let path = crate::path_policy::validate_audio_path(path).await?;
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
        match crate::path_policy::open_local_file(path).await {
            Ok(file) => file.metadata().await.is_ok_and(|meta| meta.len() > 0),
            Err(_) => false,
        }
    }

    pub async fn ensure_decoded(&self, track: &Track, format: &str) -> Result<PathBuf, AppError> {
        let path = self.cache_path_for_track(track, format)?;
        crate::path_policy::validate_audio_path(Path::new(&track.path)).await?;
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
        let _transcode = tokio::select! {
            permit = self.transcodes.acquire() => permit.map_err(|_| AppError::bad_request("Media service stopped."))?,
            _ = self.shutdown.cancelled() => return Err(AppError::bad_request("Media service stopped.")),
        };
        let parent = path
            .parent()
            .ok_or_else(|| AppError::bad_request("Invalid cache directory."))?;
        self.prepare_cache_directory().await?;
        let output_limit = self
            .config
            .transcode_max_bytes
            .min(self.config.cache_max_bytes);
        let output_limit = if format == "jpg" {
            output_limit.min(16 * 1024 * 1024)
        } else {
            output_limit
        };
        let (temporary, _reservation) = self.reserve_output(parent, format, output_limit).await?;
        let source = crate::path_policy::validate_audio_path(Path::new(&track.path)).await?;
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
            .arg(Self::path_to_ffmpeg_input(&source.to_string_lossy()));
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
        // FFmpeg's native cap bounds writes between monitor ticks. A result
        // reaching the cap is rejected even when FFmpeg exits successfully.
        command
            .arg("-fs")
            .arg(output_limit.to_string())
            .arg(temporary.path());
        self.run_monitored(
            &mut command,
            "FFmpeg",
            if format == "jpg" {
                self.config.ffprobe_timeout_ms
            } else {
                self.config.ffmpeg_timeout_ms
            },
            Some((temporary.path(), output_limit)),
        )
        .await?;
        if !Self::is_usable_cache_file(temporary.path()).await {
            return Err(AppError::bad_request(
                "Media conversion produced an empty file.",
            ));
        }
        if fs::metadata(temporary.path()).await?.len() >= output_limit {
            return Err(output_limit_error());
        }
        crate::path_policy::validate_local_path(&path).await?;
        temporary.persist(&path).map_err(|e| e.error)?;
        drop(_reservation);
        self.evict(Some(&path), false).await?;
        metrics::counter!("media_cache_created_total").increment(1);
        Ok(path)
    }

    async fn reserve_output(
        &self,
        parent: &Path,
        format: &str,
        limit: u64,
    ) -> Result<(tempfile::NamedTempFile, StagingReservation), AppError> {
        let wait = async {
            loop {
                let notified = self.staging_changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if let Some(reservation) = self.try_reserve_output(parent, format, limit).await? {
                    return Ok(reservation);
                }
                tokio::select! {
                    _ = notified => {},
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {},
                    _ = self.shutdown.cancelled() => return Err(AppError::bad_request("Media service stopped.")),
                }
            }
        };
        tokio::time::timeout(Duration::from_millis(self.config.ffmpeg_timeout_ms), wait).await?
    }

    async fn try_reserve_output(
        &self,
        parent: &Path,
        format: &str,
        limit: u64,
    ) -> Result<Option<(tempfile::NamedTempFile, StagingReservation)>, AppError> {
        // Creation, registration, stale cleanup and eviction share this lock.
        // No eviction snapshot can miss a newly-created active staging path.
        let _eviction = self.eviction.lock().await;
        let reserved = self.reserved_output_bytes();
        if reserved.saturating_add(limit) > self.config.cache_max_bytes {
            return Ok(None);
        }
        let target = self.config.cache_max_bytes - reserved - limit;
        self.evict_locked(None, false, target).await?;
        let entries = self.cache_entries().await?;
        let finalized_bytes: u64 = entries
            .iter()
            .filter(|entry| !entry.staging)
            .map(|entry| entry.bytes)
            .sum();
        if finalized_bytes > target {
            // All remaining entries are protected by conversions or Windows
            // readers. Queue rather than failing ordinary concurrent playback.
            return Ok(None);
        }
        let active: HashSet<_> = self
            .staging
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect();
        let written_staging_bytes: u64 = entries
            .iter()
            .filter(|entry| entry.staging && active.contains(&entry.path))
            .map(|entry| entry.bytes)
            .sum();
        // Free space already excludes bytes written by running conversions;
        // reserve only their remaining capacity to avoid double-counting it.
        let remaining = reserved.saturating_sub(written_staging_bytes);
        let available = fs2::available_space(parent)?;
        if available
            < self
                .config
                .cache_min_free_bytes
                .saturating_add(remaining)
                .saturating_add(limit)
        {
            return Err(insufficient_space_error());
        }
        let temporary = tempfile::Builder::new()
            .prefix("amp-")
            .suffix(&format!(".{format}"))
            .tempfile_in(parent)?;
        let path = temporary.path().to_owned();
        self.staging
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(path.clone(), limit);
        Ok(Some((
            temporary,
            StagingReservation {
                path,
                staging: self.staging.clone(),
                changed: self.staging_changed.clone(),
            },
        )))
    }

    fn reserved_output_bytes(&self) -> u64 {
        self.staging
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .copied()
            .sum()
    }

    async fn cache_entries(&self) -> Result<Vec<CacheEntry>, AppError> {
        let root = self.config.data_dir.join("cache");
        crate::path_policy::validate_local_path(&root).await?;
        let mut directory = match fs::read_dir(root).await {
            Ok(directory) => directory,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut entries = Vec::new();
        while let Some(entry) = directory.next_entry().await? {
            let path = entry.path();
            if !matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("mp3" | "flac" | "jpg")
            ) {
                continue;
            }
            crate::path_policy::validate_local_path(&path).await?;
            let file = match crate::path_policy::open_local_file(&path).await {
                Ok(file) => file,
                Err(AppError::Http {
                    status: axum::http::StatusCode::NOT_FOUND,
                    ..
                }) => continue,
                Err(error) => return Err(error),
            };
            let meta = file.metadata().await?;
            if meta.is_file() {
                let staging = path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("amp-"));
                entries.push(CacheEntry {
                    path,
                    bytes: meta.len(),
                    modified: meta.modified().unwrap_or(std::time::UNIX_EPOCH),
                    staging,
                });
            }
        }
        Ok(entries)
    }

    async fn evict(&self, keep: Option<&Path>, all: bool) -> Result<(usize, u64), AppError> {
        let _eviction = self.eviction.lock().await;
        let target = self
            .config
            .cache_max_bytes
            .saturating_sub(self.reserved_output_bytes());
        self.evict_locked(keep, all, target).await
    }

    async fn evict_locked(
        &self,
        keep: Option<&Path>,
        all: bool,
        target: u64,
    ) -> Result<(usize, u64), AppError> {
        let reserved: HashSet<_> = self
            .locks
            .lock()
            .await
            .iter()
            .filter(|(_, lock)| lock.strong_count() > 0)
            .map(|(path, _)| path.clone())
            .collect();
        let active: HashSet<_> = self
            .staging
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect();
        let mut entries = self.cache_entries().await?;
        let mut finalized: u64 = entries
            .iter()
            .filter(|entry| !entry.staging)
            .map(|entry| entry.bytes)
            .sum();
        let mut total: u64 = entries.iter().map(|entry| entry.bytes).sum();
        entries.sort_by_key(|entry| entry.modified);
        let (mut removed, mut bytes) = (0, 0);
        for entry in entries {
            let CacheEntry {
                path,
                bytes: size,
                staging,
                ..
            } = entry;
            if active.contains(&path)
                || keep == Some(path.as_path())
                || (!all && reserved.contains(&path))
            {
                continue;
            }
            // main holds an exclusive DATA_DIR lock for this server's lifetime.
            // Unregistered staging files belong to interrupted conversions.
            if !all && !staging && finalized <= target {
                continue;
            }
            match fs::remove_file(&path).await {
                Ok(()) => {
                    total = total.saturating_sub(size);
                    if !staging {
                        finalized = finalized.saturating_sub(size);
                    }
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
        let entries = self.cache_entries().await?;
        let count = entries.len();
        let bytes = entries.iter().map(|entry| entry.bytes).sum::<u64>();
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
            max_scan_entries: one,
            max_scan_directories: one,
            max_scan_hash_bytes: 1073741824,
            max_scan_file_bytes: 268435456,
            fingerprint_timeout_ms: 10000,
            scan_timeout_ms: 60000,
            json_limit_bytes: 20971520,
            ffmpeg_path: "ffmpeg".into(),
            ffprobe_path: "ffprobe".into(),
            ffprobe_timeout_ms: 10000,
            ffmpeg_timeout_ms: 60000,
            data_dir: "fixture-data".into(),
            cache_max_bytes: 1073741824,
            transcode_max_bytes: 536870912,
            cache_min_free_bytes: 268435456,
            max_concurrent_requests: 512,
            max_connections: 512,
            request_read_timeout_ms: 10000,
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

    fn isolated_service(root: &Path, cache_bytes: u64, conversion_bytes: u64) -> FfmpegService {
        let mut config = service().config.as_ref().clone();
        config.data_dir = root.to_owned();
        config.cache_max_bytes = cache_bytes;
        config.transcode_max_bytes = conversion_bytes;
        config.cache_min_free_bytes = 0;
        FfmpegService::new(Arc::new(config))
    }

    #[tokio::test]
    async fn staging_is_counted_and_protected_while_aggregate_capacity_is_reserved() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().join("cache");
        fs::create_dir(&parent).await.unwrap();
        let service = isolated_service(directory.path(), 256, 128);
        fs::write(parent.join("old.flac"), [0_u8; 160])
            .await
            .unwrap();
        fs::write(parent.join("amp-abandoned.flac"), [0_u8; 32])
            .await
            .unwrap();
        let (mut first, first_reservation) = service
            .try_reserve_output(&parent, "flac", 128)
            .await
            .unwrap()
            .unwrap();
        first.as_file_mut().write_all(&[1_u8; 90]).unwrap();
        assert!(!parent.join("old.flac").exists());
        assert!(!parent.join("amp-abandoned.flac").exists());
        let (mut second, second_reservation) = service
            .try_reserve_output(&parent, "mp3", 128)
            .await
            .unwrap()
            .unwrap();
        second.as_file_mut().write_all(&[2_u8; 80]).unwrap();
        assert_eq!(service.cache_usage().await.unwrap(), (2, 170));
        assert_eq!(service.reserved_output_bytes(), 256);
        assert!(service
            .try_reserve_output(&parent, "flac", 128)
            .await
            .unwrap()
            .is_none());
        service.evict(None, true).await.unwrap();
        assert!(first.path().exists());
        assert!(second.path().exists());

        let waiting_service = service.clone();
        let waiting_parent = parent.clone();
        let mut waiting = tokio::spawn(async move {
            waiting_service
                .reserve_output(&waiting_parent, "flac", 128)
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut waiting)
                .await
                .is_err()
        );
        drop(first);
        drop(first_reservation);
        let (third, third_reservation) = tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(service.reserved_output_bytes(), 256);
        drop(second);
        drop(second_reservation);
        drop(third);
        drop(third_reservation);
        assert_eq!(service.reserved_output_bytes(), 0);
    }

    #[tokio::test]
    async fn output_monitor_rejects_an_exceeded_live_limit() {
        let directory = tempfile::tempdir().unwrap();
        let service = isolated_service(directory.path(), 256, 128);
        let output = directory.path().join("output.flac");
        fs::write(&output, [0_u8; 129]).await.unwrap();
        let error = tokio::time::timeout(
            Duration::from_secs(1),
            service.monitor_output(Some((&output, 128))),
        )
        .await
        .unwrap();
        assert!(error.to_string().contains("TRANSCODE_MAX_MB"));
    }

    #[tokio::test]
    async fn insufficient_free_space_is_rejected_before_creating_output() {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().join("cache");
        fs::create_dir(&parent).await.unwrap();
        let mut service = isolated_service(directory.path(), 256, 128);
        Arc::make_mut(&mut service.config).cache_min_free_bytes = u64::MAX;
        let error = match service.try_reserve_output(&parent, "flac", 128).await {
            Err(error) => error,
            Ok(_) => panic!("Expected disk floor rejection"),
        };
        assert!(error.to_string().contains("free disk space"));
        assert_eq!(service.reserved_output_bytes(), 0);
        assert_eq!(service.cache_usage().await.unwrap(), (0, 0));
    }

    #[tokio::test]
    async fn ffmpeg_cap_never_persists_a_truncated_successful_conversion() {
        let directory = tempfile::tempdir().unwrap();
        let mut service = isolated_service(directory.path(), 8192, 4096);
        if let Some(path) = std::env::var_os("FFMPEG_PATH") {
            Arc::make_mut(&mut service.config).ffmpeg_path = path.into();
        }
        // External FFmpeg is optional; environments with it installed exercise
        // its actual output-cap behavior as well as the monitor unit test above.
        match Command::new(&service.config.ffmpeg_path)
            .arg("-version")
            .output()
            .await
        {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => panic!("Could not run installed FFmpeg: {error}"),
            Ok(output) => assert!(output.status.success()),
        }
        let source = directory.path().join("source.wav");
        let data_bytes = 160000_u32;
        let mut wave = Vec::new();
        wave.extend_from_slice(b"RIFF");
        wave.extend_from_slice(&(data_bytes + 36).to_le_bytes());
        wave.extend_from_slice(b"WAVEfmt ");
        wave.extend_from_slice(&16_u32.to_le_bytes());
        wave.extend_from_slice(&1_u16.to_le_bytes());
        wave.extend_from_slice(&1_u16.to_le_bytes());
        wave.extend_from_slice(&8000_u32.to_le_bytes());
        wave.extend_from_slice(&16000_u32.to_le_bytes());
        wave.extend_from_slice(&2_u16.to_le_bytes());
        wave.extend_from_slice(&16_u16.to_le_bytes());
        wave.extend_from_slice(b"data");
        wave.extend_from_slice(&data_bytes.to_le_bytes());
        let mut random = 1_u32;
        for _ in 0..(data_bytes / 2) {
            random = random.wrapping_mul(1664525).wrapping_add(1013904223);
            wave.extend_from_slice(&(random >> 16).to_le_bytes()[..2]);
        }
        fs::write(&source, wave).await.unwrap();
        let track: Track = serde_json::from_value(serde_json::json!({
            "id":"bounded-fixture", "path":source.to_string_lossy(), "duration":10,
            "bitRate":128000, "size":data_bytes + 44, "modifiedAt":1,
            "hasArtwork":false, "tags":{}
        }))
        .unwrap();
        let error = service.ensure_decoded(&track, "flac").await.unwrap_err();
        assert!(error.to_string().contains("TRANSCODE_MAX_MB"));
        assert!(!service
            .cache_path_for_track(&track, "flac")
            .unwrap()
            .exists());
        assert_eq!(service.cache_usage().await.unwrap(), (0, 0));
        assert_eq!(service.reserved_output_bytes(), 0);
    }
}
