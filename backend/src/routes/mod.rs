pub mod api;
pub mod assets;
pub mod json;
pub mod library;
pub mod management;
pub mod media;

use crate::config::Config;
use crate::services::ffmpeg::FfmpegService;
use crate::services::scanner::ScannerService;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone)]
pub struct AppState {
    pub started_at: Instant,
    pub config: Arc<Config>,
    pub pool: Pool<SqliteConnectionManager>,
    pub ffmpeg: FfmpegService,
    pub scanner: Arc<ScannerService>,
    pub session_token: Arc<String>,
    pub shutdown: tokio_util::sync::CancellationToken,
}
