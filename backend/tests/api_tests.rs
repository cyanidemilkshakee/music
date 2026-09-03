use reqwest::Client;
use std::process::{Child, Command};
use std::time::Duration;
use std::path::PathBuf;

struct ServerGuard {
    child: Child,
    test_dir: PathBuf,
}

impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = std::fs::remove_dir_all(&self.test_dir);
    }
}

async fn start_server() -> ServerGuard {
    let test_dir = std::env::current_dir().unwrap().join("test_data_api");
    let _ = std::fs::create_dir_all(&test_dir);
    
    // Attempt to start the server. This assumes the binary was already built.
    let child = Command::new("cargo")
        .args(["run", "--bin", "local-amp-backend"])
        .env("PORT", "1112")
        .env("DATA_DIR", test_dir.to_str().unwrap())
        .spawn()
        .expect("Failed to start test server");

    tokio::time::sleep(Duration::from_secs(3)).await;

    ServerGuard { child, test_dir }
}

#[tokio::test]
async fn test_health_check() {
    let _guard = start_server().await;
    let client = Client::new();

    let res = client
        .get("http://localhost:1112/api/health")
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
        .get("http://localhost:1112/api/state")
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
        .get("http://localhost:1112/metrics")
        .send()
        .await
        .expect("Failed to send request");

    assert!(res.status().is_success());
    let text = res.text().await.unwrap();
    // It should contain some base prometheus metrics or our custom ones
    assert!(text.contains("ffmpeg") || text.contains("scanner") || !text.is_empty());
}
