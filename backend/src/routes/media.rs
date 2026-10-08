use super::{json::ApiJson, AppState};
use crate::{
    db::{self, Track},
    error::AppError,
};
use axum::{
    body::Body,
    extract::{Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt},
    task::spawn_blocking,
};
use tokio_util::io::ReaderStream;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/decode/{id}", post(decode_track))
        .route("/original/{id}", get(send_original).head(send_original))
        .route("/audio/{id}", get(send_audio).head(send_audio))
        .route("/artwork/{id}", get(send_artwork).head(send_artwork))
}
async fn get_track(state: &AppState, id: String) -> Result<Track, AppError> {
    if id.is_empty() || id.len() > 200 {
        return Err(AppError::bad_request("Invalid track ID."));
    }
    let pool = state.pool.clone();
    let mut track = spawn_blocking(move || {
        let conn = pool.get()?;
        db::get_track_by_id(&conn, &id)
    })
    .await??
    .ok_or_else(|| AppError::not_found("Track not found."))?;
    let meta = tokio::fs::metadata(&track.path).await.map_err(|_| {
        AppError::not_found(
            "Music file is missing or inaccessible. Reconnect the folder and rescan.",
        )
    })?;
    track.size = Some(meta.len() as i64);
    track.modified_at = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|t| t.as_millis() as i64);
    Ok(track)
}
fn original_mime(track: &Track) -> &'static str {
    match std::path::Path::new(&track.path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "m4a" | "alac" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "opus" => "audio/ogg",
        "aif" | "aiff" => "audio/aiff",
        "wma" => "audio/x-ms-wma",
        _ => "application/octet-stream",
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DecodeRequest {
    format: String,
}
async fn decode_track(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(payload): ApiJson<DecodeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let track = get_track(&state, id).await?;
    let url = match payload.format.as_str() {
        "original" => format!("/api/original/{}", urlencoding::encode(&track.id)),
        "flac" | "mp3" => {
            let path = state.ffmpeg.ensure_decoded(&track, &payload.format).await?;
            format!(
                "/api/audio/{}?format={}&v={}",
                urlencoding::encode(&track.id),
                payload.format,
                urlencoding::encode(&path.file_name().unwrap_or_default().to_string_lossy())
            )
        }
        _ => {
            return Err(AppError::bad_request(
                "Choose original, flac, or mp3 playback.",
            ))
        }
    };
    Ok(Json(
        serde_json::json!({"id":track.id,"audioUrl":url,"format":payload.format,"seekable":true}),
    ))
}
#[derive(Deserialize)]
struct CacheQuery {
    #[serde(default = "flac")]
    format: String,
}
fn flac() -> String {
    "flac".into()
}
async fn send_original(
    State(state): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Result<Response, AppError> {
    let track = get_track(&state, id).await?;
    serve_file(
        std::path::Path::new(&track.path),
        original_mime(&track),
        req,
    )
    .await
}
async fn send_audio(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<CacheQuery>,
    req: Request,
) -> Result<Response, AppError> {
    let track = get_track(&state, id).await?;
    if !matches!(query.format.as_str(), "flac" | "mp3") {
        return Err(AppError::bad_request("Invalid audio format."));
    }
    let path = state.ffmpeg.ensure_decoded(&track, &query.format).await?;
    serve_file(
        &path,
        if query.format == "mp3" {
            "audio/mpeg"
        } else {
            "audio/flac"
        },
        req,
    )
    .await
}
async fn send_artwork(
    State(state): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Result<Response, AppError> {
    let track = get_track(&state, id).await?;
    if !track.has_artwork {
        return Err(AppError::not_found("Artwork not found."));
    }
    let path = state.ffmpeg.ensure_decoded(&track, "jpg").await?;
    serve_file(&path, "image/jpeg", req).await
}
async fn serve_file(
    path: &std::path::Path,
    mime: &'static str,
    req: Request,
) -> Result<Response, AppError> {
    // Open first; metadata and bytes belong to the same file even during eviction.
    let mut file = File::open(path)
        .await
        .map_err(|_| AppError::not_found("Media file is not ready or no longer available."))?;
    let meta = file.metadata().await?;
    let size = meta.len();
    if !meta.is_file() || size == 0 {
        return Err(AppError::not_found("Media file is empty."));
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|t| t.as_nanos())
        .unwrap_or(0);
    let etag = format!("\"{size:x}-{modified:x}\"");
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&etag)
            .map_err(|_| AppError::bad_request("Invalid media version."))?,
    );
    if if_none_match_matches(req.headers().get(header::IF_NONE_MATCH), &etag) {
        return Ok((StatusCode::NOT_MODIFIED, headers, Body::empty()).into_response());
    }
    let range = if req
        .headers()
        .get(header::IF_RANGE)
        .is_none_or(|v| v.to_str().ok() == Some(etag.as_str()))
    {
        req.headers()
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok())
    } else {
        None
    };
    let (status, start, length) = match range {
        Some(value) => match parse_range(value, size) {
            Ok(range) => {
                let (start, end) = (*range.start(), *range.end());
                headers.insert(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes {start}-{end}/{size}"))
                        .map_err(|_| AppError::bad_request("Invalid range."))?,
                );
                (StatusCode::PARTIAL_CONTENT, start, end - start + 1)
            }
            Err(_) => {
                headers.insert(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes */{size}"))
                        .map_err(|_| AppError::bad_request("Invalid range."))?,
                );
                headers.insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
                return Ok(
                    (StatusCode::RANGE_NOT_SATISFIABLE, headers, Body::empty()).into_response()
                );
            }
        },
        None => (StatusCode::OK, 0, size),
    };
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string())
            .map_err(|_| AppError::bad_request("Invalid media size."))?,
    );
    if req.method() == axum::http::Method::HEAD {
        return Ok((status, headers, Body::empty()).into_response());
    }
    file.seek(std::io::SeekFrom::Start(start)).await?;
    Ok((
        status,
        headers,
        Body::from_stream(ReaderStream::new(file.take(length))),
    )
        .into_response())
}
fn parse_range(range_str: &str, size: u64) -> Result<std::ops::RangeInclusive<u64>, AppError> {
    if size == 0 || !range_str.starts_with("bytes=") {
        return Err(AppError::Http {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            message: "Invalid range".to_string(),
            detail: None,
        });
    }
    let r = &range_str[6..];
    if r.contains(',') {
        return Err(AppError::Http {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            message: "Multiple ranges not supported".to_string(),
            detail: None,
        });
    }
    let parts: Vec<&str> = r.split('-').collect();
    if parts.len() != 2 {
        return Err(AppError::Http {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            message: "Invalid range".to_string(),
            detail: None,
        });
    }
    if parts.iter().all(|part| part.trim().is_empty()) {
        return Err(AppError::Http {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            message: "Invalid range".to_string(),
            detail: None,
        });
    }
    let start_str = parts[0].trim();
    let end_str = parts[1].trim();

    if start_str.is_empty() && !end_str.is_empty() {
        let suffix: u64 = end_str.parse().map_err(|_| AppError::Http {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            message: "Invalid range".to_string(),
            detail: None,
        })?;
        if suffix == 0 {
            return Err(AppError::Http {
                status: StatusCode::RANGE_NOT_SATISFIABLE,
                message: "Invalid range".to_string(),
                detail: None,
            });
        }
        let start = size.saturating_sub(suffix);
        return Ok(start..=(size - 1));
    }

    let start: u64 = if start_str.is_empty() {
        0
    } else {
        start_str.parse().map_err(|_| AppError::Http {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            message: "Invalid range".to_string(),
            detail: None,
        })?
    };

    let end: u64 = if end_str.is_empty() {
        size - 1
    } else {
        end_str.parse().map_err(|_| AppError::Http {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            message: "Invalid range".to_string(),
            detail: None,
        })?
    };

    let end = std::cmp::min(end, size - 1);

    if start >= size || start > end {
        return Err(AppError::Http {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            message: "Range not satisfiable".to_string(),
            detail: None,
        });
    }
    Ok(start..=end)
}

