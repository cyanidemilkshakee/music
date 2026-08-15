use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use tracing::error;

#[derive(thiserror::Error, Debug)]
pub enum AppError {
    #[error("{message}")]
    Http {
        status: StatusCode,
        message: String,
        detail: Option<String>,
    },
    #[error("Database error")]
    Db(#[from] rusqlite::Error),
    #[error("Database pool error")]
    DbPool(#[from] r2d2::Error),
    #[error("IO error")]
    Io(#[from] std::io::Error),
    #[error("Media tool error: {message}")]
    Media {
        message: String,
        exit_code: Option<i32>,
        stderr: String,
    },
    #[error("Media tool unavailable")]
    MediaUnavailable,
    #[error("Invalid request body")]
    Json(#[from] serde_json::Error),
    #[error("Validation error")]
    Validation(#[from] validator::ValidationErrors),
    #[error("Operation timed out")]
    Timeout(#[from] tokio::time::error::Elapsed),
    #[error("Internal task failed")]
    TaskPanic(#[from] tokio::task::JoinError),
    #[error(transparent)]
    Anyhow(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, error_message, detail) = match self {
            AppError::Http { status, message, detail } => {
                (status, message, detail)
            }
            AppError::Validation(ref errs) => {
                (StatusCode::BAD_REQUEST, "Validation Error".to_string(), Some(errs.to_string()))
            }
            AppError::Json(ref err) => {
                (StatusCode::BAD_REQUEST, "Invalid JSON body".to_string(), Some(err.to_string()))
            }
            AppError::MediaUnavailable => {
                (StatusCode::SERVICE_UNAVAILABLE, "FFmpeg not available. Install FFmpeg or set FFMPEG_PATH.".to_string(), None)
            }
            AppError::Timeout(_) => {
                (StatusCode::REQUEST_TIMEOUT, "Request timed out".to_string(), None)
            }
            // For all other errors, we return a 500 and log the error.
            _ => {
                error!(error = ?self, "Internal server error");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string(), None)
            }
        };

        let body = Json(json!({
            "error": error_message,
            "detail": detail,
        }));

        (status, body).into_response()
    }
}
