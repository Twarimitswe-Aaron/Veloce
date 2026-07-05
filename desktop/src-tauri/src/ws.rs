use std::collections::HashMap;
use std::net::{Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State as AxumState,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};

use crate::config::Config;
use crate::download::{self, StartDownloadRequest};
use crate::state::AppState;

/// Thread-safe registry of connected WebSocket clients.
pub struct WsClients {
    next_id: Mutex<u64>,
    clients: Mutex<HashMap<u64, tokio::sync::mpsc::UnboundedSender<String>>>,
}

impl WsClients {
    pub fn new() -> Self {
        Self {
            next_id: Mutex::new(0),
            clients: Mutex::new(HashMap::new()),
        }
    }

    pub fn add(&self, tx: tokio::sync::mpsc::UnboundedSender<String>) -> u64 {
        let mut next = self.next_id.lock().unwrap();
        let id = *next;
        *next += 1;
        self.clients.lock().unwrap().insert(id, tx);
        id
    }

    pub fn remove(&self, id: u64) {
        self.clients.lock().unwrap().remove(&id);
    }

    pub fn broadcast(&self, msg: &str) {
        let mut clients = self.clients.lock().unwrap();
        clients.retain(|_id, tx| tx.send(msg.to_string()).is_ok());
    }

    pub fn broadcast_progress(
        &self,
        download_id: &str,
        downloaded: u64,
        total: u64,
        speed_bps: u64,
        eta_secs: u64,
    ) {
        let msg = serde_json::json!({
            "type": "PROGRESS",
            "downloadId": download_id,
            "downloaded": downloaded,
            "total": total,
            "speedBps": speed_bps,
            "etaSecs": eta_secs,
        })
        .to_string();
        self.broadcast(&msg);
    }

    pub fn broadcast_ack(&self, download_id: &str, file_name: &str, status: &str) {
        let msg = serde_json::json!({
            "type": "DOWNLOAD_ACK",
            "downloadId": download_id,
            "fileName": file_name,
            "status": status,
        })
        .to_string();
        self.broadcast(&msg);
    }

    pub fn broadcast_completed(&self, download_id: &str, status: &str) {
        let msg = serde_json::json!({
            "type": "DOWNLOAD_COMPLETED",
            "downloadId": download_id,
            "status": status,
        })
        .to_string();
        self.broadcast(&msg);
    }

    pub fn broadcast_error(&self, download_id: &str, error: &str) {
        let msg = serde_json::json!({
            "type": "DOWNLOAD_ERROR",
            "downloadId": download_id,
            "error": error,
        })
        .to_string();
        self.broadcast(&msg);
    }

    pub fn broadcast_paused(&self, download_id: &str) {
        let msg = serde_json::json!({
            "type": "DOWNLOAD_PAUSED",
            "downloadId": download_id,
        })
        .to_string();
        self.broadcast(&msg);
    }

    pub fn broadcast_removed(&self, download_id: &str) {
        let msg = serde_json::json!({
            "type": "DOWNLOAD_REMOVED",
            "downloadId": download_id,
        })
        .to_string();
        self.broadcast(&msg);
    }
}

pub struct WsState {
    pub app: Arc<AppState>,
    pub clients: Arc<WsClients>,
}

pub async fn start_ws_server(app: Arc<AppState>, clients: Arc<WsClients>, port: u16) {
    let ws_state = Arc::new(WsState {
        app,
        clients: clients.clone(),
    });

    let router = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(ws_state);

    let listener = bind_ws_listener(port).await;
    log::info!(
        "WebSocket server listening on ws://127.0.0.1:{}/ws (also ws://localhost:{}/ws)",
        port,
        port
    );

    axum::serve(listener, router)
        .await
        .expect("WebSocket server exited with error");
}

/// Bind dual-stack `[::]:port` so `localhost` works when it resolves to `::1`.
/// Falls back to `0.0.0.0` when IPv6 is unavailable.
async fn bind_ws_listener(port: u16) -> tokio::net::TcpListener {
    let v6 = SocketAddr::from((Ipv6Addr::UNSPECIFIED, port));
    match tokio::net::TcpListener::bind(v6).await {
        Ok(listener) => listener,
        Err(e) => {
            log::warn!("IPv6 bind on port {} failed ({}), using 0.0.0.0", port, e);
            let v4 = SocketAddr::from(([0, 0, 0, 0], port));
            tokio::net::TcpListener::bind(v4)
                .await
                .expect("Failed to bind WebSocket server — is port 14921 already in use?")
        }
    }
}

