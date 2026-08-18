use axum::{
    middleware as axum_middleware,
    Router,
};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::signal;
use tower_http::{
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
    limit::RequestBodyLimitLayer,
    cors::{CorsLayer, Any},
    timeout::TimeoutLayer,
};
use std::time::Duration;
use tracing::{info, Level};
use tracing_subscriber::{FmtSubscriber, EnvFilter};

#[cfg(not(target_env = "msvc"))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod config;
mod db;
mod error;
mod middleware;
mod routes;
mod services;
mod metrics;

use crate::config::Config;
use crate::routes::AppState;
use crate::services::ffmpeg::FfmpegService;
use crate::services::scanner::ScannerService;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let subscriber = FmtSubscriber::builder()
        .with_env_filter(EnvFilter::from_default_env().add_directive(Level::INFO.into()))
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);

    info!("Starting Local Amp Backend (Rust)");

    crate::metrics::install();

    let config = Arc::new(Config::from_env());

    let pool = db::pool::build_pool(&config)?;
    db::migrations::run_migrations(&mut pool.get()?)?;

    let ffmpeg = FfmpegService::new(config.clone());
    let scanner = Arc::new(ScannerService::new(config.clone(), ffmpeg.clone(), pool.clone()));

    let app_state = AppState {
        config: config.clone(),
        pool,
        ffmpeg,
        scanner,
    };

    let current_dir = std::env::current_dir()?;
    let public_dir = current_dir.parent().unwrap().join("public");

    let serve_dir = ServeDir::new(&public_dir)
        .not_found_service(ServeFile::new(public_dir.join("index.html")));

    let app = Router::new()
        .nest("/api", routes::media::router())
        .nest("/api", routes::api::router())
        .nest("/metrics", metrics::router())
        .fallback_service(serve_dir)
        .with_state(app_state)
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .layer(TimeoutLayer::new(Duration::from_millis(config.request_timeout_ms)))
        .layer(axum_middleware::from_fn(middleware::compression_bypass_middleware))
        .layer(CompressionLayer::new())
        .layer(RequestBodyLimitLayer::new(config.json_limit))
        .layer(axum_middleware::from_fn(middleware::security_headers_middleware))
        .layer(axum_middleware::from_fn(middleware::request_id_middleware));

    let addr = format!("{}:{}", config.host, config.port);
    let listener = TcpListener::bind(&addr).await?;
    info!("Listening on http://{}", addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .unwrap_or_else(|_| ());
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .unwrap_or_else(|_| panic!("failed to install signal handler"))
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    
    info!("Shutting down Local Amp.");
}
