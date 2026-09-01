use axum::{
    body::Body,
    extract::{Path, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use sha1_smol::Sha1;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::fs::{self, File};
use tokio::process::Command;
use tokio::task::spawn_blocking;
use tokio_util::io::ReaderStream;

use super::AppState;
use crate::db::{self, Track};
use crate::error::AppError;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/decode/:id", post(decode_track))
        .route("/stream/:id", get(stream_track))
        .route("/audio/:id", get(send_audio).head(send_audio))
        .route("/cache/:id", get(check_cache))
        .route("/artwork/:id", get(send_artwork))
}

fn valid_id(id: &str) -> Result<String, AppError> {
    if id.is_empty() || id.len() > 200 {
        return Err(AppError::Http {
            status: StatusCode::BAD_REQUEST,
            message: "Invalid track ID".to_string(),
            detail: None,
        });
    }
    Ok(id.to_string())
}

async fn get_track_or_throw(state: &AppState, id: &str) -> Result<Track, AppError> {
    let pool = state.pool.clone();
    let id_cloned = id.to_string();
    let track = spawn_blocking(move || {
        let conn = pool.get()?;
        db::get_track_by_id(&conn, &id_cloned)
    }).await??.ok_or_else(|| AppError::Http {
        status: StatusCode::NOT_FOUND,
        message: "Track not found.".to_string(),
        detail: None,
    })?;
    Ok(track)
}

fn track_version(track: &Track) -> String {
    let basis = format!("{}|{}|{}", track.id, track.modified_at.unwrap_or(0), track.size.unwrap_or(0));
    let mut hasher = Sha1::new();
    hasher.update(basis.as_bytes());
    hasher.digest().to_string()[0..24].to_string()
}

async fn decode_track(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let id = valid_id(&id)?;
    let track = get_track_or_throw(&state, &id).await?;
    let decoded_path = state.ffmpeg.ensure_decoded(&track).await?;

    let file_name = decoded_path.file_name().unwrap_or_default().to_string_lossy();
    let audio_url = format!("/api/audio/{}?v={}", urlencoding::encode(&track.id), urlencoding::encode(&file_name));

    Ok(Json(serde_json::json!({
        "id": track.id,
        "audioUrl": audio_url,
        "streaming": false
    })))
}

async fn check_cache(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let id = valid_id(&id)?;
    let track = get_track_or_throw(&state, &id).await?;
    let cache_path = state.ffmpeg.cache_path_for_track(&track)?;
    let ready = crate::services::ffmpeg::FfmpegService::is_usable_cache_file(&cache_path).await;

    let audio_url = if ready {
        Some(format!("/api/audio/{}?v={}", urlencoding::encode(&track.id), urlencoding::encode(&track_version(&track))))
    } else {
        None
    };

    Ok(Json(serde_json::json!({
        "id": track.id,
        "ready": ready,
        "audioUrl": audio_url
    })))
}

async fn stream_track(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let id = valid_id(&id)?;
    let track = get_track_or_throw(&state, &id).await?;

    if let Err(e) = fs::metadata(&track.path).await {
        return Err(AppError::Http {
            status: StatusCode::NOT_FOUND,
            message: "Track file could not be opened.".to_string(),
            detail: Some(e.to_string()),
        });
    }

    let mut child = Command::new(&state.config.ffmpeg_path)
        .args([
            "-hide_banner", "-loglevel", "error", "-nostdin",
            "-i", &track.path,
            "-map", "0:a:0", "-vn", "-map_metadata", "0",
            "-codec:a", "libmp3lame", "-q:a", "3", "-f", "mp3", "pipe:1"
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::Media {
            message: "Failed to spawn ffmpeg".to_string(),
            exit_code: None,
            stderr: e.to_string(),
        })?;

    let stdout = child.stdout.take().ok_or_else(|| AppError::Media {
        message: "Failed to capture ffmpeg stdout".to_string(),
        exit_code: None,
        stderr: String::new(),
    })?;
    // stderr could be logged, but skipping for simplicity as stream handles it transparently
    
    let stream = ReaderStream::new(stdout);
    let body = Body::from_stream(stream);

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/mpeg"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("X-Accel-Buffering", HeaderValue::from_static("no"));

    // We don't await the child exit here; axum handles streaming the body and drop kills it.

    Ok((StatusCode::OK, headers, body))
}

fn parse_range(range_str: &str, size: u64) -> Result<std::ops::RangeInclusive<u64>, AppError> {
    if !range_str.starts_with("bytes=") {
        return Err(AppError::Http { status: StatusCode::RANGE_NOT_SATISFIABLE, message: "Invalid range".to_string(), detail: None });
    }
    let r = &range_str[6..];
    if r.contains(',') {
        return Err(AppError::Http { status: StatusCode::RANGE_NOT_SATISFIABLE, message: "Multiple ranges not supported".to_string(), detail: None });
    }
    let parts: Vec<&str> = r.split('-').collect();
    if parts.len() != 2 {
        return Err(AppError::Http { status: StatusCode::RANGE_NOT_SATISFIABLE, message: "Invalid range".to_string(), detail: None });
    }
    let start_str = parts[0].trim();
    let end_str = parts[1].trim();
    
    if start_str.is_empty() && !end_str.is_empty() {
        let suffix: u64 = end_str.parse().map_err(|_| AppError::Http { status: StatusCode::RANGE_NOT_SATISFIABLE, message: "Invalid range".to_string(), detail: None })?;
        if suffix == 0 {
            return Err(AppError::Http { status: StatusCode::RANGE_NOT_SATISFIABLE, message: "Invalid range".to_string(), detail: None });
        }
        let start = size.saturating_sub(suffix);
        return Ok(start..=(size - 1));
    }
    
    let start: u64 = if start_str.is_empty() { 0 } else {
        start_str.parse().map_err(|_| AppError::Http { status: StatusCode::RANGE_NOT_SATISFIABLE, message: "Invalid range".to_string(), detail: None })?
    };
    
    let end: u64 = if end_str.is_empty() { size - 1 } else {
        end_str.parse().map_err(|_| AppError::Http { status: StatusCode::RANGE_NOT_SATISFIABLE, message: "Invalid range".to_string(), detail: None })?
    };
    
    let end = std::cmp::min(end, size - 1);
    
    if start >= size || start > end {
        return Err(AppError::Http { status: StatusCode::RANGE_NOT_SATISFIABLE, message: "Range not satisfiable".to_string(), detail: None });
    }
    Ok(start..=end)
}

async fn send_audio(
    State(state): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Result<impl IntoResponse, AppError> {
    let id = valid_id(&id)?;
    let track = get_track_or_throw(&state, &id).await?;
    let decoded_path = state.ffmpeg.cache_path_for_track(&track)?;
    
    let meta = fs::metadata(&decoded_path).await.map_err(|_| AppError::Http {
        status: StatusCode::NOT_FOUND,
        message: "Audio cache is not ready.".to_string(),
        detail: None,
    })?;
    
    if !meta.is_file() || meta.len() == 0 {
        return Err(AppError::Http {
            status: StatusCode::NOT_FOUND,
            message: "Audio cache is not ready.".to_string(),
            detail: None,
        });
    }
    
    let etag = format!("\"{}\"", track_version(&track));
    
    if let Some(if_none_match) = req.headers().get(header::IF_NONE_MATCH) {
        if if_none_match.to_str().unwrap_or("") == etag {
            return Ok(StatusCode::NOT_MODIFIED.into_response());
        }
    }
    
    let size = meta.len();
    let mut headers = HeaderMap::new();
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/mpeg"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=86400"));
    if let Ok(val) = HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, val);
    }
    
    let range_hdr = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    
    let range = match range_hdr {
        Some(r) => match parse_range(r, size) {
            Ok(rng) => Some(rng),
            Err(_) => {
                if let Ok(val) = HeaderValue::from_str(&format!("bytes */{}", size)) {
                    headers.insert(header::CONTENT_RANGE, val);
                }
                headers.insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
                return Ok((StatusCode::RANGE_NOT_SATISFIABLE, headers, Body::empty()).into_response());
            }
        },
        None => None,
    };
    
    if let Some(rng) = range {
        let start = *rng.start();
        let end = *rng.end();
        if let Ok(val) = HeaderValue::from_str(&format!("bytes {}-{}/{}", start, end, size)) {
            headers.insert(header::CONTENT_RANGE, val);
        }
        if let Ok(val) = HeaderValue::from_str(&format!("{}", end - start + 1)) {
            headers.insert(header::CONTENT_LENGTH, val);
        }
        
        if req.method() == axum::http::Method::HEAD {
            return Ok((StatusCode::PARTIAL_CONTENT, headers, Body::empty()).into_response());
        }
        
        let mut file = File::open(decoded_path).await?;
        use tokio::io::AsyncSeekExt;
        file.seek(std::io::SeekFrom::Start(start)).await?;
        let stream = ReaderStream::new(file.take(end - start + 1));
        return Ok((StatusCode::PARTIAL_CONTENT, headers, Body::from_stream(stream)).into_response());
    }
    
    if let Ok(val) = HeaderValue::from_str(&size.to_string()) {
        headers.insert(header::CONTENT_LENGTH, val);
    }
    if req.method() == axum::http::Method::HEAD {
        return Ok((StatusCode::OK, headers, Body::empty()).into_response());
    }
    
    let file = File::open(decoded_path).await?;
    let stream = ReaderStream::new(file);
    Ok((StatusCode::OK, headers, Body::from_stream(stream)).into_response())
}

