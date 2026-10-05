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

pub async fn api_response_middleware(req: Request, next: Next) -> Response {
    use axum::response::IntoResponse;
    let api = req.uri().path().starts_with("/api/");
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
    response
}

pub async fn security_headers_middleware(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;

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
    let bypass = path.starts_with("/api/stream/")
        || path.starts_with("/api/audio/")
        || path.starts_with("/api/artwork/");
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
    if req
        .headers()
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site")
    {
        return rejected("Cross-site requests are not allowed.");
    }
    if !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS)
        && req
            .headers()
            .get("x-local-amp-token")
            .and_then(|v| v.to_str().ok())
            != Some(state.session_token.as_str())
    {
        return rejected("A valid local session token is required. Reload Local Amp.");
    }
    next.run(req).await
}
