pub mod pool;
pub mod migrations;

use crate::error::AppError;
use rusqlite::{params, Connection, Row, Transaction};
use serde::{Deserialize, Serialize};

// Models
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub path: String,
    pub file_name: Option<String>,
    pub directory: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub track_number: Option<i32>,
    pub disc_number: Option<i32>,
    pub duration: f64,
    pub bit_rate: f64,
    pub sample_rate: Option<f64>,
    pub bit_depth: Option<i32>,
    pub channels: Option<i32>,
    pub codec: Option<String>,
    pub format: Option<String>,
    pub size: Option<i64>,
    pub modified_at: Option<i64>,
    pub imported_at: Option<String>,
    pub metadata_extracted_at: Option<String>,
    pub has_artwork: bool,
    pub tags: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub track_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub total_tracks: i64,
    pub total_duration: f64,
    pub total_size: i64,
    pub total_albums: i64,
    pub total_artists: i64,
    pub genres: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub integrity: String,
    pub quick: String,
    pub foreign_key_errors: i64,
    pub wal: String,
    pub stats: Stats,
}

fn parse_tags(val: Option<String>) -> serde_json::Value {
    match val {
        Some(s) => serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({})),
        None => serde_json::json!({}),
    }
}

fn row_to_track(row: &Row) -> rusqlite::Result<Track> {
    Ok(Track {
        id: row.get("id")?,
        path: row.get("path")?,
        file_name: row.get("fileName")?,
        directory: row.get("directory")?,
        title: row.get("title")?,
        artist: row.get("artist")?,
        album: row.get("album")?,
        album_artist: row.get("albumArtist")?,
        genre: row.get("genre")?,
        year: row.get("year")?,
        track_number: row.get("trackNumber")?,
        disc_number: row.get("discNumber")?,
        duration: row.get("duration")?,
        bit_rate: row.get("bitRate")?,
        sample_rate: row.get("sampleRate")?,
        bit_depth: row.get("bitDepth")?,
        channels: row.get("channels")?,
        codec: row.get("codec")?,
        format: row.get("format")?,
        size: row.get("size")?,
        modified_at: row.get("modifiedAt")?,
        imported_at: row.get("importedAt")?,
        metadata_extracted_at: row.get("metadataExtractedAt")?,
        has_artwork: row.get::<_, i32>("hasArtwork")? != 0,
        tags: parse_tags(row.get("tags")?),
    })
}

pub fn get_all_tracks(conn: &Connection) -> Result<Vec<Track>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM tracks ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, trackNumber, title COLLATE NOCASE"
    )?;
    let tracks = stmt.query_map([], row_to_track)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(tracks)
}

pub fn get_track_by_id(conn: &Connection, id: &str) -> Result<Option<Track>, AppError> {
    let mut stmt = conn.prepare("SELECT * FROM tracks WHERE id = ?")?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_track(row)?))
    } else {
        Ok(None)
    }
}

