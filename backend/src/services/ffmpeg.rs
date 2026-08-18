use crate::config::Config;
use crate::db::Track;
use crate::error::AppError;
use anyhow::{anyhow, Context};
use futures_util::TryStreamExt;
use sha1_smol::Sha1;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tempfile::NamedTempFile;
use tokio::fs;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::time::{timeout, Duration};
use tracing::{error, warn};

pub static FFMPEG_AVAILABLE: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
pub struct FfmpegService {
    config: Arc<Config>,
    transcode_semaphore: Arc<Semaphore>,
}

impl FfmpegService {
    pub fn new(config: Arc<Config>) -> Self {
        Self {
            transcode_semaphore: Arc::new(Semaphore::new(config.transcode_concurrency.get())),
            config,
        }
    }

    pub fn cache_path_for_track(&self, track: &Track) -> Result<PathBuf, AppError> {
        let modified_at = track.modified_at.unwrap_or(0);
        let size = track.size.unwrap_or(0);
        let basis = format!("{}|{}|{}", track.path, modified_at, size);
        
        let mut hasher = Sha1::new();
        hasher.update(basis.as_bytes());
        let hash = hasher.digest().to_string();

        let safe_id: String = track.id.chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == ':' { c } else { '_' })
            .take(120)
            .collect();

        let file_name = format!("{}-{}.mp3", safe_id, &hash[0..16]);
        let cache_path = self.config.data_dir.join("cache").join(file_name);
        
        // Path traversal guard
        let cache_dir = self.config.data_dir.join("cache");
        let cache_dir_abs = std::fs::canonicalize(&cache_dir).unwrap_or(cache_dir);
        // We can't canonicalize cache_path because it might not exist yet, 
        // but joining file_name onto cache_dir is safe since file_name contains no slashes.
        
        Ok(cache_path)
    }

    pub async fn is_usable_cache_file(path: &Path) -> bool {
        match fs::metadata(path).await {
            Ok(meta) => meta.is_file() && meta.len() > 0,
            Err(_) => false,
        }
    }

    pub async fn probe_track_metadata(&self, file_path: &Path) -> Result<serde_json::Value, AppError> {
        let start = std::time::Instant::now();
        let mut retry = false;
        loop {
            let output_res = timeout(
                Duration::from_millis(self.config.ffprobe_timeout_ms),
                Command::new(&self.config.ffprobe_path)
                    .args([
                        "-v", "error", 
                        "-print_format", "json", 
                        "-show_format", 
                        "-show_streams", 
                    ])
                    .arg(file_path)
                    .kill_on_drop(true)
                    .output()
            ).await;

            match output_res {
                Ok(Ok(output)) => {
                    metrics::histogram!("ffmpeg_probe_duration_seconds").record(start.elapsed().as_secs_f64());
                    if output.status.success() {
                        metrics::counter!("ffmpeg_probe_success_total").increment(1);
                        let json = serde_json::from_slice(&output.stdout)?;
                        return Ok(json);
                    } else {
                        metrics::counter!("ffmpeg_probe_error_total").increment(1);
                        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                        return Err(AppError::Media {
                            message: format!("ffprobe exited with {}", output.status),
                            exit_code: output.status.code(),
                            stderr,
                        });
                    }
                }
                Ok(Err(e)) => {
                    if e.kind() == std::io::ErrorKind::NotFound && !retry {
                        // Windows NTFS transient issue workaround
                        retry = true;
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        continue;
                    }
                    return Err(AppError::Io(e));
                }
                Err(e) => {
                    return Err(AppError::Timeout(e));
                }
            }
        }
    }

    pub async fn ensure_decoded(&self, track: &Track) -> Result<PathBuf, AppError> {
        let output_path = self.cache_path_for_track(track)?;
        
        // Double checked locking
        if Self::is_usable_cache_file(&output_path).await {
            metrics::counter!("ffmpeg_decode_cache_hits_total").increment(1);
            return Ok(output_path);
        }

        let _permit = self.transcode_semaphore.acquire().await.unwrap();
        
        if Self::is_usable_cache_file(&output_path).await {
            metrics::counter!("ffmpeg_decode_cache_hits_total").increment(1);
            return Ok(output_path);
        }
        
        metrics::counter!("ffmpeg_decode_cache_misses_total").increment(1);
        let start = std::time::Instant::now();

        let temp_dir = self.config.data_dir.join("cache");
        fs::create_dir_all(&temp_dir).await?;
        
        // Use tempfile in same dir to guarantee atomic rename
        let mut temp_file = NamedTempFile::new_in(&temp_dir)?;
        let temp_path = temp_file.path().to_path_buf();

        let output_res = timeout(
            Duration::from_millis(self.config.ffmpeg_timeout_ms),
            Command::new(&self.config.ffmpeg_path)
                .args([
                    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", 
                    "-i"
                ])
                .arg(&track.path)
                .args([
                    "-vn", "-map_metadata", "0", "-codec:a", "libmp3lame", "-q:a", "2"
                ])
                .arg(&temp_path)
                .kill_on_drop(true)
                .output()
        ).await;

        match output_res {
            Ok(Ok(output)) => {
                metrics::histogram!("ffmpeg_decode_duration_seconds").record(start.elapsed().as_secs_f64());
                if !output.status.success() {
                    metrics::counter!("ffmpeg_decode_error_total").increment(1);
                    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
                    return Err(AppError::Media {
                        message: format!("ffmpeg exited with {}", output.status),
                        exit_code: output.status.code(),
                        stderr,
                    });
                }
                metrics::counter!("ffmpeg_decode_success_total").increment(1);
            }
            Ok(Err(e)) => return Err(AppError::Io(e)),
            Err(e) => return Err(AppError::Timeout(e)),
        }

        if !Self::is_usable_cache_file(&temp_path).await {
            return Err(AppError::Anyhow(anyhow!("Transcoded audio cache was empty.")));
        }

        // Atomically rename to final path
        let _ = fs::remove_file(&output_path).await;
        temp_file.persist(&output_path).map_err(|e| e.error)?;
        
        Ok(output_path)
    }

    pub async fn clear_audio_cache(&self) -> Result<(usize, u64), AppError> {
        let cache_dir = self.config.data_dir.join("cache");
        let mut removed = 0;
        let mut bytes = 0;
        
        let mut dir = match fs::read_dir(&cache_dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
            Err(e) => return Err(AppError::Io(e)),
        };

        while let Some(entry) = dir.next_entry().await? {
            let path = entry.path();
            if !path.is_file() { continue; }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.ends_with(".mp3") || name.ends_with(".tmp.mp3") {
                if let Ok(meta) = fs::metadata(&path).await {
                    if let Ok(_) = fs::remove_file(&path).await {
                        removed += 1;
                        bytes += meta.len();
                    }
                }
            }
        }
        
        Ok((removed, bytes))
    }
}
