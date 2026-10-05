pub mod library_query;
pub mod migrations;
pub mod pool;
pub mod reliability;
pub mod sources;
#[cfg(test)]
mod tests;
pub use sources::{delete_library_source, get_library_sources, remember_library_source};

use crate::error::AppError;
use rusqlite::{params, Connection, Row};
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
    /// Refreshes browser artwork caches when metadata is re-extracted.
    pub metadata_extracted_at: Option<String>,
    pub has_artwork: bool,
    pub tags: serde_json::Value,
}

/// Fields needed to browse and play a track in the browser. Keep local paths
/// and raw metadata tags on the backend; the UI does not use them for library
/// rendering, and they can be large for tagged files.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTrack {
    pub id: String,
    pub file_name: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub available: bool,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub track_number: Option<i32>,
    pub disc_number: Option<i32>,
    pub duration: f64,
    pub codec: Option<String>,
    pub modified_at: Option<i64>,
    pub imported_at: Option<String>,
    /// Refreshes browser artwork caches when metadata is re-extracted.
    pub metadata_extracted_at: Option<String>,
    pub has_artwork: bool,
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
    pub available_tracks: i64,
    pub missing_tracks: i64,
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
    pub journal_mode: String,
}

fn parse_tags(val: Option<String>) -> serde_json::Value {
    match val {
        Some(s) => serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({})),
        None => serde_json::json!({}),
    }
}
fn optional_timestamp(row: &Row, column: &str) -> rusqlite::Result<Option<i64>> {
    use rusqlite::types::ValueRef;
    match row.get_ref(column)? {
        ValueRef::Null => Ok(None),
        ValueRef::Integer(value) => Ok(Some(value)),
        // The original JavaScript importer stored fractional mtimeMs as REAL.
        // Keep compatibility without requiring a destructive schema rewrite.
        ValueRef::Real(value)
            if value.is_finite() && value >= i64::MIN as f64 && value < i64::MAX as f64 =>
        {
            Ok(Some(value.trunc() as i64))
        }
        value => Err(rusqlite::Error::InvalidColumnType(
            row.as_ref().column_index(column)?,
            column.into(),
            value.data_type(),
        )),
    }
}

pub fn row_to_library_track(row: &Row) -> rusqlite::Result<LibraryTrack> {
    Ok(LibraryTrack {
        id: row.get("id")?,
        file_name: row.get("fileName")?,
        title: row.get("title")?,
        artist: row.get("artist")?,
        album: row.get("album")?,
        album_artist: row.get("albumArtist")?,
        available: row.get::<_, i64>("available")? != 0,
        genre: row.get("genre")?,
        year: row.get("year")?,
        track_number: row.get("trackNumber")?,
        disc_number: row.get("discNumber")?,
        duration: row.get::<_, Option<f64>>("duration")?.unwrap_or_default(),
        codec: row.get("codec")?,
        modified_at: optional_timestamp(row, "modifiedAt")?,
        imported_at: row.get("importedAt")?,
        metadata_extracted_at: row.get("metadataExtractedAt")?,
        has_artwork: row.get::<_, Option<i32>>("hasArtwork")?.unwrap_or_default() != 0,
    })
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
        duration: row.get::<_, Option<f64>>("duration")?.unwrap_or_default(),
        bit_rate: row.get::<_, Option<f64>>("bitRate")?.unwrap_or_default(),
        sample_rate: row.get("sampleRate")?,
        bit_depth: row.get("bitDepth")?,
        channels: row.get("channels")?,
        codec: row.get("codec")?,
        format: row.get("format")?,
        size: row.get("size")?,
        modified_at: optional_timestamp(row, "modifiedAt")?,
        imported_at: row.get("importedAt")?,
        metadata_extracted_at: row.get("metadataExtractedAt")?,
        has_artwork: row.get::<_, Option<i32>>("hasArtwork")?.unwrap_or_default() != 0,
        tags: parse_tags(row.get("tags")?),
    })
}

