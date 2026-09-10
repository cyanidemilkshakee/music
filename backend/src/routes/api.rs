use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use std::path::PathBuf;
use tokio::task::spawn_blocking;
use validator::Validate;

use super::AppState;
use crate::db;
use crate::error::AppError;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(get_health))
        .route("/state", get(get_state))
        .route("/stats", get(get_stats))
        .route("/cache/clear", post(clear_cache))
        .route("/recent", get(get_recent))
        .route("/recent/{id}", post(add_recent))
        .route("/scan", post(scan_directory))
        .route("/scan/{id}/stream", get(scan_stream))
        .route("/metadata/{id}", post(extract_metadata))
        .route("/playlists", post(create_playlist))
        .route("/playlists/{id}", patch(update_playlist))
        .route("/playlists/{id}", delete(delete_playlist))
        .route("/playlists/{id}/tracks", post(add_track_to_playlist))
        .route("/playlists/{id}/tracks/{track_id}", delete(remove_track_from_playlist))
}

async fn get_health(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let pool = state.pool.clone();
    let db_health = spawn_blocking(move || {
        let conn = pool.get()?;
        db::get_health(&conn)
    }).await??;

    let ffmpeg_v = tokio::time::timeout(
        std::time::Duration::from_millis(state.config.ffprobe_timeout_ms),
        tokio::process::Command::new(&state.config.ffmpeg_path).arg("-version").output()
    ).await;
    
    let ffprobe_v = tokio::time::timeout(
        std::time::Duration::from_millis(state.config.ffprobe_timeout_ms),
        tokio::process::Command::new(&state.config.ffprobe_path).arg("-version").output()
    ).await;

    let get_ver = |res: std::result::Result<std::io::Result<std::process::Output>, tokio::time::error::Elapsed>| {
        match res {
            Ok(Ok(out)) if out.status.success() => {
                let s = String::from_utf8_lossy(&out.stdout).to_string();
                (true, s.lines().next().unwrap_or("").to_string())
            }
            Ok(Ok(out)) => (false, String::from_utf8_lossy(&out.stderr).to_string()),
            Ok(Err(e)) => (false, e.to_string()),
            Err(e) => (false, e.to_string()),
        }
    };

    let (ffmpeg_ok, ffmpeg_str) = get_ver(ffmpeg_v);
    let (ffprobe_ok, ffprobe_str) = get_ver(ffprobe_v);

    let all_ok = ffmpeg_ok && ffprobe_ok && db_health.ok;

    let json = serde_json::json!({
        "ok": all_ok,
        "ffmpeg": ffmpeg_str,
        "ffprobe": ffprobe_str,
        "database": db_health,
        "uptime": 0 // TODO if we want true uptime
    });

    if all_ok {
        Ok((StatusCode::OK, Json(json)))
    } else {
        Ok((StatusCode::SERVICE_UNAVAILABLE, Json(json)))
    }
}

async fn get_state(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let pool = state.pool.clone();
    let (tracks, playlists) = spawn_blocking(move || {
        let conn = pool.get()?;
        let t = db::get_all_tracks(&conn)?;
        let p = db::get_all_playlists(&conn)?;
        Ok::<_, AppError>((t, p))
    }).await??;

    Ok(Json(serde_json::json!({
        "tracks": tracks,
        "playlists": playlists
    })))
}

async fn get_stats(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let pool = state.pool.clone();
    let stats = spawn_blocking(move || {
        let conn = pool.get()?;
        db::get_stats(&conn)
    }).await??;

    Ok(Json(stats))
}

async fn clear_cache(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let (removed, bytes) = state.ffmpeg.clear_audio_cache().await?;
    Ok(Json(serde_json::json!({
        "removed": removed,
        "bytes": bytes
    })))
}

async fn get_recent(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let pool = state.pool.clone();
    let recent_tracks = spawn_blocking(move || {
        let conn = pool.get()?;
        let ids = db::get_recent_ids(&conn)?;
        let mut tracks = Vec::new();
        for id in ids.iter().take(20) {
            if let Some(t) = db::get_track_by_id(&conn, id)? {
                tracks.push(t);
            }
        }
        Ok::<_, AppError>(tracks)
    }).await??;

    Ok(Json(serde_json::json!({
        "recentTracks": recent_tracks
    })))
}

