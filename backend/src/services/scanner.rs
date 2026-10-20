use crate::{
    config::Config,
    db::{self, Track},
    error::AppError,
    path_policy,
    services::ffmpeg::FfmpegService,
};
use futures_util::{stream, StreamExt};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tokio::{
    fs,
    io::AsyncReadExt,
    sync::{broadcast, Mutex},
    task::spawn_blocking,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct ActiveScan {
    pub job_id: String,
    pub tx: broadcast::Sender<ScanEvent>,
    pub history: Arc<Mutex<Vec<ScanEvent>>>,
    pub is_done: Arc<AtomicBool>,
    cancel: CancellationToken,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub path: String,
    pub message: String,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub imported: usize,
    pub unchanged: usize,
    pub missing: usize,
    pub failure_count: usize,
    pub failures: Vec<Failure>,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum ScanEvent {
    Walk {
        found: usize,
    },
    Probe {
        done: usize,
        total: usize,
        errors: usize,
    },
    Complete(ScanResult),
    Failed {
        message: String,
    },
}
impl ScanEvent {
    pub fn terminal(&self) -> bool {
        matches!(self, Self::Complete(_) | Self::Failed { .. })
    }
}
fn norm(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_owned()
    }
}
async fn fingerprint(
    path: &Path,
    cancel: &CancellationToken,
    budget: &AtomicU64,
    maximum: u64,
    file_maximum: u64,
    timeout_ms: u64,
) -> Result<String, AppError> {
    let work = async {
        let path = path_policy::validate_audio_path(path).await?;
        let mut file = path_policy::open_local_file(&path).await?;
        let before = file.metadata().await?;
        let size = before.len();
        if size > file_maximum
            || budget
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                    used.checked_add(size).filter(|total| *total <= maximum)
                })
                .is_err()
        {
            return Err(AppError::bad_request(
                "Audio file or aggregate fingerprint-byte limit exceeded.",
            ));
        }
        let mut hash = sha1_smol::Sha1::new();
        let mut buffer = vec![0; 64 * 1024];
        let mut read = 0u64;
        loop {
            let count = file.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            read += count as u64;
            if read > size {
                return Err(AppError::bad_request(
                    "Audio changed while fingerprinting; rescan the folder.",
                ));
            }
            hash.update(&buffer[..count]);
        }
        let after = file.metadata().await?;
        if read != size || after.len() != size || before.modified().ok() != after.modified().ok() {
            return Err(AppError::bad_request(
                "Audio changed while fingerprinting; rescan the folder.",
            ));
        }
        Ok(hash.digest().to_string())
    };
    tokio::select! {
        _ = cancel.cancelled() => Err(AppError::bad_request("Scan canceled.")),
        result = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), work) => {
            result.map_err(|_| AppError::bad_request("Audio fingerprint exceeded its time budget."))?
        }
    }
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
fn numeric(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
}
fn positive_integer(value: &serde_json::Value) -> Option<i32> {
    numeric(value)
        .filter(|value| *value > 0.0 && *value <= i32::MAX as f64 && value.fract() == 0.0)
        .map(|value| value as i32)
}

