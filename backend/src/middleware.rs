use axum::{
    extract::Request,
    http::{header, HeaderValue},
    middleware::Next,
    response::Response,
};
use tracing::Instrument;
use uuid::Uuid;

pub async fn request_id_middleware(mut req: Request, next: Next) -> Response {
    let request_id = req
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    req.extensions_mut().insert(request_id.clone());
    let started = std::time::Instant::now();

    let span = tracing::info_span!("request", request_id = %request_id, method = %req.method(), path = %req.uri().path());
    let mut res = next.run(req).instrument(span).await;
    metrics::histogram!("http_request_duration_seconds").record(started.elapsed().as_secs_f64());
    metrics::counter!("http_requests_total", "status" => res.status().as_u16().to_string())
        .increment(1);

    if let Ok(val) = HeaderValue::from_str(&request_id) {
        res.headers_mut().insert("x-request-id", val);
    }

    res
}

pub async fn api_response_middleware(
    axum::extract::State(state): axum::extract::State<crate::routes::AppState>,
    req: Request,
    next: Next,
) -> Response {
    use axum::response::IntoResponse;
    let api = req.uri().path().starts_with("/api/");
    let path = req.uri().path().to_owned();
    let response = next.run(req).await;
    if api
        && response.status() != axum::http::StatusCode::RANGE_NOT_SATISFIABLE
        && response.status().is_client_error()
        && !response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|v| v.to_str().unwrap_or("").contains("application/json"))
    {
        return crate::error::AppError::Http {
            status: response.status(),
            message: response
                .status()
                .canonical_reason()
                .unwrap_or("Request failed")
                .into(),
            detail: None,
        }
        .into_response();
    }
    let decorate = response.status().is_success()
        && response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|v| v.to_str().unwrap_or("").contains("application/json"))
        && (path == "/api/state"
            || path == "/api/recent"
            || path.starts_with("/api/library/tracks")
            || path.starts_with("/api/tracks/")
            || path.starts_with("/api/decode/"));
    if !decorate {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, 128 * 1024 * 1024).await else {
        return crate::error::AppError::bad_request("Metadata response exceeded its limit.")
            .into_response();
    };
    if let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
        crate::security::decorate_media(&mut value, &state.session_token);
        if let Ok(body) = serde_json::to_vec(&value) {
            parts.headers.remove(header::CONTENT_LENGTH);
            return Response::from_parts(parts, axum::body::Body::from(body));
        }
    }
    Response::from_parts(parts, axum::body::Body::from(bytes))
}

pub async fn request_read_deadline(
    axum::extract::State(state): axum::extract::State<crate::routes::AppState>,
    req: Request,
    next: Next,
) -> Response {
    use axum::response::IntoResponse;
    let (parts, body) = req.into_parts();
    let timeout = std::time::Duration::from_millis(state.config.request_read_timeout_ms);
    let permit = match tokio::time::timeout(timeout, state.request_bodies.acquire()).await {
        Ok(Ok(permit)) => permit,
        _ => {
            return crate::error::AppError::Http {
                status: axum::http::StatusCode::SERVICE_UNAVAILABLE,
                message: "Server request capacity is busy. Try again.".into(),
                detail: None,
            }
            .into_response()
        }
    };
    let bytes = match tokio::time::timeout(
        timeout,
        axum::body::to_bytes(body, state.config.json_limit_bytes),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => {
            return crate::error::AppError::Http {
                status: axum::http::StatusCode::PAYLOAD_TOO_LARGE,
                message: "Request body exceeds JSON_LIMIT.".into(),
                detail: None,
            }
            .into_response()
        }
        Err(_) => {
            return crate::error::AppError::Http {
                status: axum::http::StatusCode::REQUEST_TIMEOUT,
                message: "Request body took too long.".into(),
                detail: None,
            }
            .into_response()
        }
    };
    drop(permit);
    next.run(Request::from_parts(parts, axum::body::Body::from(bytes)))
        .await
}

pub async fn security_headers_middleware(req: Request, next: Next) -> Response {
    let private = req.uri().path().starts_with("/api/") || req.uri().path().starts_with("/metrics");
    let mut res = next.run(req).await;
    if private {
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }

    res.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    res.headers_mut()
        .insert("Referrer-Policy", HeaderValue::from_static("no-referrer"));
    res.headers_mut().insert(
        "Content-Security-Policy",
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'",
        ),
    );
    res.headers_mut()
        .insert("X-Frame-Options", HeaderValue::from_static("DENY"));

    res
}

pub async fn compression_bypass_middleware(mut req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let bypass = path.starts_with("/api/audio/") || path.starts_with("/api/artwork/");
    let bypass = bypass || path.starts_with("/api/original/") || path.ends_with("/stream");

    if bypass {
        req.headers_mut().remove(header::ACCEPT_ENCODING);
    }

    next.run(req).await
}

pub async fn local_access_middleware(
    axum::extract::State(state): axum::extract::State<crate::routes::AppState>,
    req: Request,
    next: Next,
) -> Response {
    use axum::{
        http::{Method, StatusCode},
        response::IntoResponse,
    };
    let allowed = |authority: &str| {
        authority
            .parse::<axum::http::uri::Authority>()
            .is_ok_and(|value| {
                let host = value.host().trim_matches(['[', ']']);
                (host.eq_ignore_ascii_case("localhost")
                    || host
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback()))
                    && value.port_u16() == Some(state.config.port)
            })
    };
    let rejected = |message: &str| {
        crate::error::AppError::Http {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
            detail: None,
        }
        .into_response()
    };
    if !req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(allowed)
    {
        return rejected("This server only accepts its local address.");
    }
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        let valid = origin
            .to_str()
            .ok()
            .and_then(|s| s.parse::<axum::http::Uri>().ok())
            .is_some_and(|uri| {
                uri.scheme_str() == Some("http")
                    && uri.authority().is_some_and(|a| allowed(a.as_str()))
            });
        if !valid {
            return rejected("Cross-origin requests are not allowed.");
        }
    }
    let public_navigation = req.method() == Method::GET
        && req.uri().path() == "/"
        && req
            .headers()
            .get("sec-fetch-mode")
            .is_some_and(|v| v == "navigate")
        && req
            .headers()
            .get("sec-fetch-dest")
            .is_some_and(|v| v == "document");
    if !public_navigation
        && req
            .headers()
            .get("sec-fetch-site")
            .is_some_and(|v| v == "cross-site")
    {
        return rejected("Cross-site requests are not allowed.");
    }
    let protected =
        req.uri().path().starts_with("/api/") || req.uri().path().starts_with("/metrics");
    let public_identity =
        req.uri().path() == "/api/identity" && matches!(*req.method(), Method::GET | Method::HEAD);
    let authenticated = req
        .headers()
        .get("x-local-amp-token")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|value| crate::security::token_matches(&state.session_token, value));
    let resource = matches!(*req.method(), Method::GET | Method::HEAD)
        && req.uri().path_and_query().is_some_and(|uri| {
            crate::security::capability_matches(&state.session_token, uri.as_str())
        });
    if protected && !public_identity && !authenticated && !resource {
        return rejected("Open Local Amp using its launcher to authorize this browser session.");
    }
    next.run(req).await
}
