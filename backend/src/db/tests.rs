#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::*;
fn connection() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    migrations::run_migrations(&mut conn).unwrap();
    conn
}
fn track(id: &str, path: &str) -> Track {
    serde_json::from_value(serde_json::json!({"id":id,"path":path,"duration":10,"bitRate":128000,"hasArtwork":false,"tags":{}})).unwrap()
}
fn playlist(conn: &mut Connection, ids: Vec<String>) -> Playlist {
    create_playlist(
        conn,
        Playlist {
            id: "p".into(),
            name: "Test".into(),
            created_at: String::new(),
            updated_at: String::new(),
            track_ids: ids,
        },
    )
    .unwrap()
}
#[test]
fn invalid_playlist_creation_rolls_back() {
    let mut conn = connection();
    let p = Playlist {
        id: "p".into(),
        name: "Test".into(),
        created_at: String::new(),
        updated_at: String::new(),
        track_ids: vec!["missing".into()],
    };
    assert!(create_playlist(&mut conn, p).is_err());
    assert!(get_all_playlists(&conn).unwrap().is_empty());
}
#[test]
fn reorder_is_atomic_and_rejects_duplicates() {
    let mut conn = connection();
    upsert_tracks_batch(&mut conn, &[track("a", "/a"), track("b", "/b")]).unwrap();
    playlist(&mut conn, vec!["a".into(), "b".into()]);
    assert!(
        reliability::replace_playlist_tracks(&mut conn, "p", &["b".into(), "missing".into()])
            .is_err()
    );
    assert_eq!(
        get_playlist_by_id(&conn, "p").unwrap().unwrap().track_ids,
        vec!["a", "b"]
    );
    assert!(
        reliability::replace_playlist_tracks(&mut conn, "p", &["a".into(), "a".into()]).is_err()
    );
    reliability::replace_playlist_tracks(&mut conn, "p", &["b".into(), "a".into()]).unwrap();
    assert_eq!(
        get_playlist_by_id(&conn, "p").unwrap().unwrap().track_ids,
        vec!["b", "a"]
    );
}
#[test]
fn membership_failure_preserves_existing_membership() {
    let mut conn = connection();
    upsert_tracks_batch(&mut conn, &[track("a", "/a")]).unwrap();
    playlist(&mut conn, vec!["a".into()]);
    assert!(reliability::set_memberships(&mut conn, "a", &["missing".into()]).is_err());
    assert_eq!(
        get_playlist_by_id(&conn, "p").unwrap().unwrap().track_ids,
        vec!["a"]
    );
}
#[test]
fn moved_track_preserves_playlist_favorites_and_recent() {
    let mut conn = connection();
    remember_library_source(&mut conn, "/music").unwrap();
    let source: String = conn
        .query_row("SELECT id FROM library_sources", [], |r| r.get(0))
        .unwrap();
    reliability::save_scan_batch(
        &mut conn,
        &[(track("a", "/music/old.wav"), "hash".into())],
        &source,
        "job1",
    )
    .unwrap();
    playlist(&mut conn, vec!["a".into()]);
    reliability::set_favorite(&conn, "a", true).unwrap();
    add_recent(&mut conn, "a").unwrap();
    reliability::save_scan_batch(
        &mut conn,
        &[(track("a", "/music/new.wav"), "hash".into())],
        &source,
        "job2",
    )
    .unwrap();
    assert_eq!(get_library_tracks(&conn).unwrap().len(), 1);
    assert_eq!(
        get_track_by_id(&conn, "a").unwrap().unwrap().path,
        "/music/new.wav"
    );
    assert_eq!(reliability::favorites(&conn).unwrap(), vec!["a"]);
    assert_eq!(get_recent_ids(&conn).unwrap(), vec!["a"]);
    assert_eq!(
        get_playlist_by_id(&conn, "p").unwrap().unwrap().track_ids,
        vec!["a"]
    );
}
#[test]
fn incomplete_walk_does_not_mark_missing_and_complete_walk_preserves_references() {
    let mut conn = connection();
    remember_library_source(&mut conn, "/music").unwrap();
    let source: String = conn
        .query_row("SELECT id FROM library_sources", [], |r| r.get(0))
        .unwrap();
    reliability::save_scan_batch(
        &mut conn,
        &[(track("a", "/music/a.wav"), "hash".into())],
        &source,
        "job1",
    )
    .unwrap();
    playlist(&mut conn, vec!["a".into()]);
    reliability::finish_source(&mut conn, &source, "job2", false).unwrap();
    assert!(get_library_tracks(&conn).unwrap()[0].available);
    reliability::finish_source(&mut conn, &source, "job3", true).unwrap();
    assert!(!get_library_tracks(&conn).unwrap()[0].available);
    assert_eq!(
        get_playlist_by_id(&conn, "p").unwrap().unwrap().track_ids,
        vec!["a"]
    );
}
#[test]
fn scan_results_survive_restart_and_history_is_bounded() {
    let conn = connection();
    for i in 0..40 {
        reliability::save_job(
            &conn,
            &format!("{i:02}"),
            "/music",
            &serde_json::json!({"phase":"complete"}),
            true,
        )
        .unwrap();
    }
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM scan_jobs", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        32
    );
    reliability::save_job(
        &conn,
        "running",
        "/music",
        &serde_json::json!({"phase":"walk","found":0}),
        false,
    )
    .unwrap();
    reliability::recover_interrupted_jobs(&conn).unwrap();
    assert_eq!(
        reliability::get_job(&conn, "running").unwrap().unwrap()["event"]["phase"],
        "failed"
    );
}

#[test]
fn legacy_fractional_javascript_file_timestamps_remain_readable() {
    let mut conn = connection();
    upsert_tracks_batch(&mut conn, &[track("legacy", "C:/Music/legacy.wav")]).unwrap();
    conn.execute(
        "UPDATE tracks SET modifiedAt=1234567890123.75 WHERE id='legacy'",
        [],
    )
    .unwrap();
    assert_eq!(
        get_library_tracks(&conn).unwrap()[0].modified_at,
        Some(1234567890123)
    );
    assert_eq!(
        get_track_by_id(&conn, "legacy")
            .unwrap()
            .unwrap()
            .modified_at,
        Some(1234567890123)
    );
    conn.execute("UPDATE tracks SET modifiedAt=NULL WHERE id='legacy'", [])
        .unwrap();
    assert_eq!(get_library_tracks(&conn).unwrap()[0].modified_at, None);
}