async fn send_artwork(
    State(state): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Result<impl IntoResponse, AppError> {
    let id = valid_id(&id)?;
    let track = get_track_or_throw(&state, &id).await?;
    if !track.has_artwork {
        return Err(AppError::Http {
            status: StatusCode::NOT_FOUND,
            message: "Artwork not found.".to_string(),
            detail: None,
        });
    }

    if let Err(e) = fs::metadata(&track.path).await {
        return Err(AppError::Http {
            status: StatusCode::NOT_FOUND,
            message: "Track file could not be opened.".to_string(),
            detail: Some(e.to_string()),
        });
    }

    let mut hasher = Sha1::new();
    let basis = format!("{}", track.modified_at.unwrap_or(0).max(track.size.unwrap_or(0)));
    hasher.update(basis.as_bytes());
    let etag = format!("\"{}-{}\"", track.id, &hasher.digest().to_string()[0..12]);

    if let Some(if_none_match) = req.headers().get(header::IF_NONE_MATCH) {
        if if_none_match.to_str().unwrap_or("") == etag {
            return Ok(StatusCode::NOT_MODIFIED.into_response());
        }
    }

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=86400, stale-while-revalidate=604800"));
    if let Ok(val) = HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, val);
    }

    if req.method() == axum::http::Method::HEAD {
        return Ok((StatusCode::OK, headers, Body::empty()).into_response());
    }

    let mut child = Command::new(&state.config.ffmpeg_path)
        .args([
            "-hide_banner", "-loglevel", "error", "-nostdin",
            "-i", &track.path,
            "-an", "-map", "0:v:0", "-frames:v", "1", "-vcodec", "mjpeg",
            "-f", "image2pipe", "pipe:1"
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::Media {
            message: "Failed to spawn ffmpeg for artwork".to_string(),
            exit_code: None,
            stderr: e.to_string(),
        })?;

    let stdout = child.stdout.take().ok_or_else(|| AppError::Media {
        message: "Failed to capture ffmpeg stdout".to_string(),
        exit_code: None,
        stderr: String::new(),
    })?;
    let stream = ReaderStream::new(stdout);
    let body = Body::from_stream(stream);

    Ok((StatusCode::OK, headers, body).into_response())
}
