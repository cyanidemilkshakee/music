#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::zombie_processes
)]

use reqwest::Client;
use std::process::{Child, Command};
use std::time::Duration;
use std::net::TcpListener;
use tempfile::TempDir;

struct ServerGuard {
    child: Child,
    _data_dir: TempDir,
    port: u16,
}

impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn start_server() -> ServerGuard {
    let data_dir = tempfile::tempdir().expect("Failed to create a temporary data directory");
    let port = TcpListener::bind("127.0.0.1:0")
        .expect("Failed to reserve a local port")
        .local_addr()
        .expect("Failed to read local address")
        .port();
    let mut child = Command::new(env!("CARGO_BIN_EXE_backend"))
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("DATA_DIR", data_dir.path())
        .spawn()
        .expect("Failed to start test server");

    let client = Client::new();
    let health_url = format!("http://127.0.0.1:{port}/api/health");
    for _ in 0..50 {
        if client.get(&health_url).send().await.is_ok() {
            return ServerGuard { child, _data_dir: data_dir, port };
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = child.kill();
    let _ = child.wait();
    panic!("Test server did not become ready");
}

fn url(server: &ServerGuard, path: &str) -> String {
    format!("http://127.0.0.1:{}{path}", server.port)
}

#[tokio::test]
async fn test_health_check() {
    let _guard = start_server().await;
    let client = Client::new();

    let res = client
        .get(url(&_guard, "/api/health"))
        .send()
        .await
        .expect("Failed to send request");

    assert!(res.status().is_success() || res.status() == 503); // 503 if ffmpeg is missing
    let json: serde_json::Value = res.json().await.unwrap();
    assert!(json.get("database").is_some());
}

#[tokio::test]
async fn test_get_state() {
    let _guard = start_server().await;
    let client = Client::new();

    let res = client
        .get(url(&_guard, "/api/state"))
        .send()
        .await
        .expect("Failed to send request");

    assert!(res.status().is_success());
    let json: serde_json::Value = res.json().await.unwrap();
    assert!(json.get("tracks").unwrap().is_array());
    assert!(json.get("playlists").unwrap().is_array());
}

#[tokio::test]
async fn test_metrics_exposed() {
    let _guard = start_server().await;
    let client = Client::new();

    let res = client
        .get(url(&_guard, "/metrics"))
        .send()
        .await
        .expect("Failed to send request");

    assert!(res.status().is_success());
    assert!(res.headers().get("content-type").is_some());
}

#[tokio::test]
async fn test_library_sources_exposed() {
    let guard = start_server().await;
    let response = Client::new()
        .get(url(&guard, "/api/library/sources"))
        .send()
        .await
        .expect("Failed to list library sources");

    assert!(response.status().is_success());
    let body: serde_json::Value = response.json().await.unwrap();
    assert!(body["sources"].is_array());
}

#[tokio::test]
async fn test_invalid_scan_reports_a_terminal_failure() {
    let guard = start_server().await;
    let client = Client::new();
    let missing_directory = guard._data_dir.path().join("not-a-library");
    let response = client
        .post(url(&guard, "/api/scan"))
        .json(&serde_json::json!({ "directory": missing_directory }))
        .send()
        .await
        .expect("Failed to start scan");
    assert_eq!(response.status(), 202);
    let job_id = response.json::<serde_json::Value>().await.unwrap()["jobId"]
        .as_str()
        .expect("Expected job ID")
        .to_owned();
    let events = client
        .get(url(&guard, &format!("/api/scan/{job_id}/stream")))
        .send()
        .await
        .expect("Failed to attach to scan stream")
        .text()
        .await
        .expect("Failed to read scan events");
    assert!(events.contains("\"phase\":\"failed\""));
}