pub fn get_library_tracks(conn: &Connection) -> Result<Vec<LibraryTrack>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, fileName, title, artist, album, albumArtist, available, genre, year, trackNumber,
                discNumber, duration, codec, modifiedAt, importedAt, metadataExtractedAt, hasArtwork
         FROM tracks
         ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, trackNumber, title COLLATE NOCASE",
    )?;
    let tracks = stmt
        .query_map([], row_to_library_track)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(tracks)
}

pub fn get_recent_tracks(conn: &Connection) -> Result<Vec<LibraryTrack>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.fileName, t.title, t.artist, t.album, t.genre, t.year,
                t.trackNumber, t.discNumber, t.duration, t.codec, t.modifiedAt,
                t.importedAt, t.metadataExtractedAt, t.hasArtwork, t.albumArtist, t.available
         FROM recent AS r
         JOIN tracks AS t ON t.id = r.trackId
         ORDER BY r.playedAt DESC, r.id DESC
         LIMIT 50",
    )?;
    let tracks = stmt
        .query_map([], row_to_library_track)?
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

#[cfg(test)]
pub fn upsert_tracks_batch(conn: &mut Connection, tracks: &[Track]) -> Result<(), AppError> {
    let tx = conn.transaction()?;
    upsert_tracks(&tx, tracks)?;
    tx.commit()?;
    Ok(())
}

pub fn upsert_tracks(tx: &Connection, tracks: &[Track]) -> Result<(), AppError> {
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
                tags=excluded.tags",
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
    Ok(())
}

fn hydrate_playlist(conn: &Connection, row: &Row) -> rusqlite::Result<Playlist> {
    let id: String = row.get("id")?;
    let mut stmt = conn.prepare(
        "SELECT trackId FROM playlist_tracks WHERE playlistId = ? ORDER BY position ASC, rowid ASC",
    )?;
    let track_ids: Vec<String> = stmt
        .query_map(params![id], |r| r.get(0))?
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
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, p.createdAt, p.updatedAt, pt.trackId
         FROM playlists AS p
         LEFT JOIN playlist_tracks AS pt ON pt.playlistId = p.id
         ORDER BY p.createdAt ASC, p.name COLLATE NOCASE ASC, p.id ASC,
                  pt.position ASC, pt.rowid ASC",
    )?;
    let mut playlists = Vec::new();
    let mut current_id: Option<String> = None;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        if current_id.as_deref() != Some(&id) {
            playlists.push(Playlist {
                id: id.clone(),
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                track_ids: Vec::new(),
            });
            current_id = Some(id);
        }
        if let Some(track_id) = row.get::<_, Option<String>>(4)? {
            if let Some(playlist) = playlists.last_mut() {
                playlist.track_ids.push(track_id);
            }
        }
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

pub fn create_playlist(
    conn: &mut Connection,
    mut playlist: Playlist,
) -> Result<Playlist, AppError> {
    let tx = conn.transaction()?;
    for id in &playlist.track_ids {
        reliability::require_track(&tx, id)?;
    }
    let now = chrono::Utc::now().to_rfc3339();

    if playlist.created_at.is_empty() {
        playlist.created_at = now.clone();
    }
    if playlist.updated_at.is_empty() {
        playlist.updated_at = now;
    }

    tx.execute(
        "INSERT INTO playlists (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
        params![
            playlist.id,
            playlist.name,
            playlist.created_at,
            playlist.updated_at
        ],
    )?;

    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO playlist_tracks (playlistId, trackId, position)
             SELECT ?, id, ? FROM tracks WHERE id = ?",
        )?;
        for (i, track_id) in playlist.track_ids.iter().enumerate() {
            stmt.execute(params![playlist.id, i as i64, track_id])?;
        }
    }
    tx.commit()?;

    // fetch hydrated
    let playlist_id = playlist.id.clone();
    get_playlist_by_id(conn, &playlist_id).and_then(|opt| {
        opt.ok_or_else(|| anyhow::anyhow!("Failed to retrieve created playlist").into())
    })
}

