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
    #[error("{tool} not available")]
    MediaUnavailable { tool: &'static str },
    #[error("Invalid request body")]
    Json(#[from] serde_json::Error),
    #[error("Operation timed out")]
    Timeout(#[from] tokio::time::error::Elapsed),
    #[error("Internal task failed")]
    TaskPanic(#[from] tokio::task::JoinError),
    #[error(transparent)]
    Anyhow(#[from] anyhow::Error),
}

impl AppError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::Http {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
            detail: None,
        }
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::Http {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
            detail: None,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, error_message, detail) = match self {
            AppError::Http {
                status,
                message,
                detail,
            } => (status, message, detail),
            AppError::Json(ref err) => (
                StatusCode::BAD_REQUEST,
                "Invalid JSON body".to_string(),
                Some(err.to_string()),
            ),
            AppError::MediaUnavailable { tool } => {
                if tool == "Folder picker" {
                    return AppError::Http { status: StatusCode::SERVICE_UNAVAILABLE, message: "Windows folder picker is unavailable. Enter an absolute folder path instead.".into(), detail: None }.into_response();
                }
                let setting = if tool == "FFprobe" {
                    "FFPROBE_PATH"
                } else {
                    "FFMPEG_PATH"
                };
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!("{tool} not available. Install FFmpeg or set {setting}."),
                    None,
                )
            }
            AppError::Timeout(_) => (
                StatusCode::REQUEST_TIMEOUT,
                "Request timed out".to_string(),
                None,
            ),
            AppError::Media {
                message,
                exit_code,
                stderr,
            } => {
                tracing::warn!(%message, ?exit_code, %stderr, "Media operation failed");
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    message,
                    Some(stderr.chars().take(2000).collect()),
                )
            }
            AppError::Io(ref e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "I/O Error".to_string(),
                Some(e.to_string()),
            ),
            // For all other errors, we return a 500 and log the error.
            _ => {
                error!(error = ?self, "Internal server error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                    None,
                )
            }
        };

        let body = Json(json!({
            "error": error_message,
            "detail": detail,
        }));

        (status, body).into_response()
    }
}
