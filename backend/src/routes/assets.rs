use axum::{
    body::Body,
    extract::Request,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};

include!(concat!(env!("OUT_DIR"), "/assets.rs"));

pub async fn serve(req: Request) -> Response {
    let path = match req.uri().path() {
        "/" => "/index.html",
        path => path,
    };
    if !matches!(
        *req.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    ) {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Some((_, bytes)) = ASSETS.iter().find(|(url, _)| *url == path) else {
        return crate::error::AppError::not_found("Resource not found.").into_response();
    };
    let mime = match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    };
    let body = if req.method() == axum::http::Method::HEAD {
        Body::empty()
    } else {
        Body::from(*bytes)
    };
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}
