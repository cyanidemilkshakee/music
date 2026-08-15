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
