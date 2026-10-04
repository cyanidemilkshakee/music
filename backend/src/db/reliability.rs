use super::*;
use rusqlite::OptionalExtension;

pub fn favorites(conn: &Connection) -> Result<Vec<String>, AppError> {
    let mut stmt = conn.prepare("SELECT trackId FROM favorites ORDER BY trackId")?;
    let ids = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

pub fn set_favorite(conn: &Connection, id: &str, favorite: bool) -> Result<(), AppError> {
    require_track(conn, id)?;
    if favorite {
        conn.execute("INSERT OR IGNORE INTO favorites VALUES (?)", [id])?;
    } else {
        conn.execute("DELETE FROM favorites WHERE trackId = ?", [id])?;
    }
    Ok(())
}

pub fn require_track(conn: &Connection, id: &str) -> Result<(), AppError> {
    if !conn
        .prepare("SELECT 1 FROM tracks WHERE id = ?")?
        .exists([id])?
    {
        return Err(AppError::not_found(format!("Track {id} not found.")));
    }
    Ok(())
}

pub fn replace_playlist_tracks(
    conn: &mut Connection,
    id: &str,
    ids: &[String],
) -> Result<(), AppError> {
    let tx = conn.transaction()?;
    if !tx
        .prepare("SELECT 1 FROM playlists WHERE id = ?")?
        .exists([id])?
    {
        return Err(AppError::not_found("Playlist not found."));
    }
    let mut seen = std::collections::HashSet::new();
    for track_id in ids {
        require_track(&tx, track_id)?;
        if !seen.insert(track_id) {
            return Err(AppError::bad_request("Duplicate tracks in a playlist."));
        }
    }
    tx.execute("DELETE FROM playlist_tracks WHERE playlistId = ?", [id])?;
    for (position, track_id) in ids.iter().enumerate() {
        tx.execute(
            "INSERT INTO playlist_tracks VALUES (?, ?, ?)",
            params![id, track_id, position as i64],
        )?;
    }
    tx.execute(
        "UPDATE playlists SET updatedAt = ? WHERE id = ?",
        params![chrono::Utc::now().to_rfc3339(), id],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn set_memberships(conn: &mut Connection, track: &str, ids: &[String]) -> Result<(), AppError> {
    let tx = conn.transaction()?;
    require_track(&tx, track)?;
    let desired: std::collections::HashSet<_> = ids.iter().collect();
    for id in &desired {
        if !tx
            .prepare("SELECT 1 FROM playlists WHERE id = ?")?
            .exists([id])?
        {
            return Err(AppError::not_found("Playlist not found."));
        }
    }
    let playlists = get_all_playlists(&tx)?;
    for playlist in playlists {
        let contains = playlist.track_ids.iter().any(|id| id == track);
        let wants = desired.contains(&playlist.id);
        if contains == wants {
            continue;
        }
        if wants {
            let next: i64 = tx.query_row(
                "SELECT COALESCE(MAX(position)+1, 0) FROM playlist_tracks WHERE playlistId = ?",
                [&playlist.id],
                |r| r.get(0),
            )?;
            tx.execute(
                "INSERT INTO playlist_tracks VALUES (?, ?, ?)",
                params![playlist.id, track, next],
            )?;
        } else {
            tx.execute(
                "DELETE FROM playlist_tracks WHERE playlistId = ? AND trackId = ?",
                params![playlist.id, track],
            )?;
        }
        tx.execute(
            "UPDATE playlists SET updatedAt = ? WHERE id = ?",
            params![chrono::Utc::now().to_rfc3339(), playlist.id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn scan_inventory(conn: &Connection) -> Result<Vec<(Track, Option<String>)>, AppError> {
    let mut stmt = conn.prepare("SELECT t.*, f.fingerprint FROM tracks t LEFT JOIN track_fingerprints f ON f.trackId = t.id")?;
    let inventory = stmt
        .query_map([], |row| Ok((row_to_track(row)?, row.get("fingerprint")?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(inventory)
}

pub fn save_scan_batch(
    conn: &mut Connection,
    tracks: &[(Track, String)],
    source: &str,
    job: &str,
) -> Result<(), AppError> {
    let tx = conn.transaction()?;
    for (track, fingerprint) in tracks {
        tx.execute(
            "UPDATE tracks SET path = ?, directory = ?, fileName = ? WHERE id = ?",
            params![track.path, track.directory, track.file_name, track.id],
        )?;
        upsert_tracks(&tx, std::slice::from_ref(track))?;
        tx.execute("UPDATE tracks SET available = 1 WHERE id = ?", [&track.id])?;
        tx.execute("INSERT INTO track_fingerprints VALUES (?, ?) ON CONFLICT(trackId) DO UPDATE SET fingerprint=excluded.fingerprint", params![track.id, fingerprint])?;
        tx.execute("INSERT INTO source_tracks VALUES (?, ?, ?) ON CONFLICT(sourceId,trackId) DO UPDATE SET seenJobId=excluded.seenJobId", params![source, track.id, job])?;
    }
    tx.commit()?;
    Ok(())
}

pub fn finish_source(
    conn: &mut Connection,
    source: &str,
    job: &str,
    complete_walk: bool,
) -> Result<usize, AppError> {
    let tx = conn.transaction()?;
    let missing = if complete_walk {
        tx.execute("UPDATE tracks SET available = 0 WHERE id IN (SELECT trackId FROM source_tracks WHERE sourceId = ? AND seenJobId != ?) AND NOT EXISTS (SELECT 1 FROM source_tracks st WHERE st.trackId=tracks.id AND st.seenJobId=?)", params![source, job, job])?
    } else {
        0
    };
    tx.execute(
        "UPDATE library_sources SET lastScannedAt = ? WHERE id = ?",
        params![chrono::Utc::now().to_rfc3339(), source],
    )?;
    tx.commit()?;
    Ok(missing)
}

pub fn save_job(
    conn: &Connection,
    id: &str,
    directory: &str,
    event: &serde_json::Value,
    finished: bool,
) -> Result<(), AppError> {
    conn.execute("INSERT INTO scan_jobs VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET event=excluded.event, finished=excluded.finished, updatedAt=excluded.updatedAt", params![id, directory, event.to_string(), finished, chrono::Utc::now().to_rfc3339()])?;
    conn.execute("DELETE FROM scan_jobs WHERE finished=1 AND id NOT IN (SELECT id FROM scan_jobs ORDER BY updatedAt DESC LIMIT 32)", [])?;
    Ok(())
}

pub fn get_job(conn: &Connection, id: &str) -> Result<Option<serde_json::Value>, AppError> {
    let row: Option<(String, String, i64, String)> = conn
        .query_row(
            "SELECT directory,event,finished,updatedAt FROM scan_jobs WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    row.map(|(directory,event,finished,updated)| Ok(serde_json::json!({"jobId":id,"directory":directory,"event":serde_json::from_str::<serde_json::Value>(&event)?,"finished":finished != 0,"updatedAt":updated}))).transpose()
}

pub fn recover_interrupted_jobs(conn: &Connection) -> Result<(), AppError> {
    conn.execute("UPDATE scan_jobs SET finished=1,event=? WHERE finished=0", [serde_json::json!({"phase":"failed","message":"Scan interrupted by server restart. Rescan the folder to continue."}).to_string()])?;
    Ok(())
}