pub fn upsert_tracks_batch(conn: &mut Connection, tracks: &[Track]) -> Result<(), AppError> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO tracks (
                id, path, fileName, directory, title, artist, album, albumArtist,
                genre, year, trackNumber, discNumber, duration, bitRate, sampleRate,
                bitDepth, channels, codec, format, size, modifiedAt, importedAt,
                metadataExtractedAt, hasArtwork, tags
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?
            )
            ON CONFLICT(path) DO UPDATE SET
                id=excluded.id,
                fileName=excluded.fileName,
                directory=excluded.directory,
                title=excluded.title,
                artist=excluded.artist,
                album=excluded.album,
                albumArtist=excluded.albumArtist,
                genre=excluded.genre,
                year=excluded.year,
                trackNumber=excluded.trackNumber,
                discNumber=excluded.discNumber,
                duration=excluded.duration,
                bitRate=excluded.bitRate,
                sampleRate=excluded.sampleRate,
                bitDepth=excluded.bitDepth,
                channels=excluded.channels,
                codec=excluded.codec,
                format=excluded.format,
                size=excluded.size,
                modifiedAt=excluded.modifiedAt,
                metadataExtractedAt=excluded.metadataExtractedAt,
                hasArtwork=excluded.hasArtwork,
                tags=excluded.tags"
        )?;

        for track in tracks {
            stmt.execute(params![
                track.id,
                track.path,
                track.file_name,
                track.directory,
                track.title,
                track.artist,
                track.album,
                track.album_artist,
                track.genre,
                track.year,
                track.track_number,
                track.disc_number,
                track.duration,
                track.bit_rate,
                track.sample_rate,
                track.bit_depth,
                track.channels,
                track.codec,
                track.format,
                track.size,
                track.modified_at,
                track.imported_at,
                track.metadata_extracted_at,
                if track.has_artwork { 1 } else { 0 },
                track.tags.to_string()
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn hydrate_playlist(conn: &Connection, row: &Row) -> rusqlite::Result<Playlist> {
    let id: String = row.get("id")?;
    let mut stmt = conn.prepare(
        "SELECT trackId FROM playlist_tracks WHERE playlistId = ? ORDER BY position ASC, rowid ASC"
    )?;
    let track_ids: Vec<String> = stmt.query_map(params![id], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Playlist {
        id,
        name: row.get("name")?,
        created_at: row.get("createdAt")?,
        updated_at: row.get("updatedAt")?,
        track_ids,
    })
}

pub fn get_all_playlists(conn: &Connection) -> Result<Vec<Playlist>, AppError> {
    let mut stmt = conn.prepare("SELECT * FROM playlists ORDER BY createdAt ASC, name COLLATE NOCASE ASC")?;
    let mut playlists = Vec::new();
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        playlists.push(hydrate_playlist(conn, row)?);
    }
    Ok(playlists)
}

pub fn get_playlist_by_id(conn: &Connection, id: &str) -> Result<Option<Playlist>, AppError> {
    let mut stmt = conn.prepare("SELECT * FROM playlists WHERE id = ?")?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(hydrate_playlist(conn, row)?))
    } else {
        Ok(None)
    }
}

pub fn create_playlist(conn: &mut Connection, mut playlist: Playlist) -> Result<Playlist, AppError> {
    let tx = conn.transaction()?;
    let now = chrono::Utc::now().to_rfc3339();
    
    if playlist.created_at.is_empty() { playlist.created_at = now.clone(); }
    if playlist.updated_at.is_empty() { playlist.updated_at = now; }

    tx.execute(
        "INSERT INTO playlists (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
        params![playlist.id, playlist.name, playlist.created_at, playlist.updated_at],
    )?;

    {
        let mut stmt = tx.prepare("INSERT OR IGNORE INTO playlist_tracks (playlistId, trackId, position) VALUES (?, ?, ?)")?;
        for (i, track_id) in playlist.track_ids.iter().enumerate() {
            // Check if track exists
            let mut check_stmt = tx.prepare("SELECT 1 FROM tracks WHERE id = ?")?;
            if check_stmt.exists(params![track_id])? {
                stmt.execute(params![playlist.id, track_id, i as i64])?;
            }
        }
    }
    tx.commit()?;
    
    // fetch hydrated
    let playlist_id = playlist.id.clone();
    get_playlist_by_id(conn, &playlist_id).and_then(|opt| {
        opt.ok_or_else(|| AppError::Database("Failed to retrieve created playlist".to_string()))
    })
}

pub fn update_playlist_name(conn: &mut Connection, id: &str, name: &str) -> Result<Option<Playlist>, AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    let rows = conn.execute(
        "UPDATE playlists SET name = ?, updatedAt = ? WHERE id = ?",
        params![name, now, id],
    )?;
    
    if rows == 0 {
        return Ok(None);
    }
    get_playlist_by_id(conn, id)
}

pub fn delete_playlist(conn: &mut Connection, id: &str) -> Result<bool, AppError> {
    let rows = conn.execute("DELETE FROM playlists WHERE id = ?", params![id])?;
    Ok(rows > 0)
}

pub fn add_track_to_playlist(conn: &mut Connection, playlist_id: &str, track_id: &str) -> Result<Option<Playlist>, AppError> {
    let tx = conn.transaction()?;
    
    let mut check_p = tx.prepare("SELECT 1 FROM playlists WHERE id = ?")?;
    if !check_p.exists(params![playlist_id])? { return Ok(None); }
    
    let mut check_t = tx.prepare("SELECT 1 FROM tracks WHERE id = ?")?;
    if !check_t.exists(params![track_id])? { return Ok(None); } // or we could error

    let next_pos: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM playlist_tracks WHERE playlistId = ?",
        params![playlist_id],
        |r| r.get(0),
    )?;

    let rows = tx.execute(
        "INSERT OR IGNORE INTO playlist_tracks (playlistId, trackId, position) VALUES (?, ?, ?)",
        params![playlist_id, track_id, next_pos],
    )?;

    if rows > 0 {
        tx.execute(
            "UPDATE playlists SET updatedAt = ? WHERE id = ?",
            params![chrono::Utc::now().to_rfc3339(), playlist_id],
        )?;
    }
    
    tx.commit()?;
    get_playlist_by_id(conn, playlist_id)
}

