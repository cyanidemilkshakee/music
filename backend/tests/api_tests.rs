#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::zombie_processes
)]

use reqwest::Client;
use std::net::TcpListener;
use std::process::{Child, Command};
use std::time::Duration;
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
    start_server_with_tools("ffmpeg", "ffprobe").await
}

async fn start_server_with_tools(ffmpeg: &str, ffprobe: &str) -> ServerGuard {
    // A released ephemeral reservation can be reused by another concurrently
    // starting test. Match the actual child, never a foreign ready server.
    for _attempt in 0..8 {
        let data_dir = tempfile::tempdir().expect("Failed to create a temporary data directory");
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("Failed to reserve a local port")
            .local_addr()
            .expect("Failed to read local address")
            .port();
        let mut child = Command::new(env!("CARGO_BIN_EXE_backend"))
            .env("HOST", "127.0.0.1")
            .env("JSON_LIMIT", "20mb")
            .env("MAX_SCAN_FILES", "100000")
            .env("MAX_SCAN_FAILURES", "10000")
            .env("FFMPEG_PATH", ffmpeg)
            .env("FFPROBE_PATH", ffprobe)
            .env("SCAN_CONCURRENCY", "2")
            .env("TRANSCODE_CONCURRENCY", "2")
            .env("STREAM_CONCURRENCY", "4")
            .env("FFPROBE_TIMEOUT_MS", "10000")
            .env("FFMPEG_TIMEOUT_MS", "60000")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .current_dir(data_dir.path())
            .env("PORT", port.to_string())
            .env("DATA_DIR", data_dir.path())
            .spawn()
            .expect("Failed to start test server");
        let client = Client::new();
        for _ in 0..50 {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if let Ok(response) = client
                .get(format!("http://127.0.0.1:{port}/api/session"))
                .send()
                .await
            {
                if response
                    .json::<serde_json::Value>()
                    .await
                    .is_ok_and(|session| {
                        session["app"] == "LocalAmp" && session["processId"] == child.id()
                    })
                {
                    return ServerGuard {
                        child,
                        _data_dir: data_dir,
                        port,
                    };
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    panic!("Test server did not become ready after eight port attempts");
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

async fn token(server: &ServerGuard) -> String {
    Client::new()
        .get(url(server, "/api/session"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap()["token"]
        .as_str()
        .unwrap()
        .into()
}
async fn scan(client: &Client, server: &ServerGuard, path: &std::path::Path) -> serde_json::Value {
    let response = client
        .post(url(server, "/api/scan"))
        .header("x-local-amp-token", token(server).await)
        .json(&serde_json::json!({"directory":path}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    let id = response.json::<serde_json::Value>().await.unwrap()["jobId"]
        .as_str()
        .unwrap()
        .to_owned();
    let events = client
        .get(url(server, &format!("/api/scan/{id}/stream")))
        .send()
        .await
        .unwrap();
    assert!(events.headers().get("content-encoding").is_none());
    let text = events.text().await.unwrap();
    let result = text
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .next_back()
        .unwrap();
    assert_eq!(result["phase"], "complete", "{result}");
    result
}
fn wav(path: &std::path::Path, frequency: u32) {
    let rate = 8000u32;
    let samples = rate * 2;
    let bytes = samples * 2;
    let mut data = Vec::new();
    data.extend_from_slice(b"RIFF");
    data.extend_from_slice(&(36 + bytes).to_le_bytes());
    data.extend_from_slice(b"WAVEfmt ");
    data.extend_from_slice(&16u32.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&rate.to_le_bytes());
    data.extend_from_slice(&(rate * 2).to_le_bytes());
    data.extend_from_slice(&2u16.to_le_bytes());
    data.extend_from_slice(&16u16.to_le_bytes());
    data.extend_from_slice(b"data");
    data.extend_from_slice(&bytes.to_le_bytes());
    for i in 0..samples {
        let value = (f64::sin(i as f64 * frequency as f64 * std::f64::consts::TAU / rate as f64)
            * 1000.0) as i16;
        data.extend_from_slice(&value.to_le_bytes());
    }
    std::fs::write(path, data).unwrap();
}
#[tokio::test]
async fn invalid_scan_is_a_structured_client_error() {
    let server = start_server().await;
    let client = Client::new();
    let response = client
        .post(url(&server, "/api/scan"))
        .header("x-local-amp-token", token(&server).await)
        .json(&serde_json::json!({"directory":server._data_dir.path().join("missing")}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    assert!(response.json::<serde_json::Value>().await.unwrap()["error"].is_string());
}
#[tokio::test]
async fn local_security_and_error_contracts() {
    let server = start_server().await;
    let client = Client::new();
    let token = token(&server).await;
    for (header, value) in [
        ("Host", "attacker.example"),
        ("Origin", "https://attacker.example"),
        ("Origin", "null"),
        ("Sec-Fetch-Site", "cross-site"),
    ] {
        assert_eq!(
            client
                .post(url(&server, "/api/playlists"))
                .header(header, value)
                .header("x-local-amp-token", &token)
                .json(&serde_json::json!({"name":"Attack"}))
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
    }
    assert_eq!(
        client
            .post(url(&server, "/api/playlists"))
            .json(&serde_json::json!({"name":"No token"}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let response = client
        .post(url(&server, "/api/playlists"))
        .header("x-local-amp-token", &token)
        .header("content-type", "application/json")
        .body("{bad")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    assert!(response.headers().get("x-request-id").is_some());
    assert!(response.json::<serde_json::Value>().await.unwrap()["error"].is_string());
    let response = client
        .get(url(&server, "/api/unknown"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    assert!(response.json::<serde_json::Value>().await.unwrap()["error"].is_string());
    let response = client.get(url(&server, "/")).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert!(response
        .text()
        .await
        .unwrap()
        .contains("<title>Local Amp</title>"));
}
#[tokio::test]
async fn successful_scan_rescan_move_and_missing_file_preserve_identity() {
    let server = start_server().await;
    let client = Client::new();
    let root = server._data_dir.path().join("Music");
    std::fs::create_dir(&root).unwrap();
    wav(&root.join("Unicode-音.wav"), 440);
    let first = scan(&client, &server, &root).await;
    assert_eq!(first["imported"], 1);
    let tracks = client
        .get(url(&server, "/api/state"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap()["tracks"]
        .as_array()
        .unwrap()
        .clone();
    let id = tracks[0]["id"].as_str().unwrap().to_owned();
    let token = token(&server).await;
    let playlist = client
        .post(url(&server, "/api/playlists"))
        .header("x-local-amp-token", &token)
        .json(&serde_json::json!({"name":"Preserve"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap()["playlist"]
        .clone();
    let playlist = client
        .put(url(
            &server,
            &format!("/api/playlists/{}/tracks", playlist["id"].as_str().unwrap()),
        ))
        .header("x-local-amp-token", &token)
        .json(&serde_json::json!({"trackIds":[id]}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap()["playlists"][0]
        .clone();
    assert_eq!(playlist["trackIds"], serde_json::json!([id]));
    client
        .put(url(&server, &format!("/api/favorites/{id}")))
        .header("x-local-amp-token", &token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(scan(&client, &server, &root).await["unchanged"], 1);
    std::fs::rename(root.join("Unicode-音.wav"), root.join("Renamed.wav")).unwrap();
    scan(&client, &server, &root).await;
    let state = client
        .get(url(&server, "/api/state"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(state["tracks"].as_array().unwrap().len(), 1);
    assert_eq!(state["tracks"][0]["id"], id);
    assert_eq!(state["playlists"][0]["trackIds"], playlist["trackIds"]);
    assert_eq!(state["favorites"][0], id);
    std::fs::remove_file(root.join("Renamed.wav")).unwrap();
    assert_eq!(scan(&client, &server, &root).await["missing"], 1);
    let state = client
        .get(url(&server, "/api/state"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(state["tracks"][0]["available"], false);
    assert_eq!(state["playlists"][0]["trackIds"][0], id);
}
#[tokio::test]
async fn original_audio_ranges_seek_and_conditional_reads() {
    let server = start_server().await;
    let client = Client::new();
    let root = server._data_dir.path().join("Music");
    std::fs::create_dir(&root).unwrap();
    let file = root.join("Tone.wav");
    wav(&file, 220);
    scan(&client, &server, &root).await;
    let state = client
        .get(url(&server, "/api/state"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    let id = state["tracks"][0]["id"].as_str().unwrap();
    for (query, expected) in [("", 1), ("%", 0), ("_", 0), ("\\", 0)] {
        let response = client
            .get(url(
                &server,
                &format!(
                    "/api/library/tracks?limit=1&q={}",
                    urlencoding::encode(query)
                ),
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let page: serde_json::Value = response.json().await.unwrap();
        assert_eq!(page["total"], expected);
    }
    let data = client
        .post(url(&server, &format!("/api/decode/{id}")))
        .header("x-local-amp-token", token(&server).await)
        .json(&serde_json::json!({"format":"original"}))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    let audio = data["audioUrl"].as_str().unwrap();
    let response = client
        .get(url(&server, audio))
        .header("Range", "bytes=0-9")
        .header("Accept-Encoding", "gzip")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 206);
    assert!(response.headers().get("content-encoding").is_none());
    assert!(response
        .headers()
        .get("content-range")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("bytes 0-9/"));
    let etag = response.headers().get("etag").unwrap().clone();
    assert_eq!(
        response.bytes().await.unwrap().as_ref(),
        &std::fs::read(&file).unwrap()[..10]
    );
    let response = client
        .head(url(&server, audio))
        .header("Range", "bytes=-10")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.headers().get("content-length").unwrap(), "10");
    assert!(response.bytes().await.unwrap().is_empty());
    let response = client
        .get(url(&server, audio))
        .header("Range", "bytes=999999999-")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 416);
    assert!(response.headers().get("content-range").is_some());
    assert_eq!(
        client
            .get(url(&server, audio))
            .header("If-None-Match", etag)
            .send()
            .await
            .unwrap()
            .status(),
        304
    );
}
#[tokio::test]
async fn playlists_validation_atomic_membership_backup_and_paging() {
    let server = start_server().await;
    let client = Client::new();
    let token = token(&server).await;
    let response = client
        .post(url(&server, "/api/playlists"))
        .header("x-local-amp-token", &token)
        .json(&serde_json::json!({"name":"Bad","trackIds":["missing"]}))
        .send()
        .await
        .unwrap();
    // Creation accepts a name; membership is managed through its own endpoint.
    // Obsolete creation fields fail before any playlist is persisted.
    assert_eq!(response.status(), 422);
    let rejected = client
        .get(url(&server, "/api/state"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(rejected["playlists"], serde_json::json!([]));
    let data = client
        .post(url(&server, "/api/playlists"))
        .header("x-local-amp-token", &token)
        .json(&serde_json::json!({"name":"Test"}))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    let id = data["playlist"]["id"].as_str().unwrap();
    assert_eq!(data["playlist"]["trackIds"], serde_json::json!([]));
    assert_eq!(
        client
            .put(url(&server, &format!("/api/playlists/{id}/tracks")))
            .header("x-local-amp-token", &token)
            .json(&serde_json::json!({"trackIds":["missing"]}))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    let unchanged = client
        .get(url(&server, "/api/state"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(unchanged["playlists"][0]["trackIds"], serde_json::json!([]));
    assert_eq!(
        client
            .patch(url(&server, &format!("/api/playlists/{id}")))
            .header("x-local-amp-token", &token)
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        422
    );
    assert_eq!(
        client
            .patch(url(&server, &format!("/api/playlists/{id}")))
            .header("x-local-amp-token", &token)
            .json(&serde_json::json!({"trackIds":[]}))
            .send()
            .await
            .unwrap()
            .status(),
        422
    );
    assert_eq!(
        client
            .patch(url(&server, &format!("/api/playlists/{id}")))
            .header("x-local-amp-token", &token)
            .json(&serde_json::json!({"name":"Renamed"}))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let backup = client
        .get(url(&server, "/api/backup"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(backup["version"], 1);
    let restore = client
        .post(url(&server, "/api/backup/restore"))
        .header("x-local-amp-token", &token)
        .json(&backup)
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(restore["skipped"], 1);
    let page = client
        .get(url(&server, "/api/library/tracks?limit=10"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(page["total"], 0);
    assert_eq!(page["limit"], 10);
    assert_eq!(
        client
            .get(url(&server, "/api/library/tracks?limit=0"))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
}

#[tokio::test]
async fn concurrent_lossless_decode_backup_restore_and_m3u_round_trip() {
    let server = start_server().await;
    let client = Client::new();
    let session_token = token(&server).await;
    let music = tempfile::tempdir().unwrap();
    wav(&music.path().join("Backup 音楽.wav"), 440);
    scan(&client, &server, music.path()).await;
    let state: serde_json::Value = client
        .get(url(&server, "/api/state"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = state["tracks"][0]["id"].as_str().unwrap();
    let conversions = futures_util::future::join_all((0..8).map(|_| {
        let client = &client;
        let server = &server;
        let token = &session_token;
        async move {
            let response = client
                .post(url(server, &format!("/api/decode/{id}")))
                .header("x-local-amp-token", token)
                .json(&serde_json::json!({"format":"flac"}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            response.json::<serde_json::Value>().await.unwrap()
        }
    }))
    .await;
    assert!(conversions
        .iter()
        .all(|conversion| conversion["audioUrl"] == conversions[0]["audioUrl"]));
    let cached = conversions[0]["audioUrl"].as_str().unwrap();
    let audio = client
        .get(url(&server, cached))
        .header("Range", "bytes=0-3")
        .header("Accept-Encoding", "gzip, br")
        .send()
        .await
        .unwrap();
    assert_eq!(audio.status(), 206);
    assert!(audio.headers().get("content-encoding").is_none());
    assert_eq!(audio.bytes().await.unwrap().as_ref(), b"fLaC");
    let cache: serde_json::Value = client
        .get(url(&server, "/api/cache"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(cache["files"], 1);
    let metrics = client
        .get(url(&server, "/metrics"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(
        metrics
            .lines()
            .any(|line| line.starts_with("media_cache_created_total")
                && line.split_whitespace().last() == Some("1")),
        "Expected one conversion; metrics:\n{metrics}"
    );
    let cleared = client
        .post(url(&server, "/api/cache/clear"))
        .header("x-local-amp-token", &session_token)
        .send()
        .await
        .unwrap();
    assert_eq!(cleared.status(), 200);
    let recovered = client
        .get(url(&server, cached))
        .header("Range", "bytes=0-3")
        .send()
        .await
        .unwrap();
    assert_eq!(recovered.status(), 206);
    assert_eq!(recovered.bytes().await.unwrap().as_ref(), b"fLaC");
    assert_eq!(
        client
            .put(url(&server, &format!("/api/favorites/{id}")))
            .header("x-local-amp-token", &session_token)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .post(url(&server, &format!("/api/recent/{id}")))
            .header("x-local-amp-token", &session_token)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let playlist: serde_json::Value = client
        .post(url(&server, "/api/playlists"))
        .header("x-local-amp-token", &session_token)
        .json(&serde_json::json!({"name":"Backup playlist"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let playlist_id = playlist["playlist"]["id"].as_str().unwrap();
    let membership = client
        .put(url(
            &server,
            &format!("/api/playlists/{playlist_id}/tracks"),
        ))
        .header("x-local-amp-token", &session_token)
        .json(&serde_json::json!({"trackIds":[id]}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(
        membership["playlists"][0]["trackIds"],
        serde_json::json!([id])
    );
    let m3u = client
        .get(url(&server, &format!("/api/playlists/{playlist_id}/m3u")))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let imported: serde_json::Value = client
        .post(url(&server, "/api/playlists/import"))
        .header("x-local-amp-token", &session_token)
        .json(&serde_json::json!({"name":"M3U copy","text":m3u.replace('\\',"/")}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(imported["playlist"]["trackIds"][0], id);
    let backup: serde_json::Value = client
        .get(url(&server, "/api/backup"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let second = start_server().await;
    let second_token = token(&second).await;
    let restored = client
        .post(url(&second, "/api/backup/restore"))
        .header("x-local-amp-token", &second_token)
        .json(&backup)
        .send()
        .await
        .unwrap();
    assert_eq!(restored.status(), 200);
    let state: serde_json::Value = client
        .get(url(&second, "/api/state"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(state["tracks"].as_array().unwrap().len(), 1);
    assert_eq!(state["favorites"][0], id);
    assert_eq!(state["playlists"].as_array().unwrap().len(), 2);
    assert_eq!(state["playlists"][0]["trackIds"][0], id);
    let recent: serde_json::Value = client
        .get(url(&second, "/api/recent"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(recent["recentTracks"][0]["id"], id);
    let mut invalid = backup.clone();
    invalid["tracks"][0]["title"] = serde_json::json!("This must roll back");
    let mut bad = invalid["tracks"][0].clone();
    bad["path"] = serde_json::json!("relative/path.wav");
    invalid["tracks"].as_array_mut().unwrap().push(bad);
    assert_eq!(
        client
            .post(url(&second, "/api/backup/restore"))
            .header("x-local-amp-token", &second_token)
            .json(&invalid)
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    let after: serde_json::Value = client
        .get(url(&second, &format!("/api/tracks/{id}")))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(after["track"]["title"], "This must roll back");
}

#[tokio::test]
async fn missing_tools_are_actionable_and_scan_cancellation_finishes() {
    let missing = start_server_with_tools(
        "local-amp-nonexistent-ffmpeg",
        "local-amp-nonexistent-ffprobe",
    )
    .await;
    let client = Client::new();
    let response = client
        .get(url(&missing, "/api/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    let health: serde_json::Value = response.json().await.unwrap();
    assert_eq!(health["checks"]["ffmpeg"], false);
    assert!(health["ffmpeg"]["error"]
        .as_str()
        .unwrap()
        .contains("FFmpeg"));
    let server = start_server().await;
    let session = token(&server).await;
    let music = tempfile::tempdir().unwrap();
    for number in 0..100 {
        wav(&music.path().join(format!("{number}.wav")), 440 + number);
    }
    let start: serde_json::Value = client
        .post(url(&server, "/api/scan"))
        .header("x-local-amp-token", &session)
        .json(&serde_json::json!({"directory":music.path()}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let job = start["jobId"].as_str().unwrap();
    assert_eq!(
        client
            .post(url(&server, &format!("/api/scan/{job}/cancel")))
            .header("x-local-amp-token", &session)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    for _ in 0..100 {
        let snapshot: serde_json::Value = client
            .get(url(&server, &format!("/api/scan/{job}")))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if snapshot["finished"] == true {
            assert_eq!(snapshot["event"]["phase"], "failed");
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("Canceled scan never finished");
}

#[tokio::test]
async fn authorized_shutdown_exits_without_losing_the_database() {
    let mut server = start_server().await;
    let client = Client::new();
    assert_eq!(
        client
            .post(url(&server, "/api/shutdown"))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let response = client
        .post(url(&server, "/api/shutdown"))
        .header("x-local-amp-token", token(&server).await)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    for _ in 0..100 {
        if let Some(status) = server.child.try_wait().unwrap() {
            assert!(status.success());
            assert!(server._data_dir.path().join("local-amp.db").is_file());
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("Graceful shutdown did not exit");
}

#[tokio::test]
async fn configured_json_limit_allows_large_backups_and_rejects_oversize_json() {
    let server = start_server().await;
    let client = Client::new();
    let token = token(&server).await;
    let mut backup = serde_json::json!({
        "version":1,"playlists":[],"favorites":[],"sources":[],"recent":[],
        "tracks":[{"id":"large-backup","path":server._data_dir.path().join("Missing file.wav"),
        "duration":0,"bitRate":0,"hasArtwork":false,"tags":{"padding":"x".repeat(2200000)}}]
    });
    let response = client
        .post(url(&server, "/api/backup/restore"))
        .header("x-local-amp-token", &token)
        .json(&backup)
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        200,
        "Configured 20 MB limit must override Axum's 2 MB JSON default"
    );
    backup["tracks"][0]["tags"]["padding"] = serde_json::json!("x".repeat(21 * 1024 * 1024));
    let response = client
        .post(url(&server, "/api/backup/restore"))
        .header("x-local-amp-token", &token)
        .json(&backup)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 413);
    assert!(response.headers().contains_key("x-request-id"));
    let error: serde_json::Value = response.json().await.unwrap();
    assert!(error["error"].is_string());
}

#[tokio::test]
async fn lightweight_bootstrap_scoped_pages_groups_and_queue_lookup_contract() {
    let server = start_server_with_tools("local-amp-no-ffmpeg", "local-amp-no-ffprobe").await;
    let client = Client::new();
    let session = token(&server).await;
    let available = server._data_dir.path().join("Available.wav");
    std::fs::write(&available, b"fixture").unwrap();
    let backup = serde_json::json!({
        "version":1,"sources":[],"favorites":["b"],"recent":["b"],
        "tracks":[
            {"id":"a","path":available,"title":"Zulu","artist":"Ärtist","album":"Shared","albumArtist":"Band A","genre":"Rock","year":"2020","codec":"flac","duration":179,"discNumber":2,"trackNumber":1,"bitRate":0,"hasArtwork":false,"tags":{}},
            {"id":"b","path":server._data_dir.path().join("Missing.wav"),"title":"Alpha","artist":"ärtist","album":"Shared","albumArtist":"Band A","genre":"Rock","year":"2020","codec":"flac","duration":180,"discNumber":1,"trackNumber":2,"bitRate":0,"hasArtwork":false,"tags":{}}
        ],
        "playlists":[{"id":"ordered","name":"Ordered","createdAt":"2025-01-01","updatedAt":"2025-01-01","trackIds":["b","a"]}]
    });
    client
        .post(url(&server, "/api/backup/restore"))
        .header("x-local-amp-token", &session)
        .json(&backup)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let bootstrap: serde_json::Value = client
        .get(url(&server, "/api/state?includeTracks=false"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(bootstrap["tracks"], serde_json::json!([]));
    assert_eq!(bootstrap["trackIds"], serde_json::json!(["a", "b"]));
    assert_eq!(bootstrap["recentIds"], serde_json::json!(["b"]));
    assert_eq!(bootstrap["favorites"], serde_json::json!(["b"]));
    assert_eq!(
        bootstrap["facets"],
        serde_json::json!({"genre":["Rock"],"year":["2020"],"codec":["flac"]})
    );
    let legacy: serde_json::Value = client
        .get(url(&server, "/api/state"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(legacy["tracks"].as_array().unwrap().len(), 2);
    let page: serde_json::Value = client
        .get(url(
            &server,
            "/api/library/tracks?playlistId=ordered&limit=1",
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(page["total"], 2);
    assert_eq!(page["tracks"][0]["id"], "b");
    let queue: serde_json::Value = client
        .get(url(
            &server,
            "/api/library/tracks?playlistId=ordered&limit=1&offset=99&idsOnly=true",
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(queue["trackIds"], serde_json::json!(["b", "a"]));
    let groups: serde_json::Value = client
        .get(url(&server, "/api/library/tracks?groupBy=album&genre=Rock"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(groups["total"], 1);
    assert_eq!(groups["trackTotal"], 2);
    assert_eq!(groups["groups"][0]["key"], "album:[\"shared\",\"band a\"]");
    assert_eq!(groups["groups"][0]["trackCount"], 2);
    assert_eq!(groups["groups"][0]["artworkTrack"]["id"], "a");
    let group_key = urlencoding::encode("artist:ärtist");
    let scoped:serde_json::Value = client.get(url(&server,&format!("/api/library/tracks?groupType=artist&groupKey={group_key}&favorite=true&recentlyPlayed=true&duration=medium"))).send().await.unwrap().json().await.unwrap();
    assert_eq!(scoped["total"], 1);
    assert_eq!(scoped["tracks"][0]["id"], "b");
    let lookup: serde_json::Value = client
        .post(url(&server, "/api/library/tracks/lookup"))
        .header("x-local-amp-token", &session)
        .json(&serde_json::json!({"ids":["b","missing","a","b"]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let ids: Vec<_> = lookup["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|track| track["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["b", "a", "b"]);
    assert!(lookup["tracks"][0].get("path").is_none());
    let stats: serde_json::Value = client
        .get(url(&server, "/api/stats"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(stats["totalTracks"], 2);
    assert_eq!(stats["availableTracks"], 1);
    assert_eq!(stats["missingTracks"], 1);
    let health = client
        .get(url(&server, "/api/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), 503);
    let health: serde_json::Value = health.json().await.unwrap();
    assert_eq!(health["limits"]["jsonLimitBytes"], 20 * 1024 * 1024);
    assert_eq!(health["limits"]["m3uTextBytes"], 2 * 1024 * 1024);
}

#[tokio::test]
async fn library_query_and_lookup_reject_invalid_contracts_with_json_errors() {
    let server = start_server_with_tools("local-amp-no-ffmpeg", "local-amp-no-ffprobe").await;
    let client = Client::new();
    for path in [
        "/api/library/tracks?sortField=bogus",
        "/api/library/tracks?favorite=1",
        "/api/library/tracks?offset=-1",
        "/api/library/tracks?unknown=true",
        "/api/library/tracks?groupType=album",
        "/api/library/tracks?groupBy=album&idsOnly=true",
        "/api/state?includeTracks=bogus",
    ] {
        let response = client.get(url(&server, path)).send().await.unwrap();
        assert_eq!(response.status(), 400, "{path}");
        assert!(response.headers().contains_key("x-request-id"));
        assert!(response.json::<serde_json::Value>().await.unwrap()["error"].is_string());
    }
    let response = client
        .get(url(&server, "/api/library/tracks?playlistId=missing"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    let session = token(&server).await;
    for ids in [vec!["a"; 1001], vec![""]] {
        let response = client
            .post(url(&server, "/api/library/tracks/lookup"))
            .header("x-local-amp-token", &session)
            .json(&serde_json::json!({"ids":ids}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        assert!(response.json::<serde_json::Value>().await.unwrap()["error"].is_string());
    }
    let response = client
        .post(url(&server, "/api/library/tracks/lookup"))
        .json(&serde_json::json!({"ids":[]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
}

#[tokio::test]
async fn compact_tracks_expose_fresh_artwork_version_after_metadata_refresh() {
    let server = start_server().await;
    let client = Client::new();
    let music = server._data_dir.path().join("Music");
    std::fs::create_dir(&music).unwrap();
    wav(&music.join("Refresh.wav"), 440);
    scan(&client, &server, &music).await;
    let state: serde_json::Value = client
        .get(url(&server, "/api/state"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let before = &state["tracks"][0];
    let id = before["id"].as_str().unwrap();
    assert!(before["metadataExtractedAt"].as_str().is_some());
    let session = token(&server).await;
    client
        .post(url(&server, &format!("/api/recent/{id}")))
        .header("x-local-amp-token", &session)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let refreshed: serde_json::Value = client
        .post(url(&server, &format!("/api/metadata/{id}")))
        .header("x-local-amp-token", &session)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let refreshed = &refreshed["track"];
    let version = &refreshed["metadataExtractedAt"];
    assert_ne!(version, &before["metadataExtractedAt"]);
    assert_eq!(refreshed["modifiedAt"],before["modifiedAt"],"Metadata refresh must change the artwork version even when the audio file timestamp is unchanged");
    for (path, collection) in [
        ("/api/state", "tracks"),
        ("/api/library/tracks", "tracks"),
        ("/api/recent", "recentTracks"),
    ] {
        let data: serde_json::Value = client
            .get(url(&server, path))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            &data[collection][0]["metadataExtractedAt"], version,
            "{path}"
        );
        assert_eq!(data[collection][0]["modifiedAt"], before["modifiedAt"]);
        assert!(data[collection][0].get("path").is_none());
    }
    let lookup: serde_json::Value = client
        .post(url(&server, "/api/library/tracks/lookup"))
        .header("x-local-amp-token", &session)
        .json(&serde_json::json!({"ids":[id]}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(&lookup["tracks"][0]["metadataExtractedAt"], version);
    let groups: serde_json::Value = client
        .get(url(&server, "/api/library/tracks?groupBy=album"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        &groups["groups"][0]["artworkTrack"]["metadataExtractedAt"],
        version
    );
}
