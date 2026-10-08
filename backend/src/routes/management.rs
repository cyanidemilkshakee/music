use super::{json::ApiJson, AppState};
use crate::{db, error::AppError};
use axum::{
    extract::{Path, Query, State},
    routing::{get, post, put},
    Json, Router,
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tokio::task::spawn_blocking;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/session", get(session))
        .route("/shutdown", post(shutdown))
        .route("/scan/status", get(scan_status))
        .route("/scan/{id}", get(scan_job))
        .route("/scan/{id}/cancel", post(cancel_scan))
        .route("/tracks/{id}", get(track_details).delete(delete_track))
        .route("/favorites/{id}", put(favorite).delete(unfavorite))
        .route("/tracks/{id}/playlists", put(memberships))
        .route("/playlists/{id}/tracks", put(playlist_order))
        .route("/backup", get(backup))
        .route("/backup/restore", post(restore))
        .route("/library/tracks", get(library_page))
        .route("/library/tracks/lookup", post(library_lookup))
        .route("/playlists/{id}/m3u", get(export_m3u))
        .route("/playlists/import", post(import_m3u))
}
async fn session(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"app":"LocalAmp","version":env!("CARGO_PKG_VERSION"),"processId":std::process::id(),"token":state.session_token.as_str()}),
    )
}
async fn shutdown(State(state): State<AppState>) -> Json<serde_json::Value> {
    state.shutdown.cancel();
    Json(serde_json::json!({"stopping":true}))
}
async fn scan_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    let scan = state.scanner.get_active_scan().await;
    let value = if let Some(scan) = scan {
        serde_json::json!({"jobId":scan.job_id,"finished":scan.is_done.load(std::sync::atomic::Ordering::SeqCst),"event":scan.history.lock().await.last()})
    } else {
        serde_json::Value::Null
    };
    Json(serde_json::json!({"scan":value}))
}
async fn scan_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let scan = state.scanner.get_scan(&id).await?;
    let value = serde_json::json!({"jobId":id,"event":scan.history.lock().await.last(),"finished":scan.is_done.load(std::sync::atomic::Ordering::SeqCst)});
    Ok(Json(value))
}
async fn cancel_scan(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    state.scanner.cancel_job(&id).await?;
    Ok(Json(serde_json::json!({"canceled":true})))
}
async fn track_details(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let pool = state.pool;
    let track = spawn_blocking(move || {
        let conn = pool.get()?;
        db::get_track_by_id(&conn, &id)
    })
    .await??
    .ok_or_else(|| AppError::not_found("Track not found."))?;
    Ok(Json(serde_json::json!({"track":track})))
}
async fn delete_track(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let pool = state.pool;
    spawn_blocking(move || {
        let conn = pool.get()?;
        db::reliability::require_track(&conn, &id)?;
        conn.execute("DELETE FROM tracks WHERE id=?", [id])?;
        Ok::<_, AppError>(())
    })
    .await??;
    Ok(Json(serde_json::json!({"deleted":true})))
}
async fn favorite(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    change_favorite(state, id, true).await
}
async fn unfavorite(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    change_favorite(state, id, false).await
}
async fn change_favorite(
    state: AppState,
    id: String,
    value: bool,
) -> Result<Json<serde_json::Value>, AppError> {
    let pool = state.pool;
    let favorites = spawn_blocking(move || {
        let conn = pool.get()?;
        db::reliability::set_favorite(&conn, &id, value)?;
        db::reliability::favorites(&conn)
    })
    .await??;
    Ok(Json(serde_json::json!({"favorites":favorites})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ids {
    #[serde(default)]
    track_ids: Vec<String>,
    #[serde(default)]
    playlist_ids: Vec<String>,
}
fn validate_ids(ids: &[String]) -> Result<(), AppError> {
    if ids.len() > 10000 || ids.iter().any(|id| id.is_empty() || id.len() > 200) {
        return Err(AppError::bad_request(
            "Invalid IDs or too many items (maximum 10000).",
        ));
    }
    Ok(())
}
async fn memberships(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(payload): ApiJson<Ids>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_ids(&payload.playlist_ids)?;
    let pool = state.pool;
    let playlists = spawn_blocking(move || {
        let mut conn = pool.get()?;
        db::reliability::set_memberships(&mut conn, &id, &payload.playlist_ids)?;
        db::get_all_playlists(&conn)
    })
    .await??;
    Ok(Json(serde_json::json!({"playlists":playlists})))
}
async fn playlist_order(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(payload): ApiJson<Ids>,
) -> Result<Json<serde_json::Value>, AppError> {
    validate_ids(&payload.track_ids)?;
    let pool = state.pool;
    let playlists = spawn_blocking(move || {
        let mut conn = pool.get()?;
        db::reliability::replace_playlist_tracks(&mut conn, &id, &payload.track_ids)?;
        db::get_all_playlists(&conn)
    })
    .await??;
    Ok(Json(serde_json::json!({"playlists":playlists})))
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Backup {
    version: u32,
    playlists: Vec<db::Playlist>,
    favorites: Vec<String>,
    #[serde(default)]
    tracks: Vec<db::Track>,
    #[serde(default)]
    sources: Vec<db::sources::LibrarySource>,
    #[serde(default)]
    recent: Vec<String>,
}
async fn backup(State(state): State<AppState>) -> Result<Json<Backup>, AppError> {
    let pool = state.pool;
    let backup = spawn_blocking(move || {
        let conn = pool.get()?;
        Ok::<_, AppError>(Backup {
            version: 1,
            playlists: db::get_all_playlists(&conn)?,
            favorites: db::reliability::favorites(&conn)?,
            tracks: db::reliability::scan_inventory(&conn)?
                .into_iter()
                .map(|(track, _)| track)
                .collect(),
            sources: db::get_library_sources(&conn)?,
            recent: db::get_recent_ids(&conn)?,
        })
    })
    .await??;
    Ok(Json(backup))
}
async fn restore(
    State(state): State<AppState>,
    ApiJson(payload): ApiJson<Backup>,
) -> Result<Json<serde_json::Value>, AppError> {
    if payload.version != 1
        || payload.playlists.len() > 1000
        || payload.tracks.len() > 1_000_000
        || payload.sources.len() > 10000
    {
        return Err(AppError::bad_request(
            "Unsupported backup or too many playlists.",
        ));
    }
    validate_ids(&payload.favorites)?;
    for playlist in &payload.playlists {
        validate_ids(&playlist.track_ids)?;
        if playlist.name.trim().is_empty()
            || playlist.name.chars().count() > 120
            || playlist.id.is_empty()
            || playlist.id.len() > 200
        {
            return Err(AppError::bad_request("Invalid playlist in backup."));
        }
    }
    let pool = state.pool;
    let value=spawn_blocking(move || {
        let mut conn=pool.get()?;let tx=conn.transaction()?;
        let mut id_map=std::collections::HashMap::new();
        for mut track in payload.tracks {
            if !std::path::Path::new(&track.path).is_absolute() || track.id.is_empty() || track.id.len()>200 || track.path.len()>32768 || !track.duration.is_finite() || track.duration<0.0 {return Err(AppError::bad_request("Invalid track in backup."));}
            let existing:Option<String>=tx.query_row("SELECT id FROM tracks WHERE path=?",[&track.path],|r|r.get(0)).optional()?;
            let old_id=track.id.clone();
            if let Some(id)=existing {track.id=id;}
            else if tx.prepare("SELECT 1 FROM tracks WHERE id=?")?.exists([&track.id])? {track.id=uuid::Uuid::new_v4().to_string();}
            id_map.insert(old_id,track.id.clone());
            db::upsert_tracks(&tx,std::slice::from_ref(&track))?;
            tx.execute("UPDATE tracks SET available=? WHERE id=?",rusqlite::params![std::path::Path::new(&track.path).is_file(),track.id])?;
        }
        for source in payload.sources {
            if !std::path::Path::new(&source.path).is_absolute() || source.path.len()>32768 {return Err(AppError::bad_request("Invalid source in backup."));}
            tx.execute("INSERT INTO library_sources VALUES (?,?,?,?) ON CONFLICT(path) DO NOTHING",rusqlite::params![uuid::Uuid::new_v4().to_string(),source.path,source.added_at,source.last_scanned_at])?;
        }
        // Restore is an atomic merge. Existing playlists and library files survive.
        let mut skipped=0;let mut imported=0;
        for playlist in payload.playlists {
            if tx.prepare("SELECT 1 FROM playlists WHERE id=?")?.exists([&playlist.id])? {skipped+=1;continue;}
            tx.execute("INSERT INTO playlists VALUES (?,?,?,?)",rusqlite::params![playlist.id,playlist.name,playlist.created_at,playlist.updated_at])?;
            let mut seen=std::collections::HashSet::new();
            for (pos,old_id) in playlist.track_ids.into_iter().enumerate() {
                let id=id_map.get(&old_id).cloned().unwrap_or(old_id);
                if db::reliability::require_track(&tx,&id).is_err() {skipped+=1;continue;}
                if seen.insert(id.clone()) {tx.execute("INSERT INTO playlist_tracks VALUES (?,?,?)",rusqlite::params![playlist.id,id,pos as i64])?;}
            }imported+=1;
        }
        for old_id in payload.favorites {let id=id_map.get(&old_id).cloned().unwrap_or(old_id);if db::reliability::require_track(&tx,&id).is_ok() {tx.execute("INSERT OR IGNORE INTO favorites VALUES (?)",[id])?;}else {skipped+=1;}}
        for old_id in payload.recent.into_iter().take(50).rev() {
            let id=id_map.get(&old_id).cloned().unwrap_or(old_id);
            if db::reliability::require_track(&tx,&id).is_ok() {
                tx.execute("DELETE FROM recent WHERE trackId=?",[&id])?;
                tx.execute("INSERT INTO recent(trackId,playedAt) VALUES (?,?)",rusqlite::params![id,chrono::Utc::now().timestamp_millis()])?;
            }
        }
        tx.commit()?;Ok::<_,AppError>(serde_json::json!({"imported":imported,"skipped":skipped,"playlists":db::get_all_playlists(&conn)?,"favorites":db::reliability::favorites(&conn)?}))
    }).await??;
    Ok(Json(value))
}
async fn library_page(
    State(state): State<AppState>,
    query: Result<Query<db::library_query::LibraryQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<serde_json::Value>, AppError> {
    let Query(query) =
        query.map_err(|_| AppError::bad_request("Invalid library query parameters."))?;
    query.validate()?;
    let pool = state.pool;
    let value = spawn_blocking(move || {
        let conn = pool.get()?;
        db::library_query::query(&conn, &query)
    })
    .await??;
    Ok(Json(value))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Lookup {
    ids: Vec<String>,
}
async fn library_lookup(
    State(state): State<AppState>,
    ApiJson(payload): ApiJson<Lookup>,
) -> Result<Json<serde_json::Value>, AppError> {
    if payload.ids.len() > 1000 || payload.ids.iter().any(|id| id.is_empty() || id.len() > 200) {
        return Err(AppError::bad_request(
            "Supply at most 1000 valid track IDs.",
        ));
    }
    let tracks = spawn_blocking(move || {
        let conn = state.pool.get()?;
        db::library_query::lookup(&conn, &payload.ids)
    })
    .await??;
    Ok(Json(serde_json::json!({"tracks":tracks})))
}

pub const M3U_TEXT_BYTES: usize = 2 * 1024 * 1024;

async fn export_m3u(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let pool = state.pool;
    let text = spawn_blocking(move || {
        let conn = pool.get()?;
        let playlist = db::get_playlist_by_id(&conn, &id)?
            .ok_or_else(|| AppError::not_found("Playlist not found."))?;
        let mut text = String::from("#EXTM3U\n");
        for id in playlist.track_ids {
            if let Some(track) = db::get_track_by_id(&conn, &id)? {
                text.push_str(&format!(
                    "#EXTINF:{},{}\n{}\n",
                    track.duration.round(),
                    track.title.unwrap_or_default().replace(['\r', '\n'], " "),
                    track.path.replace(['\r', '\n'], "")
                ));
            }
        }
        Ok::<_, AppError>(text)
    })
    .await??;
    Ok((
        [
            (
                axum::http::header::CONTENT_TYPE,
                "audio/x-mpegurl; charset=utf-8",
            ),
            (
                axum::http::header::CONTENT_DISPOSITION,
                "attachment; filename=playlist.m3u",
            ),
        ],
        text,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct M3uRequest {
    name: String,
    text: String,
}
async fn import_m3u(
    State(state): State<AppState>,
    ApiJson(payload): ApiJson<M3uRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    if payload.name.trim().is_empty()
        || payload.name.chars().count() > 120
        || payload.text.len() > M3U_TEXT_BYTES
    {
        return Err(AppError::bad_request(
            "M3U name must be 1 to 120 characters and file at most 2 MB.",
        ));
    }
    let pool = state.pool;
    let value=spawn_blocking(move || {
        let mut conn=pool.get()?;
        let tracks=db::reliability::scan_inventory(&conn)?;
        let normalize=|path:&str| if cfg!(windows) {path.replace('/',"\\").to_lowercase()}else{path.to_owned()};
        let by_path:std::collections::HashMap<_,_>=tracks.iter().map(|(t,_)|(normalize(&t.path),t.id.clone())).collect();
        let mut ids=Vec::new();let mut seen=std::collections::HashSet::new();let mut skipped=0;
        for path in payload.text.trim_start_matches('\u{feff}').lines().map(str::trim).filter(|s|!s.is_empty() && !s.starts_with('#')) {
            if let Some(id)=by_path.get(&normalize(path)) {if seen.insert(id.clone()) {ids.push(id.clone());}}
            else {skipped+=1;}
        }
        if ids.len()>10000 {return Err(AppError::bad_request("Playlist exceeds 10000 tracks."));}
        let playlist=db::create_playlist(&mut conn,db::Playlist {id:uuid::Uuid::new_v4().to_string(),name:payload.name.trim().into(),created_at:String::new(),updated_at:String::new(),track_ids:ids})?;
        Ok::<_,AppError>(serde_json::json!({"playlist":playlist,"playlists":db::get_all_playlists(&conn)?,"skipped":skipped}))
    }).await??;
    Ok(Json(value))
}
