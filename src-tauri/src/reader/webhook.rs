// webhook.rs — axum HTTP server that accepts text posts on 127.0.0.1:7890
// and emits Tauri "webhook:line" events to the frontend.

use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{any, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};

const MAX_BODY_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub app: AppHandle,
}

#[derive(Serialize, Clone)]
pub struct WebhookLine {
    pub text: String,
    pub ts: i64,
}

#[derive(Serialize, Clone)]
pub struct WebhookError {
    pub code: String,
    pub message: String,
    pub port: u16,
}

#[derive(Deserialize)]
struct JsonPushBody {
    text: Option<String>,
}

pub async fn spawn(app: AppHandle, port: u16) {
    let state = AppState { app: app.clone() };

    let cors = CorsLayer::new()
        .allow_methods(Any)
        .allow_origin(Any)
        .allow_headers(Any);

    let router = Router::new()
        .route("/push", post(push_handler).options(options_handler))
        .fallback(any(fallback_handler))
        .with_state(state)
        .layer(cors);

    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(err) => {
            let code = if err.kind() == std::io::ErrorKind::AddrInUse {
                "EADDRINUSE".to_string()
            } else {
                format!("{:?}", err.kind())
            };
            let _ = app.emit(
                "webhook:error",
                WebhookError {
                    code,
                    message: err.to_string(),
                    port,
                },
            );
            return;
        }
    };

    let _ = app.emit("webhook:ready", serde_json::json!({ "port": port }));

    if let Err(err) = axum::serve(listener, router).await {
        let _ = app.emit(
            "webhook:error",
            WebhookError {
                code: "ServeError".into(),
                message: err.to_string(),
                port,
            },
        );
    }
}

async fn push_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if body.len() > MAX_BODY_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "payload too large").into_response();
    }

    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or("").trim().to_lowercase())
        .unwrap_or_default();

    let text = match content_type.as_str() {
        "text/plain" | "" => match std::str::from_utf8(&body) {
            Ok(s) => s.to_string(),
            Err(_) => return (StatusCode::BAD_REQUEST, "invalid utf-8").into_response(),
        },
        "application/json" => match serde_json::from_slice::<JsonPushBody>(&body) {
            Ok(b) => match b.text {
                Some(t) => t,
                None => return (StatusCode::BAD_REQUEST, "missing text").into_response(),
            },
            Err(_) => return (StatusCode::BAD_REQUEST, "invalid json").into_response(),
        },
        _ => {
            return (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported content-type",
            )
                .into_response()
        }
    };

    if text.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "empty").into_response();
    }

    let ts = chrono_millis();
    let _ = state.app.emit("webhook:line", WebhookLine { text, ts });

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        Json(serde_json::json!({ "ok": true })),
    )
        .into_response()
}

async fn options_handler() -> impl IntoResponse {
    StatusCode::NO_CONTENT
}

async fn fallback_handler() -> impl IntoResponse {
    StatusCode::NOT_FOUND
}

fn chrono_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
