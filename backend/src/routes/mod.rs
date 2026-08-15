pub mod api;
pub mod media;

use crate::config::Config;
use crate::services::ffmpeg::FfmpegService;
use crate::services::scanner::ScannerService;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub pool: Pool<SqliteConnectionManager>,
    pub ffmpeg: FfmpegService,
    pub scanner: Arc<ScannerService>,
}