pub fn remove_track_from_playlist(conn: &mut Connection, playlist_id: &str, track_id: &str) -> Result<Option<Playlist>, AppError> {
    let tx = conn.transaction()?;
    
    let rows = tx.execute(
        "DELETE FROM playlist_tracks WHERE playlistId = ? AND trackId = ?",
        params![playlist_id, track_id],
    )?;

    if rows > 0 {
        // Compact positions
        let mut stmt = tx.prepare("SELECT rowid FROM playlist_tracks WHERE playlistId = ? ORDER BY position ASC, rowid ASC")?;
        let rowids: Vec<i64> = stmt.query_map(params![playlist_id], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?;
        
        let mut update = tx.prepare("UPDATE playlist_tracks SET position = ? WHERE rowid = ?")?;
        for (i, rowid) in rowids.iter().enumerate() {
            update.execute(params![i as i64, rowid])?;
        }

        tx.execute(
            "UPDATE playlists SET updatedAt = ? WHERE id = ?",
            params![chrono::Utc::now().to_rfc3339(), playlist_id],
        )?;
    }
    tx.commit()?;
    get_playlist_by_id(conn, playlist_id)
}

pub fn add_recent(conn: &mut Connection, track_id: &str) -> Result<bool, AppError> {
    let tx = conn.transaction()?;
    
    let mut check_t = tx.prepare("SELECT 1 FROM tracks WHERE id = ?")?;
    if !check_t.exists(params![track_id])? { return Ok(false); }

    tx.execute("DELETE FROM recent WHERE trackId = ?", params![track_id])?;
    tx.execute(
        "INSERT INTO recent (trackId, playedAt) VALUES (?, ?)",
        params![track_id, chrono::Utc::now().timestamp_millis()],
    )?;
    tx.execute(
        "DELETE FROM recent WHERE id IN (SELECT id FROM recent ORDER BY playedAt DESC LIMIT -1 OFFSET 50)",
        [],
    )?;
    tx.commit()?;
    Ok(true)
}

pub fn get_recent_ids(conn: &Connection) -> Result<Vec<String>, AppError> {
    let mut stmt = conn.prepare("SELECT trackId FROM recent ORDER BY playedAt DESC")?;
    let ids = stmt.query_map([], |r| r.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(ids)
}

pub fn get_stats(conn: &Connection) -> Result<Stats, AppError> {
    let mut stmt = conn.prepare("
        SELECT
            COUNT(*) AS totalTracks,
            COALESCE(SUM(duration), 0) AS totalDuration,
            COALESCE(SUM(size), 0) AS totalSize,
            COUNT(DISTINCT NULLIF(album, '')) AS totalAlbums,
            COUNT(DISTINCT NULLIF(artist, '')) AS totalArtists
        FROM tracks
    ")?;
    let (t_tracks, t_dur, t_size, t_albums, t_artists) = stmt.query_row([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, f64>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?
        ))
    })?;

    let mut stmt_genres = conn.prepare("
        SELECT genre, COUNT(*) AS count
        FROM tracks
        WHERE genre IS NOT NULL AND genre != ''
        GROUP BY genre
        ORDER BY count DESC, genre COLLATE NOCASE ASC
        LIMIT 5
    ")?;
    let genres = stmt_genres.query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Stats {
        total_tracks: t_tracks,
        total_duration: t_dur,
        total_size: t_size,
        total_albums: t_albums,
        total_artists: t_artists,
        genres,
    })
}

pub fn get_health(conn: &Connection) -> Result<Health, AppError> {
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    let quick: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    let foreign_key_errors: i64 = conn.query_row("SELECT count(*) FROM pragma_foreign_key_check()", [], |r| r.get(0))?;
    let wal: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
    let stats = get_stats(conn)?;

    Ok(Health {
        ok: integrity == "ok" && quick == "ok" && foreign_key_errors == 0,
        integrity,
        quick,
        foreign_key_errors,
        wal,
        stats,
    })
}

pub fn close_db(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch("
        PRAGMA optimize;
        PRAGMA wal_checkpoint(TRUNCATE);
    ")?;
    Ok(())
}
