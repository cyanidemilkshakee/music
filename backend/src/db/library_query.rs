use super::{row_to_library_track, LibraryTrack};
use crate::error::AppError;
use rusqlite::{functions::FunctionFlags, params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryQuery {
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "page_limit")]
    pub limit: usize,
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub view: String,
    #[serde(default)]
    pub genre: String,
    #[serde(default)]
    pub year: String,
    #[serde(default)]
    pub codec: String,
    #[serde(default)]
    pub duration: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub recently_played: bool,
    #[serde(default)]
    pub sort_field: String,
    #[serde(default)]
    pub sort_dir: String,
    #[serde(default)]
    pub playlist_id: String,
    #[serde(default)]
    pub group_type: String,
    #[serde(default)]
    pub group_key: String,
    #[serde(default)]
    pub group_by: String,
    #[serde(default)]
    pub ids_only: bool,
}

fn page_limit() -> usize {
    100
}

impl LibraryQuery {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.limit == 0 || self.limit > 1000 || self.offset > i64::MAX as usize {
            return Err(AppError::bad_request(
                "Page limit must be 1 to 1000 and offset must be nonnegative.",
            ));
        }
        if self.q.chars().count() > 256
            || [&self.genre, &self.year, &self.codec]
                .iter()
                .any(|value| value.len() > 1024)
        {
            return Err(AppError::bad_request(
                "Search must be at most 256 characters and filter values at most 1024 bytes.",
            ));
        }
        if !["", "home", "songs", "albums", "artists", "recent"].contains(&self.view.as_str())
            || !["", "short", "medium", "long"].contains(&self.duration.as_str())
            || !["", "none", "title", "album", "duration"].contains(&self.sort_field.as_str())
            || !["", "asc", "desc"].contains(&self.sort_dir.as_str())
            || !["", "album", "artist"].contains(&self.group_type.as_str())
            || !["", "album", "artist"].contains(&self.group_by.as_str())
        {
            return Err(AppError::bad_request(
                "Invalid library scope, filter, grouping or sort option.",
            ));
        }
        if self.playlist_id.len() > 200
            || self.group_key.len() > 4096
            || self.group_type.is_empty() != self.group_key.is_empty()
            || (!self.playlist_id.is_empty() && !self.group_type.is_empty())
            || (!self.group_by.is_empty() && self.ids_only)
            || (!self.group_key.is_empty()
                && !self.group_key.starts_with(&format!("{}:", self.group_type)))
        {
            return Err(AppError::bad_request(
                "Invalid or conflicting library scope.",
            ));
        }
        Ok(())
    }
}

/// SQLite's built-in lower() handles ASCII only. These functions keep Unicode
/// search and canonical collection keys consistent with the browser.
pub fn register_functions(conn: &Connection) -> Result<(), rusqlite::Error> {
    let flags = FunctionFlags::SQLITE_UTF8
        | FunctionFlags::SQLITE_DETERMINISTIC
        | FunctionFlags::SQLITE_INNOCUOUS;
    conn.create_scalar_function("amp_lower", 1, flags, |context| {
        Ok(context.get::<String>(0)?.to_lowercase())
    })?;
    conn.create_scalar_function("amp_group_key", 4, flags, |context| {
        let kind = context.get::<String>(0)?;
        let album = context
            .get::<Option<String>>(1)?
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Unknown Album".into());
        let artist = context
            .get::<Option<String>>(3)?
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Unknown Artist".into());
        let label = if kind == "album" {
            let album_artist = context
                .get::<Option<String>>(2)?
                .filter(|value| !value.is_empty())
                .unwrap_or(artist);
            serde_json::json!([album, album_artist]).to_string()
        } else {
            artist
        };
        Ok(format!("{kind}:{}", label.trim().to_lowercase()))
    })
}

#[derive(Default, Serialize)]
pub struct Facets {
    pub genre: Vec<String>,
    pub year: Vec<String>,
    pub codec: Vec<String>,
}

pub fn facets(conn: &Connection) -> Result<Facets, AppError> {
    fn values(conn: &Connection, column: &str) -> Result<Vec<String>, AppError> {
        let mut statement = conn.prepare(&format!("SELECT DISTINCT trim({column}) AS value FROM tracks WHERE trim(COALESCE({column},'')) != '' ORDER BY amp_lower(value),value"))?;
        let values = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(values)
    }
    Ok(Facets {
        genre: values(conn, "genre")?,
        year: values(conn, "year")?,
        codec: values(conn, "codec")?,
    })
}

