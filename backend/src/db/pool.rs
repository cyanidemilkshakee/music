use crate::error::AppError;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use std::path::Path;
use tracing::error;
use std::process;

use super::migrations::run_migrations;

pub fn build_pool(db_path: &Path) -> Result<Pool<SqliteConnectionManager>, AppError> {
    let manager = SqliteConnectionManager::file(db_path).with_init(|conn: &mut Connection| {
        conn.execute_batch(
            "
            PRAGMA journal_mode    = WAL;
            PRAGMA synchronous     = NORMAL;
            PRAGMA foreign_keys    = ON;
            PRAGMA busy_timeout    = 5000;
            PRAGMA wal_autocheckpoint = 1000;
            PRAGMA cache_size      = -8000;
            PRAGMA mmap_size       = 134217728;
            PRAGMA temp_store      = MEMORY;
            PRAGMA optimize;
            ",
        )?;
        Ok(())
    });

    let pool = Pool::builder()
        .max_size(8)
        .test_on_check_out(true)
        .build(manager)?;

    // Run startup integrity checks
    let mut conn = pool.get()?;
    
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        error!("SQLite integrity check failed: {}", integrity);
        process::exit(1);
    }

    let foreign_key_check: usize = conn.query_row("SELECT count(*) FROM pragma_foreign_key_check()", [], |r| r.get(0))?;
    if foreign_key_check > 0 {
        error!("SQLite foreign key check failed: {} violations", foreign_key_check);
        process::exit(1);
    }

    let quick_check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if quick_check != "ok" {
        error!("SQLite quick check failed: {}", quick_check);
        process::exit(1);
    }

    // Run migrations
    run_migrations(&mut conn)?;

    // Repair orphan rows
    conn.execute_batch("
        DELETE FROM playlist_tracks
        WHERE playlistId IS NULL
           OR trackId IS NULL
           OR playlistId NOT IN (SELECT id FROM playlists)
           OR trackId NOT IN (SELECT id FROM tracks);
        DELETE FROM recent
        WHERE trackId IS NULL
           OR trackId NOT IN (SELECT id FROM tracks);
    ")?;

    Ok(pool)
}
