CREATE TABLE IF NOT EXISTS library_sources (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  addedAt TEXT NOT NULL,
  lastScannedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_library_sources_added_at
  ON library_sources (addedAt DESC);
