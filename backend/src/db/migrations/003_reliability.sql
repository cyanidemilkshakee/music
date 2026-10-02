ALTER TABLE tracks ADD COLUMN available INTEGER NOT NULL DEFAULT 1;
CREATE TABLE track_fingerprints (
    trackId TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL
);
CREATE INDEX fingerprint_lookup ON track_fingerprints(fingerprint);
CREATE TABLE source_tracks (
    sourceId TEXT NOT NULL REFERENCES library_sources(id) ON DELETE CASCADE,
    trackId TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    seenJobId TEXT NOT NULL,
    PRIMARY KEY(sourceId, trackId)
);
CREATE INDEX source_tracks_track ON source_tracks(trackId);
CREATE TABLE favorites (
    trackId TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE
);
CREATE TABLE scan_jobs (
    id TEXT PRIMARY KEY,
    directory TEXT NOT NULL,
    event TEXT NOT NULL,
    finished INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT NOT NULL
);
CREATE INDEX library_order ON tracks(artist COLLATE NOCASE, album COLLATE NOCASE, discNumber, trackNumber);