fn parse_track(file_path: &Path, meta: std::fs::Metadata, probe: serde_json::Value) -> Track {
    let path_str = file_path.to_string_lossy().to_string();
    let id = uuid::Uuid::new_v4().to_string();
    let file_name = file_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string());
    let directory = file_path.parent().map(|s| s.to_string_lossy().to_string());

    let title_from_file = file_path
        .file_stem()
        .map(|s| {
            s.to_string_lossy()
                .replace(&['_', '-'][..], " ")
                .trim()
                .to_string()
        })
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

    let video_streams = streams
        .map(|s| {
            s.iter()
                .filter(|st| st["codec_type"] == "video" && st["disposition"]["attached_pic"] == 1)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let has_artwork = !video_streams.is_empty();

    Track {
        id,
        path: path_str,
        file_name,
        directory,
        title: Some(first_tag(&tags, &["title"], &title_from_file)),
        artist: Some(first_tag(
            &tags,
            &["artist", "album_artist", "albumartist"],
            "Unknown Artist",
        )),
        album: Some(first_tag(&tags, &["album"], "Unknown Album")),
        album_artist: Some(first_tag(&tags, &["album_artist", "albumartist"], "")),
        genre: Some(first_tag(&tags, &["genre"], "")),
        year: Some(first_tag(&tags, &["date", "year"], "")),
        track_number: parse_number(tags.get("track").or(tags.get("tracknumber"))),
        disc_number: parse_number(tags.get("disc").or(tags.get("discnumber"))),
        duration: numeric(&probe["format"]["duration"])
            .or_else(|| audio_stream.and_then(|s| numeric(&s["duration"])))
            .unwrap_or(0.0),
        bit_rate: numeric(&probe["format"]["bit_rate"])
            .or_else(|| audio_stream.and_then(|s| numeric(&s["bit_rate"])))
            .unwrap_or(0.0),
        sample_rate: audio_stream.and_then(|s| positive_integer(&s["sample_rate"]).map(f64::from)),
        bit_depth: audio_stream.and_then(|s| {
            positive_integer(&s["bits_per_raw_sample"])
                .or_else(|| positive_integer(&s["bits_per_sample"]))
        }),
        channels: audio_stream
            .and_then(|s| s["channels"].as_i64())
            .map(|v| v as i32),
        codec: audio_stream
            .and_then(|s| s["codec_name"].as_str())
            .map(|s| s.to_string()),
        format: probe["format"]["format_name"]
            .as_str()
            .map(|s| s.to_string()),
        size: Some(meta.len() as i64),
        modified_at: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64),
        imported_at: Some(chrono::Utc::now().to_rfc3339()),
        metadata_extracted_at: Some(chrono::Utc::now().to_rfc3339()),
        has_artwork,
        tags: serde_json::to_value(tags).unwrap_or(serde_json::json!({})),
    }
}