pub fn all_ids(conn: &Connection) -> Result<Vec<String>, AppError> {
    let mut statement = conn.prepare("SELECT id FROM tracks ORDER BY id")?;
    let ids = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

pub fn lookup(conn: &Connection, ids: &[String]) -> Result<Vec<LibraryTrack>, AppError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let marks = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let mut statement = conn.prepare(&format!("SELECT * FROM tracks WHERE id IN ({marks})"))?;
    let tracks = statement
        .query_map(params_from_iter(ids), row_to_library_track)?
        .collect::<Result<Vec<_>, _>>()?;
    let by_id: HashMap<_, _> = tracks
        .into_iter()
        .map(|track| (track.id.clone(), track))
        .collect();
    Ok(ids.iter().filter_map(|id| by_id.get(id).cloned()).collect())
}

fn predicate(query: &LibraryQuery) -> (String, Vec<Value>) {
    let mut clauses = vec!["1=1".to_string()];
    let mut parameters = Vec::new();
    let mut bound = |clause: String, value: String| {
        parameters.push(Value::Text(value));
        clauses.push(clause.replace('$', &format!("?{}", parameters.len())));
    };
    if !query.q.trim().is_empty() {
        bound("instr(amp_lower(COALESCE(t.title,'') || ' ' || COALESCE(t.artist,'') || ' ' || COALESCE(t.album,'')),amp_lower($))>0".into(), query.q.trim().into());
    }
    for (column, value) in [
        ("genre", &query.genre),
        ("year", &query.year),
        ("codec", &query.codec),
    ] {
        if !value.is_empty() {
            bound(format!("trim(COALESCE(t.{column},''))=$"), value.clone());
        }
    }
    if !query.playlist_id.is_empty() {
        bound(
            "EXISTS(SELECT 1 FROM playlist_tracks pt WHERE pt.trackId=t.id AND pt.playlistId=$)"
                .into(),
            query.playlist_id.clone(),
        );
    }
    if !query.group_type.is_empty() {
        bound(
            format!(
                "amp_group_key('{}',t.album,t.albumArtist,t.artist)=$",
                query.group_type
            ),
            query.group_key.clone(),
        );
    }
    if query.favorite {
        clauses.push("EXISTS(SELECT 1 FROM favorites f WHERE f.trackId=t.id)".into());
    }
    if query.recently_played {
        clauses.push("EXISTS(SELECT 1 FROM recent r WHERE r.trackId=t.id)".into());
    }
    match query.duration.as_str() {
        "short" => clauses.push("COALESCE(t.duration,0)<180".into()),
        "medium" => clauses.push("COALESCE(t.duration,0) BETWEEN 180 AND 360".into()),
        "long" => clauses.push("COALESCE(t.duration,0)>360".into()),
        _ => {}
    }
    (clauses.join(" AND "), parameters)
}

