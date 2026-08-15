use crate::config::Config;
use crate::db::{self, Track};
use crate::error::AppError;
use crate::services::ffmpeg::FfmpegService;
use anyhow::{anyhow, Context};
use futures_util::StreamExt;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use sha1_smol::Sha1;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::fs;
use tokio::sync::mpsc;
use tokio::task::spawn_blocking;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

pub static SCAN_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub tracks: Vec<Track>,
    pub imported: usize,
    pub failures: Vec<Failure>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum ScanEvent {
    Walk { found: usize },
    Probe { done: usize, total: usize, errors: usize },
    Complete(ScanResult),
}

fn hash_id(val: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(val.as_bytes());
    hasher.digest().to_string()[0..20].to_string()
}

fn first_tag<'a>(tags: &'a HashMap<String, String>, keys: &[&str], fallback: &'a str) -> String {
    for k in keys {
        if let Some(v) = tags.get(*k) {
            let t = v.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    fallback.to_string()
}

fn parse_number(val: Option<&String>) -> Option<i32> {
    val.and_then(|v| v.split('/').next().unwrap_or("").parse::<i32>().ok())
}

fn parse_track(file_path: &Path, meta: std::fs::Metadata, probe: serde_json::Value) -> Track {
    let path_str = file_path.to_string_lossy().to_string();
    let id = hash_id(&path_str.to_lowercase());
    let file_name = file_path.file_name().map(|s| s.to_string_lossy().to_string());
    let directory = file_path.parent().map(|s| s.to_string_lossy().to_string());
    
    let title_from_file = file_path.file_stem()
        .map(|s| s.to_string_lossy().replace(&['_', '-'][..], " ").trim().to_string())
        .unwrap_or_default();

    let mut tags = HashMap::new();
    let format_tags = probe["format"]["tags"].as_object();
    let streams = probe["streams"].as_array();
    
    let audio_stream = streams.and_then(|s| s.iter().find(|st| st["codec_type"] == "audio"));
    let audio_tags = audio_stream.and_then(|s| s["tags"].as_object());

    if let Some(t) = format_tags {
        for (k, v) in t {
            tags.insert(k.to_lowercase(), v.as_str().unwrap_or("").to_string());
        }
    }
    if let Some(t) = audio_tags {
        for (k, v) in t {
            tags.insert(k.to_lowercase(), v.as_str().unwrap_or("").to_string());
        }
    }

    let video_streams = streams.map(|s| s.iter().filter(|st| st["codec_type"] == "video").collect::<Vec<_>>()).unwrap_or_default();
    let has_artwork = !video_streams.is_empty();

    Track {
        id,
        path: path_str,
        file_name,
        directory,
        title: Some(first_tag(&tags, &["title"], &title_from_file)),
        artist: Some(first_tag(&tags, &["artist", "album_artist", "albumartist"], "Unknown Artist")),
        album: Some(first_tag(&tags, &["album"], "Unknown Album")),
        album_artist: Some(first_tag(&tags, &["album_artist", "albumartist"], "")),
        genre: Some(first_tag(&tags, &["genre"], "")),
        year: Some(first_tag(&tags, &["date", "year"], "")),
        track_number: parse_number(tags.get("track").or(tags.get("tracknumber"))),
        disc_number: parse_number(tags.get("disc").or(tags.get("discnumber"))),
        duration: probe["format"]["duration"].as_str().and_then(|s| s.parse().ok())
            .or_else(|| audio_stream.and_then(|s| s["duration"].as_str().and_then(|s| s.parse().ok())))
            .unwrap_or(0.0),
        bit_rate: probe["format"]["bit_rate"].as_str().and_then(|s| s.parse().ok())
            .or_else(|| audio_stream.and_then(|s| s["bit_rate"].as_str().and_then(|s| s.parse().ok())))
            .unwrap_or(0.0),
        sample_rate: audio_stream.and_then(|s| s["sample_rate"].as_str().and_then(|s| s.parse().ok())),
        bit_depth: parse_number(
            audio_stream.and_then(|s| s["bits_per_raw_sample"].as_str().map(|s| s.to_string()))
            .or_else(|| audio_stream.and_then(|s| s["bits_per_sample"].as_str().map(|s| s.to_string())))
            .as_ref()
        ),
        channels: audio_stream.and_then(|s| s["channels"].as_i64()).map(|v| v as i32),
        codec: audio_stream.and_then(|s| s["codec_name"].as_str()).map(|s| s.to_string()),
        format: probe["format"]["format_name"].as_str().map(|s| s.to_string()),
        size: Some(meta.len() as i64),
        modified_at: meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64),
        imported_at: Some(chrono::Utc::now().to_rfc3339()),
        metadata_extracted_at: Some(chrono::Utc::now().to_rfc3339()),
        has_artwork,
        tags: serde_json::to_value(tags).unwrap_or(serde_json::json!({})),
    }
}