#[derive(Clone)]
pub struct ScannerService {
    config: Arc<Config>,
    ffmpeg: FfmpegService,
    pool: Pool<SqliteConnectionManager>,
    active_scan: Arc<Mutex<Option<ActiveScan>>>,
}
impl ScannerService {
    pub fn new(
        config: Arc<Config>,
        ffmpeg: FfmpegService,
        pool: Pool<SqliteConnectionManager>,
    ) -> Self {
        Self {
            config,
            ffmpeg,
            pool,
            active_scan: Arc::new(Mutex::new(None)),
        }
    }
    pub async fn get_active_scan(&self) -> Option<ActiveScan> {
        self.active_scan.lock().await.clone()
    }
    pub async fn cancel_active(&self) {
        if let Some(scan) = self.get_active_scan().await {
            scan.cancel.cancel();
        }
    }
    pub async fn cancel_job(&self, id: &str) -> Result<(), AppError> {
        let scan = self
            .get_active_scan()
            .await
            .filter(|s| s.job_id == id)
            .ok_or_else(|| AppError::not_found("Running scan not found."))?;
        scan.cancel.cancel();
        Ok(())
    }
    pub async fn get_scan(&self, id: &str) -> Result<ActiveScan, AppError> {
        if let Some(scan) = self.get_active_scan().await.filter(|s| s.job_id == id) {
            return Ok(scan);
        }
        let pool = self.pool.clone();
        let job = id.to_owned();
        let value = spawn_blocking(move || {
            let conn = pool.get()?;
            db::reliability::get_job(&conn, &job)
        })
        .await??
        .ok_or_else(|| AppError::not_found("Scan job not found."))?;
        let event: ScanEvent = serde_json::from_value(value["event"].clone())?;
        let (tx, _) = broadcast::channel(8);
        Ok(ActiveScan {
            job_id: id.into(),
            tx,
            history: Arc::new(Mutex::new(vec![event])),
            is_done: Arc::new(AtomicBool::new(true)),
            cancel: CancellationToken::new(),
        })
    }
    async fn publish(
        &self,
        scan: &ActiveScan,
        directory: &str,
        event: ScanEvent,
    ) -> Result<(), AppError> {
        {
            let mut history = scan.history.lock().await;
            if let Some(last) = history
                .last_mut()
                .filter(|last| std::mem::discriminant(*last) == std::mem::discriminant(&event))
            {
                *last = event.clone();
            } else {
                history.push(event.clone());
            }
        }
        let terminal = event.terminal();
        if terminal || matches!(event, ScanEvent::Walk { .. }) {
            let pool = self.pool.clone();
            let id = scan.job_id.clone();
            let directory = directory.to_owned();
            let value = serde_json::to_value(&event)?;
            spawn_blocking(move || {
                let conn = pool.get()?;
                db::reliability::save_job(&conn, &id, &directory, &value, terminal)
            })
            .await??;
        }
        let _ = scan.tx.send(event);
        Ok(())
    }
    pub async fn start_scan(&self, directory: PathBuf) -> Result<String, AppError> {
        let resolved = path_policy::validate_directory(&directory).await?;
        let mut active = self.active_scan.lock().await;
        if active
            .as_ref()
            .is_some_and(|s| !s.is_done.load(Ordering::SeqCst))
        {
            return Err(AppError::Http {
                status: axum::http::StatusCode::CONFLICT,
                message: "A library scan is already running.".into(),
                detail: None,
            });
        }
        let job = uuid::Uuid::new_v4().to_string();
        let (tx, _) = broadcast::channel(512);
        let scan = ActiveScan {
            job_id: job.clone(),
            tx,
            history: Arc::new(Mutex::new(Vec::new())),
            is_done: Arc::new(AtomicBool::new(false)),
            cancel: CancellationToken::new(),
        };
        self.publish(
            &scan,
            &resolved.to_string_lossy(),
            ScanEvent::Walk { found: 0 },
        )
        .await?;
        *active = Some(scan.clone());
        drop(active);
        let scanner = self.clone();
        tokio::spawn(async move {
            let path = resolved.to_string_lossy().to_string();
            let result = tokio::select! {
                result=scanner.scan(&scan,resolved)=>result,
                _=scan.cancel.cancelled()=>Err(AppError::bad_request("Scan canceled. Completed imports were kept; rescan to continue.")),
                _=tokio::time::sleep(std::time::Duration::from_millis(scanner.config.scan_timeout_ms))=>Err(AppError::bad_request("Scan exceeded its time budget. Completed imports were kept; scan smaller folders.")),
            };
            let terminal = match result {
                Ok(result) => ScanEvent::Complete(result),
                Err(error) => ScanEvent::Failed {
                    message: error.to_string(),
                },
            };
            if let Err(error) = scanner.publish(&scan, &path, terminal.clone()).await {
                tracing::error!(%error,"Could not save scan result");
                let _ = scan.tx.send(terminal);
            }
            scan.is_done.store(true, Ordering::SeqCst);
        });
        Ok(job)
    }
    async fn scan(&self, scan: &ActiveScan, resolved: PathBuf) -> Result<ScanResult, AppError> {
        let source_path = resolved.to_string_lossy().to_string();
        let pool = self.pool.clone();
        let source_path2 = source_path.clone();
        let (source, inventory) = spawn_blocking(move || {
            let mut conn = pool.get()?;
            db::remember_library_source(&mut conn, &source_path2)?;
            let source: String = conn.query_row(
                "SELECT id FROM library_sources WHERE path=?",
                [source_path2],
                |r| r.get(0),
            )?;
            Ok::<_, AppError>((source, db::reliability::scan_inventory(&conn)?))
        })
        .await??;
        let mut known = HashMap::new();
        let mut missing_fingerprints: HashMap<String, Vec<Track>> = HashMap::new();
        for (track, hash) in inventory {
            let available = match path_policy::validate_local_path(Path::new(&track.path)).await {
                Ok(path) => fs::symlink_metadata(path)
                    .await
                    .is_ok_and(|meta| meta.is_file()),
                Err(_) => false,
            };
            if !available {
                if let Some(hash) = &hash {
                    missing_fingerprints
                        .entry(hash.clone())
                        .or_default()
                        .push(track.clone());
                }
            }
            known.insert(norm(&track.path), (track, hash));
        }
        let known = Arc::new(known);
        let missing_fingerprints = Arc::new(missing_fingerprints);
        let root = resolved.clone();
        let mut dirs = vec![resolved];
        let mut visited = HashSet::new();
        let mut directory_count = 1usize;
        let mut entry_count = 0usize;
        let mut files = Vec::new();
        let mut failures = Vec::new();
        let mut failure_count = 0;
        let mut complete_walk = true;
        let mut report = |path: String, message: String| {
            failure_count += 1;
            if failures.len() < self.config.max_scan_failures.get() {
                failures.push(Failure { path, message });
            }
        };
        'walk: while let Some(path) = dirs.pop() {
            let real = match path_policy::validate_directory(&path).await {
                Ok(p) => p,
                Err(e) => {
                    complete_walk = false;
                    report(path.to_string_lossy().into(), e.to_string());
                    continue;
                }
            };
            if !path_policy::is_within(&real, &root) {
                complete_walk = false;
                report(
                    path.to_string_lossy().into(),
                    "Directory escapes the approved music folder.".into(),
                );
                continue;
            }
            if !visited.insert(norm(&real.to_string_lossy())) {
                continue;
            }
            let mut entries = match fs::read_dir(&real).await {
                Ok(d) => d,
                Err(e) => {
                    complete_walk = false;
                    report(real.to_string_lossy().into(), e.to_string());
                    continue;
                }
            };
            loop {
                let entry = match entries.next_entry().await {
                    Ok(Some(e)) => e,
                    Ok(None) => break,
                    Err(e) => {
                        complete_walk = false;
                        report(real.to_string_lossy().into(), e.to_string());
                        break;
                    }
                };
                entry_count += 1;
                if entry_count > self.config.max_scan_entries.get() {
                    complete_walk = false;
                    report(
                        real.to_string_lossy().into(),
                        "Scan directory-entry limit reached; scan smaller folders.".into(),
                    );
                    break 'walk;
                }
                let kind = match entry.file_type().await {
                    Ok(t) => t,
                    Err(e) => {
                        complete_walk = false;
                        report(entry.path().to_string_lossy().into(), e.to_string());
                        continue;
                    }
                };
                if kind.is_symlink() {
                    complete_walk = false;
                    continue;
                }
                if kind.is_dir() {
                    if directory_count >= self.config.max_scan_directories.get() {
                        complete_walk = false;
                        report(
                            real.to_string_lossy().into(),
                            "Scan directory limit reached; scan smaller folders.".into(),
                        );
                        break 'walk;
                    }
                    directory_count += 1;
                    dirs.push(entry.path());
                } else if kind.is_file() && path_policy::is_audio_extension(&entry.path()) {
                    if files.len() >= self.config.max_scan_files.get() {
                        complete_walk = false;
                        report(
                            real.to_string_lossy().into(),
                            format!(
                                "Scan limit of {} files reached.",
                                self.config.max_scan_files
                            ),
                        );
                        break 'walk;
                    }
                    files.push(entry.path());
                }
            }
            self.publish(scan, &source_path, ScanEvent::Walk { found: files.len() })
                .await?;
        }
        let total = files.len();
        let ffmpeg = self.ffmpeg.clone();
        let budget = Arc::new(AtomicU64::new(0));
        let mut probes = stream::iter(files)
            .map(|path| {
                let known = known.clone();
                let missing = missing_fingerprints.clone();
                let ffmpeg = ffmpeg.clone();
                let budget = budget.clone();
                let root = root.clone();
                let cancel = scan.cancel.clone();
                let config = self.config.clone();
                async move {
                    let result = async {
                        if path.to_str().is_none() {
                            return Err(AppError::bad_request(
                                "This filename is not valid Unicode. Rename it before importing.",
                            ));
                        }
                        let validated = path_policy::validate_audio_path(&path).await?;
                        if !path_policy::is_within(&validated, &root) {
                            return Err(AppError::bad_request(
                                "Audio escapes the approved music folder.",
                            ));
                        }
                        let meta = fs::symlink_metadata(&validated).await?;
                        if meta.len() > config.max_scan_file_bytes {
                            return Err(AppError::bad_request(
                                "Audio exceeds the scan file-size limit.",
                            ));
                        }
                        let modified = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|t| t.as_millis() as i64);
                        let old = known.get(&norm(&path.to_string_lossy()));
                        if let Some((track, Some(hash))) = old {
                            if track.size == Some(meta.len() as i64)
                                && track.modified_at == modified
                            {
                                return Ok::<_, AppError>((track.clone(), hash.clone(), true));
                            }
                        }
                        let hash = fingerprint(
                            &validated,
                            &cancel,
                            &budget,
                            config.max_scan_hash_bytes,
                            config.max_scan_file_bytes,
                            config.fingerprint_timeout_ms,
                        )
                        .await?;
                        let probe = ffmpeg.probe_track_metadata(&validated).await?;
                        if !probe["streams"].as_array().is_some_and(|streams| {
                            streams.iter().any(|stream| stream["codec_type"] == "audio")
                        }) {
                            return Err(AppError::bad_request(
                                "File has no supported audio stream.",
                            ));
                        }
                        let mut track = parse_track(&path, meta, probe);
                        if let Some((old, _)) = old {
                            track.id = old.id.clone();
                            track.imported_at = old.imported_at.clone();
                        } else if let Some(candidates) = missing.get(&hash).filter(|v| v.len() == 1)
                        {
                            track.id = candidates[0].id.clone();
                            track.imported_at = candidates[0].imported_at.clone();
                        }
                        Ok((track, hash, false))
                    }
                    .await;
                    (path, result)
                }
            })
            .buffer_unordered(self.config.scan_concurrency.get());
        let mut batch = Vec::new();
        let mut imported = 0;
        let mut unchanged = 0;
        let mut done = 0;
        let mut errors = 0;
        let mut moved_ids = HashSet::new();
        while let Some((path, result)) = probes.next().await {
            done += 1;
            match result {
                Ok((mut track, hash, skip)) => {
                    // Two new copies of one missing file must not share an ID.
                    if !known.contains_key(&norm(&track.path))
                        && !moved_ids.insert(track.id.clone())
                    {
                        track.id = uuid::Uuid::new_v4().to_string();
                    }
                    if skip {
                        unchanged += 1;
                    } else {
                        imported += 1;
                    }
                    batch.push((track, hash));
                }
                Err(e) => {
                    errors += 1;
                    failure_count += 1;
                    if failures.len() < self.config.max_scan_failures.get() {
                        failures.push(Failure {
                            path: path.to_string_lossy().into(),
                            message: e.to_string(),
                        });
                    }
                }
            }
            if batch.len() >= 100 {
                self.save_batch(
                    std::mem::take(&mut batch),
                    source.clone(),
                    scan.job_id.clone(),
                )
                .await?;
            }
            self.publish(
                scan,
                &source_path,
                ScanEvent::Probe {
                    done,
                    total,
                    errors,
                },
            )
            .await?;
        }
        if !batch.is_empty() {
            self.save_batch(batch, source.clone(), scan.job_id.clone())
                .await?;
        }
        // Probe failures can indicate inaccessible files. Never mark them missing.
        let pool = self.pool.clone();
        let job = scan.job_id.clone();
        let missing = spawn_blocking(move || {
            let mut conn = pool.get()?;
            db::reliability::finish_source(&mut conn, &source, &job, complete_walk && errors == 0)
        })
        .await??;
        metrics::counter!("scanner_imported_total").increment(imported as u64);
        metrics::counter!("scanner_failures_total").increment(failure_count as u64);
        Ok(ScanResult {
            imported,
            unchanged,
            missing,
            failure_count,
            failures,
        })
    }
    async fn save_batch(
        &self,
        batch: Vec<(Track, String)>,
        source: String,
        job: String,
    ) -> Result<(), AppError> {
        let pool = self.pool.clone();
        spawn_blocking(move || {
            let mut conn = pool.get()?;
            db::reliability::save_scan_batch(&mut conn, &batch, &source, &job)
        })
        .await??;
        Ok(())
    }
    pub async fn extract_single_track_metadata(&self, id: &str) -> Result<Track, AppError> {
        let pool = self.pool.clone();
        let id = id.to_owned();
        let track = spawn_blocking(move || {
            let conn = pool.get()?;
            db::get_track_by_id(&conn, &id)
        })
        .await??
        .ok_or_else(|| AppError::not_found("Track not found."))?;
        let path = path_policy::validate_audio_path(Path::new(&track.path)).await?;
        let mut next = parse_track(
            &path,
            fs::metadata(&path).await?,
            self.ffmpeg.probe_track_metadata(&path).await?,
        );
        next.id = track.id;
        next.imported_at = track.imported_at;
        let hash = fingerprint(
            &path,
            &CancellationToken::new(),
            &AtomicU64::new(0),
            self.config.max_scan_hash_bytes,
            self.config.max_scan_file_bytes,
            self.config.fingerprint_timeout_ms,
        )
        .await?;
        let pool = self.pool.clone();
        let saved = next.clone();
        spawn_blocking(move || {
            let mut conn=pool.get()?;let tx=conn.transaction()?;
            db::upsert_tracks(&tx,std::slice::from_ref(&saved))?;
            tx.execute("INSERT INTO track_fingerprints VALUES (?,?) ON CONFLICT(trackId) DO UPDATE SET fingerprint=excluded.fingerprint",rusqlite::params![saved.id,hash])?;
            tx.execute("UPDATE tracks SET available=1 WHERE id=?",[saved.id])?;tx.commit()?;Ok::<_,AppError>(())
        }).await??;
        Ok(next)
    }
}

