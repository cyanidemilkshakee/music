use super::json::ApiJson;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use std::path::PathBuf;
use tokio::task::spawn_blocking;

use super::AppState;
use crate::db;
use crate::error::AppError;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(get_health))
        .route("/state", get(get_state))
        .route("/stats", get(get_stats))
        .route("/cache/clear", post(clear_cache))
        .route("/cache", get(cache_usage))
        .route("/recent", get(get_recent))
        .route("/recent/{id}", post(add_recent))
        .route("/scan", post(scan_directory))
        .route("/scan/{id}/stream", get(scan_stream))
        .route("/metadata/{id}", post(extract_metadata))
        .route("/playlists", post(create_playlist))
        .route("/playlists/{id}", patch(update_playlist))
        .route("/playlists/{id}", delete(delete_playlist))
        .route("/playlists/{id}/tracks", post(add_track_to_playlist))
        .route(
            "/playlists/{id}/tracks/{track_id}",
            delete(remove_track_from_playlist),
        )
}

async fn get_health(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let pool = state.pool.clone();
    let db_health = spawn_blocking(move || {
        let conn = pool.get()?;
        db::get_health(&conn)
    })
    .await??;

    let tools = state.ffmpeg.tool_health().await;
    let ffmpeg_ok = tools["ffmpeg"]["ok"] == true;
    let ffprobe_ok = tools["ffprobe"]["ok"] == true;
    let ffmpeg_str = tools["ffmpeg"].clone();
    let ffprobe_str = tools["ffprobe"].clone();
    let all_ok = ffmpeg_ok && ffprobe_ok && db_health.ok;

    let json = serde_json::json!({
        "ok": all_ok,
        "checks": {
            "database": db_health.ok,
            "ffmpeg": ffmpeg_ok,
            "ffprobe": ffprobe_ok
        },
        "ffmpeg": ffmpeg_str,
        "ffprobe": ffprobe_str,
        "database": db_health,
        "uptime": state.started_at.elapsed().as_secs(),
        "limits": {
            "jsonLimitBytes": state.config.json_limit_bytes,
            "m3uTextBytes": super::management::M3U_TEXT_BYTES
        }
    });

    if all_ok {
        Ok((StatusCode::OK, Json(json)))
    } else {
        Ok((StatusCode::SERVICE_UNAVAILABLE, Json(json)))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateQuery {
    #[serde(default = "include_tracks")]
    include_tracks: bool,
}
fn include_tracks() -> bool {
    true
}

async fn get_state(
    State(state): State<AppState>,
    query: Result<Query<StateQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<impl IntoResponse, AppError> {
    let Query(query) =
        query.map_err(|_| AppError::bad_request("Invalid state query parameters."))?;
    let pool = state.pool.clone();
    let value = spawn_blocking(move || {
        let conn = pool.get()?;
        let transaction = conn.unchecked_transaction()?;
        let tracks = if query.include_tracks {
            db::get_library_tracks(&transaction)?
        } else {
            Vec::new()
        };
        let value = serde_json::json!({
            "tracks": tracks,
            "trackIds": db::library_query::all_ids(&transaction)?,
            "playlists": db::get_all_playlists(&transaction)?,
            "favorites": db::reliability::favorites(&transaction)?,
            "recentIds": db::get_recent_ids(&transaction)?,
            "facets": db::library_query::facets(&transaction)?
        });
        transaction.commit()?;
        Ok::<_, AppError>(value)
    })
    .await??;
    Ok(Json(value))
}

async fn get_stats(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let pool = state.pool.clone();
    let stats = spawn_blocking(move || {
        let conn = pool.get()?;
        db::get_stats(&conn)
    })
    .await??;

    Ok(Json(stats))
}

async fn clear_cache(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let (removed, bytes) = state.ffmpeg.clear_audio_cache().await?;
    Ok(Json(serde_json::json!({
        "removed": removed,
        "bytes": bytes
    })))
}
async fn cache_usage(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let (files, bytes) = state.ffmpeg.cache_usage().await?;
    Ok(Json(
        serde_json::json!({"files":files,"bytes":bytes,"maxBytes":state.config.cache_max_bytes}),
    ))
}

async fn get_recent(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let pool = state.pool.clone();
    let recent_tracks = spawn_blocking(move || {
        let conn = pool.get()?;
        db::get_recent_tracks(&conn)
    })
    .await??;

    Ok(Json(serde_json::json!({
        "recentTracks": recent_tracks
    })))
}

fn valid_id(id: &str) -> Result<String, AppError> {
    if id.is_empty() || id.len() > 200 {
        return Err(AppError::bad_request("Invalid ID."));
    }
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
        if !db::add_recent(&mut conn, &id)? {
            return Err(AppError::not_found("Track not found."));
        }
        db::get_recent_ids(&conn)
    })
    .await??;

    Ok(Json(serde_json::json!({
        "recentIds": recent_ids
    })))
}

#[derive(Deserialize)]
struct ScanReq {
    directory: String,
}

use axum::response::sse::{Event, Sse};
use futures_util::stream::{self, Stream, StreamExt};
use std::convert::Infallible;

async fn scan_directory(
    State(state): State<AppState>,
    ApiJson(payload): ApiJson<ScanReq>,
) -> Result<impl IntoResponse, AppError> {
    if payload.directory.trim().is_empty() || payload.directory.len() > 4096 {
        return Err(AppError::bad_request(
            "Enter a folder path of at most 4096 characters.",
        ));
    }
    let path = PathBuf::from(payload.directory);
    let job_id = state.scanner.start_scan(path).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "jobId": job_id })),
    ))
}

