use crate::error::AppError;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySource {
    pub id: String,
    pub path: String,
    pub added_at: String,
    pub last_scanned_at: Option<String>,
}

pub fn get_library_sources(conn: &Connection) -> Result<Vec<LibrarySource>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, path, addedAt, lastScannedAt FROM library_sources ORDER BY lastScannedAt DESC, addedAt DESC",
    )?;
    let sources = stmt
        .query_map([], |row| {
            Ok(LibrarySource {
                id: row.get(0)?,
                path: row.get(1)?,
                added_at: row.get(2)?,
                last_scanned_at: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(sources)
}

pub fn remember_library_source(conn: &mut Connection, path: &str) -> Result<(), AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO library_sources (id, path, addedAt, lastScannedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET lastScannedAt = excluded.lastScannedAt",
        params![
            uuid::Uuid::new_v4().to_string(),
            path,
            now,
            chrono::Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

pub fn delete_library_source(conn: &mut Connection, id: &str) -> Result<bool, AppError> {
    Ok(conn.execute("DELETE FROM library_sources WHERE id = ?", params![id])? > 0)
}
