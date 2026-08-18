use axum::{http::StatusCode, response::IntoResponse, routing::get, Router};
use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};
use std::sync::OnceLock;

static METRICS_HANDLE: OnceLock<PrometheusHandle> = OnceLock::new();

pub fn install() {
    let builder = PrometheusBuilder::new();
    let handle = builder
        .install_recorder()
        .expect("Failed to install Prometheus recorder");
    let _ = METRICS_HANDLE.set(handle);
}

pub fn router() -> Router {
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
