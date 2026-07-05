const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { httpError } = require('../utils/http');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(path.join(DATA_DIR, 'local-amp.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    path TEXT UNIQUE,
    fileName TEXT,
    directory TEXT,
    title TEXT,
    artist TEXT,
    album TEXT,
    albumArtist TEXT,
    genre TEXT,
    year TEXT,
    trackNumber INTEGER,
    discNumber INTEGER,
    duration REAL,
    bitRate REAL,
    sampleRate REAL,
    bitDepth INTEGER,
    channels INTEGER,
    codec TEXT,
    format TEXT,
    size INTEGER,
    modifiedAt INTEGER,
    importedAt TEXT,
    metadataExtractedAt TEXT,
    hasArtwork INTEGER,
    tags TEXT
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlistId TEXT NOT NULL,
    trackId TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (playlistId) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (trackId) REFERENCES tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS recent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trackId TEXT NOT NULL,
    playedAt INTEGER NOT NULL,
    FOREIGN KEY (trackId) REFERENCES tracks(id) ON DELETE CASCADE
  );

  DELETE FROM playlist_tracks
    WHERE playlistId IS NULL
       OR trackId IS NULL
       OR playlistId NOT IN (SELECT id FROM playlists)
       OR trackId NOT IN (SELECT id FROM tracks);
  DELETE FROM recent
    WHERE trackId IS NULL
       OR trackId NOT IN (SELECT id FROM tracks);
  DELETE FROM playlist_tracks
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM playlist_tracks
      GROUP BY playlistId, trackId
    );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_tracks_unique
    ON playlist_tracks (playlistId, trackId);
  CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_position
    ON playlist_tracks (playlistId, position);
  CREATE INDEX IF NOT EXISTS idx_recent_played_at
    ON recent (playedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_tracks_directory
    ON tracks (directory);
  CREATE INDEX IF NOT EXISTS idx_tracks_album
    ON tracks (album);
  CREATE INDEX IF NOT EXISTS idx_tracks_artist
    ON tracks (artist);
`);

const trackSelect = `
  SELECT *
  FROM tracks
`;

function parseTrackRow(row) {
  if (!row) return null;
  return {
    ...row,
    hasArtwork: !!row.hasArtwork,
    tags: parseTags(row.tags)
  };
}

function parseTags(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePlaylistName(name) {
  const normalized = String(name || 'Untitled Playlist').replace(/\s+/g, ' ').trim();
  return normalized.slice(0, 120) || 'Untitled Playlist';
}

function getAllTracks() {
  return db.prepare(`${trackSelect} ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, trackNumber, title COLLATE NOCASE`).all()
    .map(parseTrackRow);
}

function getTrackById(id) {
  return parseTrackRow(db.prepare(`${trackSelect} WHERE id = ?`).get(id));
}

function upsertTrack(track) {
  if (!track || !track.id || !track.path) {
    throw new Error('Track id and path are required.');
  }

  const stmt = db.prepare(`
    INSERT INTO tracks (
      id, path, fileName, directory, title, artist, album, albumArtist,
      genre, year, trackNumber, discNumber, duration, bitRate, sampleRate,
      bitDepth, channels, codec, format, size, modifiedAt, importedAt,
      metadataExtractedAt, hasArtwork, tags
    ) VALUES (
      @id, @path, @fileName, @directory, @title, @artist, @album, @albumArtist,
      @genre, @year, @trackNumber, @discNumber, @duration, @bitRate, @sampleRate,
      @bitDepth, @channels, @codec, @format, @size, @modifiedAt, @importedAt,
      @metadataExtractedAt, @hasArtwork, @tags
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
      tags=excluded.tags
  `);

  stmt.run({
    id: track.id,
    path: track.path,
    fileName: track.fileName || path.basename(track.path),
    directory: track.directory || path.dirname(track.path),
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    albumArtist: track.albumArtist || '',
    genre: track.genre || '',
    year: track.year || '',
    trackNumber: track.trackNumber ?? null,
    discNumber: track.discNumber ?? null,
    duration: Number.isFinite(track.duration) ? track.duration : 0,
    bitRate: Number.isFinite(track.bitRate) ? track.bitRate : 0,
    sampleRate: track.sampleRate ?? null,
    bitDepth: track.bitDepth ?? null,
    channels: track.channels ?? null,
    codec: track.codec || '',
    format: track.format || '',
    size: track.size ?? null,
    modifiedAt: track.modifiedAt ?? null,
    importedAt: track.importedAt || nowIso(),
    metadataExtractedAt: track.metadataExtractedAt || nowIso(),
    hasArtwork: track.hasArtwork ? 1 : 0,
    tags: JSON.stringify(track.tags || {})
  });
}

function hydratePlaylist(row) {
  if (!row) return null;
  const tracks = db.prepare(`
    SELECT trackId
    FROM playlist_tracks
    WHERE playlistId = ?
    ORDER BY position ASC, rowid ASC
  `).all(row.id);
  return { ...row, trackIds: tracks.map(track => track.trackId) };
}

function getAllPlaylists() {
  return db.prepare('SELECT * FROM playlists ORDER BY createdAt ASC, name COLLATE NOCASE ASC').all()
    .map(hydratePlaylist);
}

function getPlaylistById(id) {
  return hydratePlaylist(db.prepare('SELECT * FROM playlists WHERE id = ?').get(id));
}

function updatePlaylistName(playlistId, name) {
  const playlist = getPlaylistById(playlistId);
  if (!playlist) throw httpError(404, 'Playlist not found.');

  db.prepare('UPDATE playlists SET name = ?, updatedAt = ? WHERE id = ?')
    .run(normalizePlaylistName(name), nowIso(), playlistId);
  return getPlaylistById(playlistId);
}

function deletePlaylist(playlistId) {
  const result = db.prepare('DELETE FROM playlists WHERE id = ?').run(playlistId);
  if (result.changes === 0) throw httpError(404, 'Playlist not found.');
}

const createPlaylistTx = db.transaction(playlist => {
  const now = nowIso();
  const nextPlaylist = {
    id: playlist.id,
    name: normalizePlaylistName(playlist.name),
    createdAt: playlist.createdAt || now,
    updatedAt: playlist.updatedAt || now
  };

  db.prepare(`
    INSERT INTO playlists (id, name, createdAt, updatedAt)
    VALUES (@id, @name, @createdAt, @updatedAt)
  `).run(nextPlaylist);

  const insertTrack = db.prepare(`
    INSERT OR IGNORE INTO playlist_tracks (playlistId, trackId, position)
    VALUES (?, ?, ?)
  `);
  for (const [index, trackId] of [...new Set(playlist.trackIds || [])].entries()) {
    if (getTrackById(trackId)) insertTrack.run(nextPlaylist.id, trackId, index);
  }

  return getPlaylistById(nextPlaylist.id);
});

function createPlaylist(playlist) {
  if (!playlist || !playlist.id) {
    throw new Error('Playlist id is required.');
  }
  return createPlaylistTx(playlist);
}

function ensurePlaylistAndTrack(playlistId, trackId) {
  const playlist = getPlaylistById(playlistId);
  if (!playlist) throw httpError(404, 'Playlist not found.');
  const track = getTrackById(trackId);
  if (!track) throw httpError(404, 'Track not found.');
  return { playlist, track };
}

const addTrackToPlaylistTx = db.transaction((playlistId, trackId) => {
  ensurePlaylistAndTrack(playlistId, trackId);
  const nextPosition = db.prepare(`
    SELECT COALESCE(MAX(position) + 1, 0) AS position
    FROM playlist_tracks
    WHERE playlistId = ?
  `).get(playlistId).position;

  const result = db.prepare(`
    INSERT OR IGNORE INTO playlist_tracks (playlistId, trackId, position)
    VALUES (?, ?, ?)
  `).run(playlistId, trackId, nextPosition);

  if (result.changes > 0) {
    db.prepare('UPDATE playlists SET updatedAt = ? WHERE id = ?').run(nowIso(), playlistId);
  }
  return getPlaylistById(playlistId);
});

function addTrackToPlaylist(playlistId, trackId) {
  return addTrackToPlaylistTx(playlistId, trackId);
}

function compactPlaylistPositions(playlistId) {
  const rows = db.prepare(`
    SELECT rowid
    FROM playlist_tracks
    WHERE playlistId = ?
    ORDER BY position ASC, rowid ASC
  `).all(playlistId);
  const update = db.prepare('UPDATE playlist_tracks SET position = ? WHERE rowid = ?');
  rows.forEach((row, index) => update.run(index, row.rowid));
}

const removeTrackFromPlaylistTx = db.transaction((playlistId, trackId) => {
  const playlist = getPlaylistById(playlistId);
  if (!playlist) throw httpError(404, 'Playlist not found.');

  const result = db.prepare(`
    DELETE FROM playlist_tracks
    WHERE playlistId = ? AND trackId = ?
  `).run(playlistId, trackId);

  if (result.changes > 0) {
    compactPlaylistPositions(playlistId);
    db.prepare('UPDATE playlists SET updatedAt = ? WHERE id = ?').run(nowIso(), playlistId);
  }
  return getPlaylistById(playlistId);
});

function removeTrackFromPlaylist(playlistId, trackId) {
  return removeTrackFromPlaylistTx(playlistId, trackId);
}

const addRecentTx = db.transaction(trackId => {
  if (!getTrackById(trackId)) throw httpError(404, 'Track not found.');
  db.prepare('DELETE FROM recent WHERE trackId = ?').run(trackId);
  db.prepare('INSERT INTO recent (trackId, playedAt) VALUES (?, ?)').run(trackId, Date.now());
  db.prepare(`
    DELETE FROM recent
    WHERE id IN (
      SELECT id
      FROM recent
      ORDER BY playedAt DESC
      LIMIT -1 OFFSET 50
    )
  `).run();
});

function addRecent(trackId) {
  addRecentTx(trackId);
}

function getRecentIds() {
  return db.prepare('SELECT trackId FROM recent ORDER BY playedAt DESC').all()
    .map(row => row.trackId);
}

function getStats() {
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS totalTracks,
      COALESCE(SUM(duration), 0) AS totalDuration,
      COALESCE(SUM(size), 0) AS totalSize,
      COUNT(DISTINCT NULLIF(album, '')) AS totalAlbums,
      COUNT(DISTINCT NULLIF(artist, '')) AS totalArtists
    FROM tracks
  `).get();

  const genres = db.prepare(`
    SELECT genre, COUNT(*) AS count
    FROM tracks
    WHERE genre IS NOT NULL AND genre != ''
    GROUP BY genre
    ORDER BY count DESC, genre COLLATE NOCASE ASC
    LIMIT 5
  `).all().map(row => row.genre);

  return { ...stats, genres };
}

function close() {
  if (db.open) db.close();
}

module.exports = {
  db,
  getAllTracks,
  getTrackById,
  upsertTrack,
  getAllPlaylists,
  getPlaylistById,
  createPlaylist,
  updatePlaylistName,
  deletePlaylist,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  addRecent,
  getRecentIds,
  getStats,
  close
};