fn if_none_match_matches(value: Option<&HeaderValue>, etag: &str) -> bool {
    value
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value.split(',').any(|candidate| {
                let candidate = candidate.trim();
                candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == etag
            })
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn single_ranges_cover_seek_suffix_and_invalid_inputs() {
        assert_eq!(parse_range("bytes=0-9", 100).unwrap(), 0..=9);
        assert_eq!(parse_range("bytes=90-", 100).unwrap(), 90..=99);
        assert_eq!(parse_range("bytes=-10", 100).unwrap(), 90..=99);
        assert_eq!(parse_range("bytes=-1000", 100).unwrap(), 0..=99);
        for range in [
            "bytes=100-",
            "bytes=20-10",
            "bytes=-0",
            "bytes=-",
            "bytes=0-1,3-4",
            "items=0-1",
        ] {
            assert!(parse_range(range, 100).is_err());
        }
        assert!(parse_range("bytes=-1", 0).is_err());
    }
    #[test]
    fn conditional_reads_accept_weak_validators_but_not_other_versions() {
        assert!(if_none_match_matches(
            Some(&HeaderValue::from_static("W/\"abc\", \"def\"")),
            "\"abc\""
        ));
        assert!(!if_none_match_matches(
            Some(&HeaderValue::from_static("\"xyz\"")),
            "\"abc\""
        ));
    }
}