fn ordering(query: &LibraryQuery, parameters: &mut Vec<Value>) -> String {
    if query.view == "recent" && query.group_type.is_empty() && query.playlist_id.is_empty() {
        return "COALESCE((julianday(t.importedAt)-2440587.5)*86400000,t.modifiedAt,0) DESC,t.id ASC".into();
    }
    if !query.sort_field.is_empty() && query.sort_field != "none" {
        let field = match query.sort_field.as_str() {
            "duration" => "COALESCE(t.duration,0)",
            "album" => "amp_lower(COALESCE(t.album,''))",
            _ => "amp_lower(COALESCE(t.title,''))",
        };
        let direction = if query.sort_dir == "desc" {
            "DESC"
        } else {
            "ASC"
        };
        return format!("{field} {direction},t.id ASC");
    }
    if !query.playlist_id.is_empty() {
        parameters.push(Value::Text(query.playlist_id.clone()));
        return format!("(SELECT pt.position FROM playlist_tracks pt WHERE pt.trackId=t.id AND pt.playlistId=?{}) ASC,t.id ASC", parameters.len());
    }
    match query.group_type.as_str() {
        "album" => "COALESCE(t.discNumber,0),COALESCE(t.trackNumber,0),amp_lower(COALESCE(t.title,'')),t.id".into(),
        "artist" => "amp_lower(COALESCE(t.album,'')),COALESCE(t.discNumber,0),COALESCE(t.trackNumber,0),amp_lower(COALESCE(t.title,'')),t.id".into(),
        _ => "amp_lower(COALESCE(t.artist,'')),amp_lower(COALESCE(t.album,'')),COALESCE(t.discNumber,0),COALESCE(t.trackNumber,0),amp_lower(COALESCE(t.title,'')),t.id".into(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Group {
    r#type: String,
    key: String,
    name: String,
    track_count: i64,
    duration: f64,
    artists: Vec<String>,
    album_count: i64,
    artwork_track: Option<LibraryTrack>,
    #[serde(skip)]
    artwork_id: String,
}

pub fn query(conn: &Connection, query: &LibraryQuery) -> Result<serde_json::Value, AppError> {
    query.validate()?;
    // Keep the count, page and artwork representatives in one read snapshot.
    let transaction = conn.unchecked_transaction()?;
    if !query.playlist_id.is_empty()
        && !transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM playlists WHERE id=?)",
            [&query.playlist_id],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Err(AppError::not_found("Playlist not found."));
    }
    let (predicate, mut parameters) = predicate(query);
    let track_total: i64 = transaction.query_row(
        &format!("SELECT COUNT(*) FROM tracks t WHERE {predicate}"),
        params_from_iter(&parameters),
        |row| row.get(0),
    )?;
    let value = if !query.group_by.is_empty() {
        let key = format!(
            "amp_group_key('{}',t.album,t.albumArtist,t.artist)",
            query.group_by
        );
        let name = if query.group_by == "album" {
            "COALESCE(NULLIF(t.album,''),'Unknown Album')"
        } else {
            "COALESCE(NULLIF(t.artist,''),'Unknown Artist')"
        };
        let total: i64 = transaction.query_row(
            &format!("SELECT COUNT(DISTINCT {key}) FROM tracks t WHERE {predicate}"),
            params_from_iter(&parameters),
            |row| row.get(0),
        )?;
        parameters.push(Value::Integer(query.limit as i64));
        parameters.push(Value::Integer(query.offset as i64));
        let mut statement = transaction.prepare(&format!("SELECT {key} AS groupKey,MIN({name}) AS name,COUNT(*) AS trackCount,COALESCE(SUM(t.duration),0) AS duration,json_group_array(DISTINCT COALESCE(NULLIF(t.artist,''),'Unknown Artist')) AS artists,COUNT(DISTINCT amp_group_key('album',t.album,t.albumArtist,t.artist)) AS albumCount,COALESCE(MIN(CASE WHEN t.hasArtwork=1 AND t.available=1 THEN t.id END),MIN(CASE WHEN t.available=1 THEN t.id END),MIN(t.id)) AS artworkId FROM tracks t WHERE {predicate} GROUP BY groupKey ORDER BY amp_lower(name),groupKey LIMIT ?{} OFFSET ?{}", parameters.len()-1, parameters.len()))?;
        let mut groups = statement
            .query_map(params_from_iter(&parameters), |row| {
                let artists: String = row.get("artists")?;
                let mut artists: Vec<String> = serde_json::from_str(&artists).unwrap_or_default();
                artists.sort_by(|left, right| {
                    left.to_lowercase()
                        .cmp(&right.to_lowercase())
                        .then_with(|| left.cmp(right))
                });
                Ok(Group {
                    r#type: query.group_by.clone(),
                    key: row.get("groupKey")?,
                    name: row.get("name")?,
                    track_count: row.get("trackCount")?,
                    duration: row.get("duration")?,
                    artists,
                    album_count: row.get("albumCount")?,
                    artwork_id: row.get("artworkId")?,
                    artwork_track: None,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let artwork = lookup(
            &transaction,
            &groups
                .iter()
                .map(|group| group.artwork_id.clone())
                .collect::<Vec<_>>(),
        )?;
        let by_id: HashMap<_, _> = artwork
            .into_iter()
            .map(|track| (track.id.clone(), track))
            .collect();
        for group in &mut groups {
            group.artwork_track = by_id.get(&group.artwork_id).cloned();
        }
        serde_json::json!({"groups":groups,"total":total,"trackTotal":track_total,"offset":query.offset,"limit":query.limit})
    } else {
        let order = ordering(query, &mut parameters);
        if query.ids_only {
            let mut statement = transaction.prepare(&format!(
                "SELECT t.id FROM tracks t WHERE {predicate} ORDER BY {order}"
            ))?;
            let ids = statement
                .query_map(params_from_iter(&parameters), |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            serde_json::json!({"trackIds":ids,"total":track_total,"offset":0,"limit":query.limit})
        } else {
            parameters.push(Value::Integer(query.limit as i64));
            parameters.push(Value::Integer(query.offset as i64));
            let mut statement = transaction.prepare(&format!(
                "SELECT t.* FROM tracks t WHERE {predicate} ORDER BY {order} LIMIT ?{} OFFSET ?{}",
                parameters.len() - 1,
                parameters.len()
            ))?;
            let tracks = statement
                .query_map(params_from_iter(&parameters), row_to_library_track)?
                .collect::<Result<Vec<_>, _>>()?;
            serde_json::json!({"tracks":tracks,"total":track_total,"offset":query.offset,"limit":query.limit})
        }
    };
    transaction.commit()?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;
    use crate::db::{migrations, upsert_tracks_batch, Track};
    use serde_json::{json, Value};

    fn fixture() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        register_functions(&conn).unwrap();
        migrations::run_migrations(&mut conn).unwrap();
        let tracks: Vec<Track> = [
            ("a", "Zulu", "ÄRTIST", "Shared", "Band A", 179.0, 2, 1, "Rock", "2020", "flac", "2025-01-01T00:00:00Z"),
            ("b", "Alpha", "ärtist", "Shared", "Band A", 180.0, 1, 2, "Rock", "2020", "flac", "2025-01-02T00:00:00Z"),
            ("c", "Beta", "Other", "Shared", "Band B", 360.0, 1, 1, "Jazz", "2021", "mp3", "2025-01-03T00:00:00Z"),
            ("d", "Delta", "Other", "Elsewhere", "Other", 361.0, 1, 3, "Jazz", "2021", "mp3", "2025-01-04T00:00:00Z"),
            ("e", "Literal %_\\ title", "", "", "", 0.0, 0, 0, "", "", "wav", ""),
        ].into_iter().map(|(id,title,artist,album,album_artist,duration,disc,number,genre,year,codec,imported)| {
            serde_json::from_value(json!({"id":id,"path":format!("/music/{id}"),"title":title,"artist":artist,"album":album,"albumArtist":album_artist,"duration":duration,"discNumber":disc,"trackNumber":number,"genre":genre,"year":year,"codec":codec,"importedAt":imported,"modifiedAt":1,"bitRate":0,"hasArtwork":id=="b","tags":{}})).unwrap()
        }).collect();
        upsert_tracks_batch(&mut conn, &tracks).unwrap();
        conn.execute_batch("INSERT INTO playlists VALUES ('p','Ordered','2025-01-01','2025-01-01');INSERT INTO playlist_tracks VALUES ('p','d',0),('p','b',1),('p','a',2); INSERT INTO favorites VALUES ('b'),('d'); INSERT INTO recent(trackId,playedAt) VALUES ('b',100); UPDATE tracks SET available=0 WHERE id='e';").unwrap();
        conn
    }
    fn page(conn: &Connection, options: Value) -> Value {
        query(conn, &serde_json::from_value(options).unwrap()).unwrap()
    }
    fn ids(page: &Value) -> Vec<&str> {
        page["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|track| track["id"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn filtered_counts_duration_boundaries_and_literal_unicode_search() {
        let conn = fixture();
        assert_eq!(ids(&page(&conn, json!({"duration":"short"}))).len(), 2);
        assert_eq!(
            ids(&page(
                &conn,
                json!({"duration":"medium","sortField":"duration"})
            )),
            vec!["b", "c"]
        );
        assert_eq!(ids(&page(&conn, json!({"duration":"long"}))), vec!["d"]);
        let filtered = page(
            &conn,
            json!({"genre":"Rock","year":"2020","codec":"flac","favorite":true,"recentlyPlayed":true}),
        );
        assert_eq!(filtered["total"], 1);
        assert_eq!(ids(&filtered), vec!["b"]);
        assert_eq!(page(&conn, json!({"q":"ärtist"}))["total"], 2);
        assert_eq!(page(&conn, json!({"q":"Zulu ÄRTIST Shared"}))["total"], 1);
        assert_eq!(ids(&page(&conn, json!({"q":"%_\\"}))), vec!["e"]);
        assert_eq!(page(&conn, json!({"q":"' OR 1=1 --"}))["total"], 0);
    }

    #[test]
    fn deterministic_pages_queue_ids_playlist_and_recent_order() {
        let conn = fixture();
        let first = page(&conn, json!({"sortField":"title","limit":2}));
        let second = page(&conn, json!({"sortField":"title","limit":2,"offset":2}));
        assert_eq!(first["total"], 5);
        assert_eq!(ids(&first), vec!["b", "c"]);
        assert_eq!(ids(&second), vec!["d", "e"]);
        let all = page(
            &conn,
            json!({"sortField":"title","limit":1,"offset":99,"idsOnly":true}),
        );
        assert_eq!(all["trackIds"], json!(["b", "c", "d", "e", "a"]));
        assert!(all.get("tracks").is_none());
        assert_eq!(
            ids(&page(&conn, json!({"playlistId":"p"}))),
            vec!["d", "b", "a"]
        );
        assert_eq!(
            ids(&page(
                &conn,
                json!({"playlistId":"p","sortField":"duration","sortDir":"desc"})
            )),
            vec!["d", "b", "a"]
        );
        let recent = page(
            &conn,
            json!({"view":"recent","sortField":"title","limit":2}),
        );
        assert_eq!(ids(&recent), vec!["d", "c"]);
        let invalid: LibraryQuery =
            serde_json::from_value(json!({"playlistId":"missing"})).unwrap();
        assert!(matches!(
            query(&conn, &invalid),
            Err(AppError::Http {
                status: axum::http::StatusCode::NOT_FOUND,
                ..
            })
        ));
    }

    #[test]
    fn group_summaries_and_scopes_match_unicode_and_album_artist_keys() {
        let conn = fixture();
        let albums = page(&conn, json!({"groupBy":"album","limit":100}));
        assert_eq!(albums["total"], 4);
        assert_eq!(albums["trackTotal"], 5);
        let group = albums["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|group| group["key"] == "album:[\"shared\",\"band a\"]")
            .unwrap();
        assert_eq!(group["trackCount"], 2);
        assert_eq!(group["duration"], 359.0);
        assert_eq!(group["artworkTrack"]["id"], "b");
        assert_eq!(
            ids(&page(
                &conn,
                json!({"groupType":"album","groupKey":group["key"]})
            )),
            vec!["b", "a"]
        );
        let artists = page(&conn, json!({"groupBy":"artist"}));
        assert_eq!(artists["total"], 3);
        let artist = artists["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|group| group["key"] == "artist:ärtist")
            .unwrap();
        assert_eq!(artist["trackCount"], 2);
        assert_eq!(
            ids(&page(
                &conn,
                json!({"groupType":"artist","groupKey":"artist:ärtist"})
            )),
            vec!["b", "a"]
        );
        let filtered = page(
            &conn,
            json!({"groupBy":"album","favorite":true,"limit":1,"offset":1}),
        );
        assert_eq!(filtered["total"], 2);
        assert_eq!(filtered["trackTotal"], 2);
        assert_eq!(filtered["groups"].as_array().unwrap().len(), 1);
        // Releases with the same title and different album artists remain
        // separate albums even when browsing a shared contributing artist.
        conn.execute("UPDATE tracks SET artist='ärtist' WHERE id='c'", [])
            .unwrap();
        let artists = page(&conn, json!({"groupBy":"artist"}));
        let artist = artists["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|group| group["key"] == "artist:ärtist")
            .unwrap();
        assert_eq!(artist["trackCount"], 3);
        assert_eq!(artist["albumCount"], 2);
    }

    #[test]
    fn facets_lookup_and_invalid_queries_are_safe() {
        let conn = fixture();
        assert_eq!(facets(&conn).unwrap().genre, vec!["Jazz", "Rock"]);
        assert_eq!(all_ids(&conn).unwrap(), vec!["a", "b", "c", "d", "e"]);
        let requested = vec!["d".into(), "missing".into(), "b".into(), "d".into()];
        assert_eq!(
            lookup(&conn, &requested)
                .unwrap()
                .iter()
                .map(|track| track.id.as_str())
                .collect::<Vec<_>>(),
            vec!["d", "b", "d"]
        );
        assert!(lookup(&conn, &[]).unwrap().is_empty());
        for options in [
            json!({"limit":0}),
            json!({"limit":1001}),
            json!({"q":"x".repeat(257)}),
            json!({"sortField":"title;DROP TABLE tracks"}),
            json!({"duration":"bad"}),
            json!({"groupType":"album"}),
            json!({"groupType":"album","groupKey":"artist:other"}),
            json!({"groupBy":"artist","idsOnly":true}),
            json!({"playlistId":"p","groupType":"artist","groupKey":"artist:other"}),
        ] {
            let options: LibraryQuery = serde_json::from_value(options).unwrap();
            assert!(query(&conn, &options).is_err());
        }
        assert!(serde_json::from_value::<LibraryQuery>(json!({"unknown":1})).is_err());
    }
}