#[derive(Deserialize, Validate)]
struct IdParam {
    #[validate(length(min = 1, max = 200))]
    id: String,
}

fn valid_id(id: &str) -> Result<String, AppError> {
    let param = IdParam { id: id.to_string() };
    param.validate()?;
    Ok(id.to_string())
}

async fn add_recent(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let id = valid_id(&id)?;
    let pool = state.pool.clone();
    let recent_ids = spawn_blocking(move || {
        let mut conn = pool.get()?;
        db::add_recent(&mut conn, &id)?;
        db::get_recent_ids(&conn)
    }).await??;

    Ok(Json(serde_json::json!({
        "recentIds": recent_ids
    })))
}

#[derive(Deserialize, Validate)]
struct ScanReq {
    #[validate(length(min = 1, max = 4096))]
    directory: String,
}

use axum::response::sse::{Event, Sse};
use futures_util::stream::{self, Stream, StreamExt};
use std::convert::Infallible;

async fn scan_directory(
    State(state): State<AppState>,
    Json(payload): Json<ScanReq>,
) -> Result<impl IntoResponse, AppError> {
    payload.validate()?;
    let path = PathBuf::from(payload.directory);
    let job_id = state.scanner.start_scan(path).await?;
    Ok((StatusCode::ACCEPTED, Json(serde_json::json!({ "jobId": job_id }))))
}

async fn scan_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let active_scan = state.scanner.get_active_scan().await;
    
        let active = match active_scan {
            Some(s) if s.job_id == id => s,
            _ => {
                return Err(AppError::Http {
                    status: StatusCode::NOT_FOUND,
                    message: "No active scan found for this Job ID. The scan may have already completed or the ID is invalid.".to_string(),
                    detail: None,
                });
            }
        };

    let rx = active.tx.subscribe();
    // Subscribe before taking the replay snapshot so an event cannot be lost
    // between those two steps. An event in both sources is harmless to clients
    // and is preferable to missing a terminal event.
    let history_snapshot = active.history.lock().await.clone();
    let history_has_terminal_event = history_snapshot.iter().any(|event| {
        matches!(event, crate::services::scanner::ScanEvent::Complete(_) | crate::services::scanner::ScanEvent::Failed { .. })
    });

    // Build a stream that first replays all past events, then follows live ones
    let history_stream = stream::iter(history_snapshot)
        .map(|event| {
            let json = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
            Ok::<_, Infallible>(Event::default().data(json))
        });

    let live_stream = stream::unfold(Some(rx), |rx| async move {
        let mut rx = rx?;
        match rx.recv().await {
            Ok(event) => {
                let json = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
                let finished = matches!(event, crate::services::scanner::ScanEvent::Complete(_) | crate::services::scanner::ScanEvent::Failed { .. });
                Some((Ok(Event::default().data(json)), (!finished).then_some(rx)))
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => None,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                // Skip lagged messages and continue
                Some((Ok(Event::default().data("{}")), Some(rx)))
            }
        }
    });

    let combined = if history_has_terminal_event {
        history_stream.chain(stream::empty()).boxed()
    } else {
        history_stream.chain(live_stream).boxed()
    };
    Ok(Sse::new(combined).keep_alive(axum::response::sse::KeepAlive::new()))
}

async fn extract_metadata(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let id = valid_id(&id)?;
    let track = state.scanner.extract_single_track_metadata(&id).await?;
    Ok(Json(serde_json::json!({ "track": track })))
}

#[derive(Deserialize, Validate)]
struct PlaylistReq {
    #[validate(length(max = 120))]
    name: Option<String>,
    track_ids: Option<Vec<String>>,
}

