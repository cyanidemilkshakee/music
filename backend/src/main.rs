use axum::{middleware as axum_middleware, Router};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::signal;
use tower::limit::ConcurrencyLimitLayer;
use tower_http::{compression::CompressionLayer, limit::RequestBodyLimitLayer};
use tracing::{info, Level};
use tracing_subscriber::{EnvFilter, FmtSubscriber};

#[cfg(not(target_env = "msvc"))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod config;
mod db;
mod error;
mod metrics;
mod middleware;
mod routes;
mod services;

use crate::config::Config;
use crate::routes::AppState;
use crate::services::ffmpeg::FfmpegService;
use crate::services::scanner::ScannerService;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Attempt to load .env file; ignore if it doesn't exist
    let _ = dotenvy::dotenv();

    let subscriber = FmtSubscriber::builder()
        .with_env_filter(EnvFilter::from_default_env().add_directive(Level::INFO.into()))
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);

    info!("Starting Local Amp Backend (Rust)");
    let started_at = std::time::Instant::now();

    if let Err(error) = crate::metrics::install() {
        tracing::warn!(%error, "Prometheus metrics are unavailable");
    }

    let config_val = Config::from_env().map_err(|errors| {
        for error in &errors {
            tracing::error!("Config error: {}", error);
        }
        anyhow::anyhow!("Invalid configuration")
    })?;

    let config = Arc::new(config_val);
    std::fs::create_dir_all(&config.data_dir)?;
    let db_path = config.data_dir.join("local-amp.db");

    let pool = db::pool::build_pool(&db_path)?;
    {
        let conn = pool.get()?;
        db::reliability::recover_interrupted_jobs(&conn)?;
    }

    let ffmpeg = FfmpegService::new(config.clone());
    let scanner = Arc::new(ScannerService::new(
        config.clone(),
        ffmpeg.clone(),
        pool.clone(),
    ));

    let shutdown = tokio_util::sync::CancellationToken::new();
    let app_state = AppState {
        started_at,
        config: config.clone(),
        pool,
        ffmpeg: ffmpeg.clone(),
        scanner: scanner.clone(),
        session_token: Arc::new(uuid::Uuid::new_v4().to_string()),
        shutdown: shutdown.clone(),
    };

    let app = Router::new()
        .nest("/api", routes::media::router())
        .nest("/api", routes::api::router())
        .nest("/api", routes::library::router())
        .nest("/api", routes::management::router())
        .nest("/metrics", metrics::router())
        .fallback(routes::assets::serve)
        .with_state(app_state.clone())
        // Streaming playback and scan progress may legitimately outlive a normal
        // request timeout. The FFmpeg and ffprobe operations enforce their own
        // bounded timeouts, while this layer protects server capacity.
        .layer(ConcurrencyLimitLayer::new(config.max_concurrent_requests))
        .layer(CompressionLayer::new())
        .layer(axum_middleware::from_fn(
            middleware::compression_bypass_middleware,
        ))
        .layer(RequestBodyLimitLayer::new(config.json_limit_bytes))
        .layer(axum::extract::DefaultBodyLimit::max(
            config.json_limit_bytes,
        ))
        .layer(axum_middleware::from_fn(
            middleware::api_response_middleware,
        ))
        .layer(axum_middleware::from_fn(
            middleware::security_headers_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            app_state,
            middleware::local_access_middleware,
        ))
        .layer(axum_middleware::from_fn(middleware::request_id_middleware));

    let addr = std::net::SocketAddr::new(config.host, config.port);
    let listener = TcpListener::bind(addr).await?;
    info!("Listening on http://{}", addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::select! { _ = shutdown_signal() => {}, _ = shutdown.cancelled() => {} }
            scanner.cancel_active().await;
            ffmpeg.shutdown();
        })
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c().await.unwrap_or(());
    };

    #[cfg(unix)]
    let terminate = async {
        match signal::unix::signal(signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::error!(%error, "Failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    info!("Shutting down Local Amp.");
}
