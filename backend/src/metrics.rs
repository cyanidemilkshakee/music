use axum::{http::StatusCode, response::IntoResponse, routing::get, Router};
use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};
use std::sync::OnceLock;

static METRICS_HANDLE: OnceLock<PrometheusHandle> = OnceLock::new();

pub fn install() -> Result<(), String> {
    let builder = PrometheusBuilder::new();
    let handle = builder
        .install_recorder()
        .map_err(|error| error.to_string())?;
    METRICS_HANDLE
        .set(handle)
        .map_err(|_| "Metrics handle was already initialized".to_string())
}

pub fn router() -> Router<crate::routes::AppState> {
    Router::new().route("/", get(metrics_handler))
}

async fn metrics_handler() -> impl IntoResponse {
    match METRICS_HANDLE.get() {
        Some(handle) => (StatusCode::OK, handle.render()),
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Metrics not configured".to_string(),
        ),
    }
}
