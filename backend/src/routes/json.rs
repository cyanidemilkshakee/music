use crate::error::AppError;
use axum::{
    extract::{FromRequest, Request},
    Json,
};
use serde::de::DeserializeOwned;

pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;
    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(req, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|error| AppError::Http {
                status: error.status(),
                message: "Invalid JSON request.".into(),
                detail: Some(error.body_text()),
            })
    }
}
