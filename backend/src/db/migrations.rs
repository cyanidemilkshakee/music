use crate::error::AppError;
use rusqlite::Connection;
use tracing::info;

pub struct Migration {
    pub version: i32,
    pub sql: &'static str,
}

pub static MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: include_str!("migrations/001_initial.sql"),
    },
];

pub fn run_migrations(conn: &mut Connection) -> Result<(), AppError> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        )",
        [],
    )?;

    let tx = conn.transaction()?;

    let mut stmt = tx.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
    let applied_versions: Vec<i32> = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<i32>, _>>()?;

    for migration in MIGRATIONS {
        if !applied_versions.contains(&migration.version) {
            info!("Applying migration v{}", migration.version);
            tx.execute_batch(migration.sql)?;
            tx.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))",
                [migration.version],
            )?;
        }
    }

    tx.commit()?;
    Ok(())
}