fn verify_origin(headers: &HeaderMap) -> bool {
    let config = Config::from_env();
    let origin = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if origin.is_empty() {
        return true;
    }
    if origin.starts_with("chrome-extension://") || origin.starts_with("moz-extension://") {
        if config.allowed_extension_ids.is_empty() {
            return true;
        }
        let id = origin
            .trim_start_matches("chrome-extension://")
            .trim_start_matches("moz-extension://")
            .split('/')
            .next()
            .unwrap_or("");
        return config.allowed_extension_ids.iter().any(|allowed| allowed == id);
    }
    if let Ok(parsed) = url::Url::parse(origin) {
        return parsed.host_str() == Some("localhost") || parsed.host_str() == Some("127.0.0.1");
    }
    false
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    AxumState(state): AxumState<Arc<WsState>>,
) -> Response {
    if !verify_origin(&headers) {
        log::warn!("Rejected WebSocket from disallowed origin");
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state)).into_response()
}

async fn handle_socket(socket: WebSocket, state: Arc<WsState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (msg_tx, mut msg_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let client_id = state.clients.add(msg_tx.clone());
    send_initial_state(&state.app, &msg_tx);

    let forward_task = tokio::spawn(async move {
        while let Some(msg) = msg_rx.recv().await {
            if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_rx.next().await {
        if let Message::Text(text) = msg {
            handle_message(&text, &state, &msg_tx).await;
        }
    }

    state.clients.remove(client_id);
    forward_task.abort();
}

fn send_initial_state(app: &AppState, tx: &tokio::sync::mpsc::UnboundedSender<String>) {
    let config = Config::from_env();
    let _ = tx.send(
        serde_json::json!({
            "type": "DIRECTORY_SELECTED",
            "payload": { "path": config.base_directory().to_string_lossy() }
        })
        .to_string(),
    );
    let _ = tx.send(
        serde_json::json!({
            "type": "SETTINGS",
            "settings": {
                "maxConcurrentDownloads": config.max_concurrent_downloads,
                "defaultThreads": config.default_threads,
                "maxRateBytes": config.max_rate_bytes,
                "baseDirectory": config.base_directory().to_string_lossy().to_string(),
                "engineQuiet": config.engine_quiet,
            }
        })
        .to_string(),
    );

    if let Ok(recent) = app.db.list_recent_downloads("extension", 20) {
        let snapshot: Vec<serde_json::Value> = recent
            .iter()
            .map(|d| {
                serde_json::json!({
                    "downloadId": d.id,
                    "fileName": d.file_name,
                    "status": d.status,
                    "downloaded": d.downloaded_bytes.unwrap_or(0),
                    "total": d.total_bytes.unwrap_or(0),
                })
            })
            .collect();
        if !snapshot.is_empty() {
            let _ = tx.send(
                serde_json::json!({
                    "type": "DOWNLOAD_SNAPSHOT",
                    "downloads": snapshot,
                })
                .to_string(),
            );
        }
    }
}

async fn handle_message(
    text: &str,
    state: &Arc<WsState>,
    tx: &tokio::sync::mpsc::UnboundedSender<String>,
) {
    let data: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    let msg_type = data["type"].as_str().unwrap_or("");

    match msg_type {
        "PING" => {
            let _ = tx.send(serde_json::json!({"type": "PONG"}).to_string());
        }

        "LIST_FORMATS" => {
            let url = data["payload"]["url"].as_str().unwrap_or("").to_string();
            let force = data["payload"]["force"].as_bool().unwrap_or(false);
            let request_id = data["requestId"].as_str().unwrap_or("").to_string();
            let app = state.app.clone();
            let tx = tx.clone();

            // Do not block the WebSocket read loop — prefetches and user clicks share one connection.
            tokio::spawn(async move {
                match download::list_formats_for_url(&app, &url, force).await {
                    Ok(formats) if formats.is_empty() => {
                        let _ = tx.send(
                            serde_json::json!({
                                "type": "FORMATS_ERROR",
                                "requestId": request_id,
                                "error": "No formats found for this URL.",
                            })
                            .to_string(),
                        );
                    }
                    Ok(formats) => {
                        let formats_json: Vec<serde_json::Value> = formats
                            .iter()
                            .map(|f| {
                                serde_json::json!({
                                    "id": f.id,
                                    "label": f.label,
                                    "url": f.url,
                                    "ext": f.ext,
                                    "filesize": f.filesize,
                                    "source": f.source,
                                    "kind": f.kind,
                                })
                            })
                            .collect();
                        let _ = tx.send(
                            serde_json::json!({
                                "type": "FORMATS_LIST",
                                "requestId": request_id,
                                "formats": formats_json,
                            })
                            .to_string(),
                        );
                    }
                    Err(e) => {
                        let _ = tx.send(
                            serde_json::json!({
                                "type": "FORMATS_ERROR",
                                "requestId": request_id,
                                "error": e,
                            })
                            .to_string(),
                        );
                    }
                }
            });
        }

        "NEW_DOWNLOAD" => {
            let payload = &data["payload"];
            let url = payload["url"].as_str().unwrap_or("");
            let direct_url = payload["directUrl"].as_str().map(|s| s.to_string());
            let file_name = payload["fileName"].as_str().unwrap_or("download_file");
            let referer = payload["referer"]
                .as_str()
                .or_else(|| payload["pageUrl"].as_str())
                .map(|s| s.to_string());

            if url.is_empty() {
                let _ = tx.send(
                    serde_json::json!({
                        "type": "DOWNLOAD_ERROR",
                        "downloadId": null,
                        "error": "No URL provided"
                    })
                    .to_string(),
                );
                return;
            }

            if !crate::util::is_safe_download_url(url) {
                let _ = tx.send(
                    serde_json::json!({
                        "type": "DOWNLOAD_ERROR",
                        "downloadId": null,
                        "error": "Blocked: download URL points to a private or local network address"
                    })
                    .to_string(),
                );
                return;
            }

            if let Some(ref direct) = direct_url {
                if !crate::util::is_safe_download_url(direct) {
                    let _ = tx.send(
                        serde_json::json!({
                            "type": "DOWNLOAD_ERROR",
                            "downloadId": null,
                            "error": "Blocked: direct URL points to a private or local network address"
                        })
                        .to_string(),
                    );
                    return;
                }
            }

            let download_id = uuid::Uuid::new_v4().to_string();

            let app_state = state.app.clone();
            let req = StartDownloadRequest {
                url: url.to_string(),
                direct_url,
                file_name: file_name.to_string(),
                referer,
                device_id: "extension".to_string(),
                download_id: Some(download_id.clone()),
                save_path: None,
            };

            tokio::spawn(async move {
                if let Err(e) = download::start_download_job(app_state, req).await {
                    log::error!("NEW_DOWNLOAD failed: {}", e);
                }
            });
        }

        "SAVE_BLOB" => {
            let payload = &data["payload"];
            let base64 = payload["base64"].as_str().unwrap_or("");
            let file_name = payload["fileName"].as_str().unwrap_or("download");
            let mime = payload["mime"].as_str();
            let source_url = payload["sourceUrl"]
                .as_str()
                .or_else(|| payload["pageUrl"].as_str())
                .unwrap_or("blob:browser");

            match download::save_blob_download(&state.app, base64, file_name, mime, source_url)
                .await
            {
                Ok(id) => log::info!("SAVE_BLOB completed: {}", id),
                Err(e) => {
                    let _ = tx.send(
                        serde_json::json!({
                            "type": "DOWNLOAD_ERROR",
                            "downloadId": null,
                            "error": e,
                        })
                        .to_string(),
                    );
                }
            }
        }

        "PAUSE_DOWNLOAD" => {
            if let Some(id) = data["downloadId"].as_str() {
                let _ = download::pause_download_job(&state.app, id).await;
            }
        }

        "RESUME_DOWNLOAD" => {
            if let Some(id) = data["downloadId"].as_str() {
                let app = state.app.clone();
                let id = id.to_string();
                tokio::spawn(async move {
                    if let Err(e) = download::resume_download_job(app, &id).await {
                        log::error!("RESUME_DOWNLOAD failed: {}", e);
                    }
                });
            }
        }

        "CANCEL_DOWNLOAD" | "REMOVE_DOWNLOAD" => {
            if let Some(id) = data["downloadId"].as_str() {
                let _ = download::cancel_download_job(&state.app, id).await;
            }
        }

        "GET_SETTINGS" => {
            let config = Config::from_env();
            let _ = tx.send(
                serde_json::json!({
                    "type": "SETTINGS",
                    "settings": {
                        "maxConcurrentDownloads": config.max_concurrent_downloads,
                        "defaultThreads": config.default_threads,
                        "maxRateBytes": config.max_rate_bytes,
                        "baseDirectory": config.base_directory().to_string_lossy().to_string(),
                        "engineQuiet": config.engine_quiet,
                    }
                })
                .to_string(),
            );
        }

        _ => {
            log::debug!("Unhandled WebSocket message type: {}", msg_type);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ws_clients_add_remove() {
        let clients = WsClients::new();
        let (tx, _) = tokio::sync::mpsc::unbounded_channel::<String>();
        let id = clients.add(tx);
        assert!(clients.clients.lock().unwrap().contains_key(&id));
        clients.remove(id);
        assert!(!clients.clients.lock().unwrap().contains_key(&id));
    }

    #[test]
    fn test_broadcast_progress() {
        let clients = WsClients::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        clients.add(tx);
        clients.broadcast_progress("id-1", 500, 1000, 2_500_000, 30);
        let msg = rx.try_recv().unwrap();
        assert!(msg.contains("PROGRESS"));
        assert!(msg.contains("id-1"));
    }

    #[test]
    fn test_verify_extension_origin() {
        let mut headers = HeaderMap::new();
        headers.insert("origin", "chrome-extension://abcdefghijklmnop".parse().unwrap());
        assert!(verify_origin(&headers));
    }

    #[test]
    fn test_reject_random_origin() {
        let mut headers = HeaderMap::new();
        headers.insert("origin", "https://evil.example".parse().unwrap());
        assert!(!verify_origin(&headers));
    }
}