pub struct ScannerService {
    config: Arc<Config>,
    ffmpeg: FfmpegService,
    pool: Pool<SqliteConnectionManager>,
}

impl ScannerService {
    pub fn new(config: Arc<Config>, ffmpeg: FfmpegService, pool: Pool<SqliteConnectionManager>) -> Self {
        Self { config, ffmpeg, pool }
    }

    fn is_audio_ext(path: &Path) -> bool {
        let exts = ["aac", "aif", "aiff", "alac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"];
        path.extension()
            .and_then(OsStr::to_str)
            .map(|e| exts.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false)
    }

    pub async fn scan_directory(
        &self,
        directory: PathBuf,
        progress: Option<mpsc::Sender<ScanEvent>>,
        cancel: CancellationToken,
    ) -> Result<ScanResult, AppError> {
        if SCAN_IN_FLIGHT.swap(true, Ordering::SeqCst) {
            return Err(AppError::Http {
                status: axum::http::StatusCode::CONFLICT,
                message: "A library scan is already running.".to_string(),
                detail: None,
            });
        }

        let res = self.scan_directory_impl(directory, progress, cancel).await;
        SCAN_IN_FLIGHT.store(false, Ordering::SeqCst);
        res
    }

    async fn scan_directory_impl(
        &self,
        directory: PathBuf,
        progress: Option<mpsc::Sender<ScanEvent>>,
        cancel: CancellationToken,
    ) -> Result<ScanResult, AppError> {
        let resolved = fs::canonicalize(&directory).await.map_err(|e| AppError::Http {
            status: axum::http::StatusCode::BAD_REQUEST,
            message: "Music folder could not be opened.".to_string(),
            detail: Some(e.to_string()),
        })?;

        let meta = fs::metadata(&resolved).await?;
        if !meta.is_dir() {
            return Err(AppError::Http {
                status: axum::http::StatusCode::BAD_REQUEST,
                message: "Path is not a directory.".to_string(),
                detail: None,
            });
        }

        let mut files = Vec::new();
        let mut failures = Vec::new();
        let mut visited = HashSet::new();

        let mut dirs_to_visit = vec![resolved];

        while let Some(current) = dirs_to_visit.pop() {
            if cancel.is_cancelled() { break; }
            if files.len() >= self.config.max_scan_files.get() {
                failures.push(Failure {
                    path: current.to_string_lossy().to_string(),
                    message: format!("Scan stopped after {} audio files.", self.config.max_scan_files),
                });
                break;
            }

            let real_path = match fs::canonicalize(&current).await {
                Ok(p) => p,
                Err(e) => {
                    failures.push(Failure { path: current.to_string_lossy().to_string(), message: e.to_string() });
                    continue;
                }
            };
            
            let norm = if cfg!(windows) {
                real_path.to_string_lossy().to_lowercase()
            } else {
                real_path.to_string_lossy().to_string()
            };

            if !visited.insert(norm) { continue; }

            let mut dir = match fs::read_dir(&real_path).await {
                Ok(d) => d,
                Err(e) => {
                    failures.push(Failure { path: real_path.to_string_lossy().to_string(), message: e.to_string() });
                    continue;
                }
            };

            while let Some(entry) = dir.next_entry().await.ok().flatten() {
                let typ = match entry.file_type().await {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                if typ.is_symlink() { continue; }

                let p = entry.path();
                if typ.is_dir() {
                    dirs_to_visit.push(p);
                } else if typ.is_file() && Self::is_audio_ext(&p) {
                    files.push(p);
                }
            }

            if let Some(tx) = &progress {
                let _ = tx.send(ScanEvent::Walk { found: files.len() }).await;
            }
        }

        let total = files.len();
        let semaphore = Arc::new(tokio::sync::Semaphore::new(self.config.scan_concurrency.get()));
        let (tx_track, mut rx_track) = mpsc::channel(100);
        let mut spawn_tasks = futures_util::stream::FuturesUnordered::new();

        for file in files {
            if cancel.is_cancelled() { break; }
            let permit = semaphore.clone().acquire_owned().await.unwrap();
            let ffmpeg = self.ffmpeg.clone();
            let tx = tx_track.clone();

            spawn_tasks.push(tokio::spawn(async move {
                let _p = permit;
                let meta = fs::metadata(&file).await.map_err(|e| anyhow!("Stat failed: {}", e))?;
                let probe = ffmpeg.probe_track_metadata(&file).await.map_err(|e| anyhow!("Probe failed: {:?}", e))?;
                let track = parse_track(&file, meta, probe);
                let _ = tx.send(Ok(track)).await;
                Ok::<_, anyhow::Error>(())
            }));
        }
        drop(tx_track); // close sending end

        let mut done = 0;
        let mut errors = 0;
        let mut tracks_to_insert = Vec::new();
        
        while let Some(res) = rx_track.recv().await {
            done += 1;
            match res {
                Ok(track) => tracks_to_insert.push(track),
                Err(e) => {
                    errors += 1;
                    if failures.len() < self.config.max_scan_failures.get() {
                        failures.push(Failure { path: "[probe]".into(), message: e.to_string() });
                    }
                }
            }

            if let Some(tx) = &progress {
                let _ = tx.send(ScanEvent::Probe { done, total, errors }).await;
            }

            // Batch insert every 100 tracks
            if tracks_to_insert.len() >= 100 {
                let batch = std::mem::take(&mut tracks_to_insert);
                let pool = self.pool.clone();
                spawn_blocking(move || {
                    if let Ok(mut conn) = pool.get() {
                        let _ = db::upsert_tracks_batch(&mut conn, &batch);
                    }
                }).await?;
            }
        }

        // Insert remainder
        if !tracks_to_insert.is_empty() {
            let pool = self.pool.clone();
            let batch = tracks_to_insert.clone();
            spawn_blocking(move || {
                if let Ok(mut conn) = pool.get() {
                    let _ = db::upsert_tracks_batch(&mut conn, &batch);
                }
            }).await?;
        }
        
        let pool = self.pool.clone();
        let all_tracks = spawn_blocking(move || {
            let conn = pool.get()?;
            db::get_all_tracks(&conn)
        }).await??;

        let result = ScanResult {
            tracks: all_tracks,
            imported: done - errors,
            failures,
        };

        if let Some(tx) = &progress {
            let _ = tx.send(ScanEvent::Complete(result.clone())).await;
        }

        Ok(result)
    }

    pub async fn extract_single_track_metadata(&self, track_id: &str) -> Result<Track, AppError> {
        let pool = self.pool.clone();
        let id_cloned = track_id.to_string();
        let track = spawn_blocking(move || {
            let conn = pool.get()?;
            db::get_track_by_id(&conn, &id_cloned)
        }).await??.ok_or_else(|| AppError::Http {
            status: axum::http::StatusCode::NOT_FOUND,
            message: "Track not found.".to_string(),
            detail: None,
        })?;

        let path = PathBuf::from(&track.path);
        let meta = fs::metadata(&path).await.map_err(|e| AppError::Http {
            status: axum::http::StatusCode::NOT_FOUND,
            message: "Track file could not be opened.".to_string(),
            detail: Some(e.to_string()),
        })?;

        let probe = self.ffmpeg.probe_track_metadata(&path).await?;
        let mut next_track = parse_track(&path, meta, probe);
        next_track.id = track.id; // preserve ID
        
        let pool = self.pool.clone();
        let t_clone = next_track.clone();
        spawn_blocking(move || {
            let mut conn = pool.get()?;
            db::upsert_tracks_batch(&mut conn, &[t_clone])
        }).await??;

        Ok(next_track)
    }
}
