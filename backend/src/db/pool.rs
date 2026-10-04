use crate::error::AppError;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use std::path::Path;
use std::time::Duration;
use tracing::error;

use super::migrations::run_migrations;

pub fn build_pool(db_path: &Path) -> Result<Pool<SqliteConnectionManager>, AppError> {
    let manager = SqliteConnectionManager::file(db_path).with_init(|conn: &mut Connection| {
        super::library_query::register_functions(conn)?;
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
        .connection_timeout(Duration::from_secs(10))
        .test_on_check_out(true)
        .build(manager)?;

    // Run startup integrity checks
    let mut conn = pool.get()?;

    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        error!("SQLite integrity check failed: {}", integrity);
        return Err(crate::error::AppError::Anyhow(anyhow::anyhow!(
            "SQLite integrity check failed: {integrity}"
        )));
    }

    // Run migrations
    run_migrations(&mut conn)?;

    // Repair orphan rows left by older versions before validating constraints.
    let tx = conn.transaction()?;
    tx.execute_batch(
        "
        DELETE FROM playlist_tracks
        WHERE playlistId IS NULL
           OR trackId IS NULL
           OR playlistId NOT IN (SELECT id FROM playlists)
           OR trackId NOT IN (SELECT id FROM tracks);
        DELETE FROM recent
        WHERE trackId IS NULL
           OR trackId NOT IN (SELECT id FROM tracks);
    ",
    )?;
    tx.commit()?;

    let foreign_key_check: usize = conn.query_row(
        "SELECT count(*) FROM pragma_foreign_key_check()",
        [],
        |row| row.get(0),
    )?;
    if foreign_key_check > 0 {
        error!(
            "SQLite foreign key check failed: {} violations",
            foreign_key_check
        );
        return Err(crate::error::AppError::Anyhow(anyhow::anyhow!(
            "SQLite foreign key check failed: {foreign_key_check} violations"
        )));
    }

    Ok(pool)
}
