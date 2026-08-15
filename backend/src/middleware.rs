use axum::{
    extract::Request,
    http::{header, HeaderValue},
    middleware::Next,
    response::Response,
};
use uuid::Uuid;

pub async fn request_id_middleware(mut req: Request, next: Next) -> Response {
    let request_id = req
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    req.extensions_mut().insert(request_id.clone());

    let mut res = next.run(req).await;
    
    if let Ok(val) = HeaderValue::from_str(&request_id) {
        res.headers_mut().insert("x-request-id", val);
    }
    
    res
}

pub async fn security_headers_middleware(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    
    res.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    res.headers_mut().insert(
        "Referrer-Policy",
        HeaderValue::from_static("no-referrer"),
    );
    
    res
}

pub async fn compression_bypass_middleware(mut req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let bypass = path.starts_with("/api/stream/")
        || path.starts_with("/api/audio/")
        || path.starts_with("/api/artwork/");
        
    if bypass {
        req.headers_mut().remove(header::ACCEPT_ENCODING);
    }
    
    next.run(req).await
}