pub fn update_playlist_name(
    conn: &mut Connection,
    id: &str,
    name: &str,
) -> Result<Option<Playlist>, AppError> {
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

pub fn add_track_to_playlist(
    conn: &mut Connection,
    playlist_id: &str,
    track_id: &str,
) -> Result<Option<Playlist>, AppError> {
    let tx = conn.transaction()?;

    let mut check_p = tx.prepare("SELECT 1 FROM playlists WHERE id = ?")?;
    if !check_p.exists(params![playlist_id])? {
        return Ok(None);
    }

    let mut check_t = tx.prepare("SELECT 1 FROM tracks WHERE id = ?")?;
    if !check_t.exists(params![track_id])? {
        return Ok(None);
    } // or we could error

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
    drop(check_p);
    drop(check_t);

    tx.commit()?;
    get_playlist_by_id(conn, playlist_id)
}

pub fn remove_track_from_playlist(
    conn: &mut Connection,
    playlist_id: &str,
    track_id: &str,
) -> Result<Option<Playlist>, AppError> {
    let tx = conn.transaction()?;

    let rows = tx.execute(
        "DELETE FROM playlist_tracks WHERE playlistId = ? AND trackId = ?",
        params![playlist_id, track_id],
    )?;

    if rows > 0 {
        // Compact positions
        let mut stmt = tx.prepare("SELECT rowid FROM playlist_tracks WHERE playlistId = ? ORDER BY position ASC, rowid ASC")?;
        let rowids: Vec<i64> = stmt
            .query_map(params![playlist_id], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

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
    if !check_t.exists(params![track_id])? {
        return Ok(false);
    }

    tx.execute("DELETE FROM recent WHERE trackId = ?", params![track_id])?;
    tx.execute(
        "INSERT INTO recent (trackId, playedAt) VALUES (?, ?)",
        params![track_id, chrono::Utc::now().timestamp_millis()],
    )?;
    tx.execute(
        "DELETE FROM recent WHERE id IN (SELECT id FROM recent ORDER BY playedAt DESC LIMIT -1 OFFSET 50)",
        [],
    )?;
    drop(check_t);
    tx.commit()?;
    Ok(true)
}

pub fn get_recent_ids(conn: &Connection) -> Result<Vec<String>, AppError> {
    let mut stmt = conn.prepare("SELECT trackId FROM recent ORDER BY playedAt DESC")?;
    let ids = stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(ids)
}

pub fn get_stats(conn: &Connection) -> Result<Stats, AppError> {
    let mut stmt = conn.prepare("
        SELECT
            COUNT(*) AS totalTracks,
            COALESCE(SUM(duration), 0) AS totalDuration,
            COALESCE(SUM(size), 0) AS totalSize,
            COUNT(DISTINCT NULLIF(album, '') || char(31) || COALESCE(NULLIF(albumArtist,''),artist,'')) AS totalAlbums,
            COUNT(DISTINCT NULLIF(artist, '')) AS totalArtists,
            COALESCE(SUM(CASE WHEN available != 0 THEN 1 ELSE 0 END),0) AS availableTracks,
            COALESCE(SUM(CASE WHEN available = 0 THEN 1 ELSE 0 END),0) AS missingTracks
        FROM tracks
    ")?;
    let (t_tracks, t_dur, t_size, t_albums, t_artists, available_tracks, missing_tracks) = stmt
        .query_row([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })?;

    let mut stmt_genres = conn.prepare(
        "
        SELECT genre, COUNT(*) AS count
        FROM tracks
        WHERE genre IS NOT NULL AND genre != ''
        GROUP BY genre
        ORDER BY count DESC, genre COLLATE NOCASE ASC
        LIMIT 5
    ",
    )?;
    let genres = stmt_genres
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Stats {
        total_tracks: t_tracks,
        available_tracks,
        missing_tracks,
        total_duration: t_dur,
        total_size: t_size,
        total_albums: t_albums,
        total_artists: t_artists,
        genres,
    })
}

pub fn get_health(conn: &Connection) -> Result<Health, AppError> {
    let connection_ok = conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))? == 1;
    let journal_mode: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;

    Ok(Health {
        ok: connection_ok,
        journal_mode,
    })
}
