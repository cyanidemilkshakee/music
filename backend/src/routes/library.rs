use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use tokio::task::spawn_blocking;

use super::AppState;
use crate::{db, error::AppError};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/library/sources", get(list_sources))
        .route("/library/sources/{id}", delete(delete_source))
        .route("/library/pick-folder", post(pick_folder))
}

async fn list_sources(State(state): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    let pool = state.pool.clone();
    let sources = spawn_blocking(move || {
        let conn = pool.get()?;
        db::get_library_sources(&conn)
    })
    .await??;
    Ok(Json(serde_json::json!({ "sources": sources })))
}

async fn delete_source(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let pool = state.pool.clone();
    let deleted = spawn_blocking(move || {
        let mut conn = pool.get()?;
        db::delete_library_source(&mut conn, &id)
    })
    .await??;
    if !deleted {
        return Err(AppError::Http {
            status: StatusCode::NOT_FOUND,
            message: "Library folder not found.".to_string(),
            detail: None,
        });
    }
    Ok(Json(serde_json::json!({ "deleted": true })))
}

async fn pick_folder() -> Result<Json<serde_json::Value>, AppError> {
    #[cfg(target_os = "windows")]
    {
        let output = tokio::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-STA",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Choose a music folder'; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
            ])
            .output()
            .await?;
        if !output.status.success() {
            return Err(AppError::Http {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                message: "The folder picker could not be opened.".to_string(),
                detail: None,
            });
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(Json(
            serde_json::json!({ "directory": (!path.is_empty()).then_some(path) }),
        ))
    }

    #[cfg(not(target_os = "windows"))]
    Err(AppError::Http {
        status: StatusCode::NOT_IMPLEMENTED,
        message: "The native folder picker is available on Windows only.".to_string(),
        detail: None,
    })
}