#[cfg(test)]
mod metadata_tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[tokio::test]
    async fn fingerprint_work_is_bounded_and_cancellable() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("bounded.wav");
        let mut content = vec![0; 128];
        content[..4].copy_from_slice(b"RIFF");
        content[8..12].copy_from_slice(b"WAVE");
        fs::write(&path, content).await.unwrap();
        let cancel = CancellationToken::new();
        let used = AtomicU64::new(0);
        assert!(fingerprint(&path, &cancel, &used, 64, 256, 1000)
            .await
            .is_err());
        assert_eq!(used.load(Ordering::SeqCst), 0);
        assert!(fingerprint(&path, &cancel, &used, 256, 64, 1000)
            .await
            .is_err());
        assert!(fingerprint(&path, &cancel, &used, 256, 256, 1000)
            .await
            .is_ok());
        assert_eq!(used.load(Ordering::SeqCst), 128);
        assert!(fingerprint(&path, &cancel, &used, 200, 256, 1000)
            .await
            .is_err());
        cancel.cancel();
        assert!(
            fingerprint(&path, &cancel, &AtomicU64::new(0), 256, 256, 1000)
                .await
                .is_err()
        );
    }
    #[test]
    fn numeric_metadata_and_attached_picture_are_parsed_deliberately() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let probe = serde_json::json!({
            "format":{"duration":12.5,"bit_rate":"96000","tags":{"ALBUM":"Collection","ALBUMARTIST":"Various Artists","TRACK":"2/12","DISC":"1/2"}},
            "streams":[{"codec_type":"audio","codec_name":"pcm_s16le","sample_rate":48000,"channels":2,"bits_per_raw_sample":"0","bits_per_sample":16},
            {"codec_type":"video","disposition":{"attached_pic":0}}]
        });
        let track = parse_track(
            file.path(),
            file.as_file().metadata().unwrap(),
            probe.clone(),
        );
        assert_eq!(track.duration, 12.5);
        assert_eq!(track.bit_rate, 96000.0);
        assert_eq!(track.sample_rate, Some(48000.0));
        assert_eq!(track.bit_depth, Some(16));
        assert_eq!(track.track_number, Some(2));
        assert_eq!(track.disc_number, Some(1));
        assert_eq!(track.album_artist.as_deref(), Some("Various Artists"));
        assert!(!track.has_artwork);
        let mut picture = probe;
        picture["streams"][1]["disposition"]["attached_pic"] = serde_json::json!(1);
        assert!(parse_track(file.path(), file.as_file().metadata().unwrap(), picture).has_artwork);
        assert!(numeric(&serde_json::json!("NaN")).is_none());
        assert!(positive_integer(&serde_json::json!(1.5)).is_none());
    }
}