async fn scan_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let active = state.scanner.get_scan(&id).await?;
    let rx = active.tx.subscribe();
    let snapshot = active.history.lock().await.clone();
    let replay = stream::iter(snapshot.clone())
        .map(|event| Ok(Event::default().data(serde_json::to_string(&event).unwrap_or_default())));
    let terminal = snapshot.iter().any(|event| event.terminal());
    let live = stream::unfold(
        (active, rx, false),
        |(active, mut rx, finished)| async move {
            if finished {
                return None;
            }
            let event = loop {
                tokio::select! {
                    result = rx.recv() => match result {
                        Ok(event) => break event,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            if let Some(event)=active.history.lock().await.last().cloned() { break event; }
                        },
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                    },
                    _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {
                        if active.is_done.load(std::sync::atomic::Ordering::SeqCst) {
                            if let Some(event)=active.history.lock().await.last().cloned() { break event; }
                            return None;
                        }
                    }
                }
            };
            let done = event.terminal();
            Some((
                Ok(Event::default().data(serde_json::to_string(&event).unwrap_or_default())),
                (active, rx, done),
            ))
        },
    );
    let combined = if terminal {
        replay.chain(stream::empty()).boxed()
    } else {
        replay.chain(live).boxed()
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlaylistReq {
    name: Option<String>,
}

fn normalize_playlist_name(name: Option<String>) -> String {
    let name = name.unwrap_or_else(|| "Untitled Playlist".to_string());
    let trimmed = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        "Untitled Playlist".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

async fn create_playlist(
    State(state): State<AppState>,
    ApiJson(payload): ApiJson<PlaylistReq>,
) -> Result<impl IntoResponse, AppError> {
    if payload
        .name
        .as_ref()
        .is_some_and(|name| name.chars().count() > 120)
    {
        return Err(AppError::bad_request(
            "Playlist name must be at most 120 characters.",
        ));
    }
    let name = normalize_playlist_name(payload.name);

    let p = db::Playlist {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        created_at: String::new(),
        updated_at: String::new(),
        track_ids: Vec::new(),
    };

    let pool = state.pool.clone();
    let (playlist, playlists) = spawn_blocking(move || {
        let mut conn = pool.get()?;
        let playlist = db::create_playlist(&mut conn, p)?;
        let playlists = db::get_all_playlists(&conn)?;
        Ok::<_, AppError>((playlist, playlists))
    })
    .await??;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({
            "playlist": playlist,
            "playlists": playlists
        })),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameReq {
    name: String,
}

async fn update_playlist(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(payload): ApiJson<RenameReq>,
) -> Result<impl IntoResponse, AppError> {
    let id = valid_id(&id)?;
    if payload.name.trim().is_empty() || payload.name.chars().count() > 120 {
        return Err(AppError::bad_request(
            "A playlist name of 1 to 120 characters is required.",
        ));
    }
    let name = normalize_playlist_name(Some(payload.name));

    let pool = state.pool.clone();
    let (playlist, playlists) = spawn_blocking(move || {
        let mut conn = pool.get()?;
        let playlist = db::update_playlist_name(&mut conn, &id, &name)?;
        let playlists = db::get_all_playlists(&conn)?;
        Ok::<_, AppError>((playlist, playlists))
    })
    .await??;

    if let Some(playlist) = playlist {
        Ok(Json(
            serde_json::json!({ "playlist": playlist, "playlists": playlists }),
        ))
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
    })
    .await??;

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
    ApiJson(payload): ApiJson<TrackReq>,
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
    })
    .await??;

    Ok(Json(
        serde_json::json!({ "playlist": playlist, "playlists": playlists }),
    ))
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
    })
    .await??;

    Ok(Json(
        serde_json::json!({ "playlist": playlist, "playlists": playlists }),
    ))
}