fn normalize_playlist_name(name: Option<String>) -> String {
    let name = name.unwrap_or_else(|| "Untitled Playlist".to_string());
    let trimmed = name.replace("  ", " ").trim().to_string();
    if trimmed.is_empty() {
        "Untitled Playlist".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

async fn create_playlist(
    State(state): State<AppState>,
    Json(payload): Json<PlaylistReq>,
) -> Result<impl IntoResponse, AppError> {
    payload.validate()?;
    let name = normalize_playlist_name(payload.name);
    let track_ids = payload.track_ids.unwrap_or_default()
        .into_iter().take(1000).collect::<Vec<_>>(); // cap at 1000 like JS uniqueTrackIds limits

    let p = db::Playlist {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        created_at: String::new(),
        updated_at: String::new(),
        track_ids,
    };

    let pool = state.pool.clone();
    let (playlist, playlists) = spawn_blocking(move || {
        let mut conn = pool.get()?;
        let playlist = db::create_playlist(&mut conn, p)?;
        let playlists = db::get_all_playlists(&conn)?;
        Ok::<_, AppError>((playlist, playlists))
    }).await??;

    Ok((StatusCode::CREATED, Json(serde_json::json!({
        "playlist": playlist,
        "playlists": playlists
    }))))
}

async fn update_playlist(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<PlaylistReq>,
) -> Result<impl IntoResponse, AppError> {
    let id = valid_id(&id)?;
    payload.validate()?;
    let name = normalize_playlist_name(payload.name);

    let pool = state.pool.clone();
    let (playlist, playlists) = spawn_blocking(move || {
        let mut conn = pool.get()?;
        let playlist = db::update_playlist_name(&mut conn, &id, &name)?;
        let playlists = db::get_all_playlists(&conn)?;
        Ok::<_, AppError>((playlist, playlists))
    }).await??;

    if let Some(playlist) = playlist {
        Ok(Json(serde_json::json!({ "playlist": playlist, "playlists": playlists })))
    } else {
        Err(AppError::Http {
            status: StatusCode::NOT_FOUND,
            message: "Playlist not found.".to_string(),
            detail: None,
        })
    }
}

async fn delete_playlist(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let id = valid_id(&id)?;
    let pool = state.pool.clone();
    let playlists = spawn_blocking(move || {
        let mut conn = pool.get()?;
        if !db::delete_playlist(&mut conn, &id)? {
            return Err(AppError::Http {
                status: StatusCode::NOT_FOUND,
                message: "Playlist not found.".to_string(),
                detail: None,
            });
        }
        db::get_all_playlists(&conn)
    }).await??;

    Ok(Json(serde_json::json!({ "playlists": playlists })))
}

#[derive(Deserialize)]
struct TrackReq {
    #[serde(rename = "trackId")]
    track_id: Option<String>,
}

async fn add_track_to_playlist(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<TrackReq>,
) -> Result<impl IntoResponse, AppError> {
    let id = valid_id(&id)?;
    let track_id = valid_id(&payload.track_id.unwrap_or_default())?;

    let pool = state.pool.clone();
    let (playlist, playlists) = spawn_blocking(move || {
        let mut conn = pool.get()?;
        let playlist = db::add_track_to_playlist(&mut conn, &id, &track_id)?;
        if playlist.is_none() {
            return Err(AppError::Http {
                status: StatusCode::NOT_FOUND,
                message: "Playlist or track not found.".to_string(),
                detail: None,
            });
        }
        let playlists = db::get_all_playlists(&conn)?;
        Ok::<_, AppError>((playlist, playlists))
    }).await??;

    Ok(Json(serde_json::json!({ "playlist": playlist, "playlists": playlists })))
}

async fn remove_track_from_playlist(
    State(state): State<AppState>,
    Path((id, track_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let id = valid_id(&id)?;
    let track_id = valid_id(&track_id)?;

    let pool = state.pool.clone();
    let (playlist, playlists) = spawn_blocking(move || {
        let mut conn = pool.get()?;
        let playlist = db::remove_track_from_playlist(&mut conn, &id, &track_id)?;
        if playlist.is_none() {
            return Err(AppError::Http {
                status: StatusCode::NOT_FOUND,
                message: "Playlist not found.".to_string(),
                detail: None,
            });
        }
        let playlists = db::get_all_playlists(&conn)?;
        Ok::<_, AppError>((playlist, playlists))
    }).await??;

    Ok(Json(serde_json::json!({ "playlist": playlist, "playlists": playlists })))
}
