use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as TokioMutex;
use tauri::{AppHandle, Emitter};
use serde::{Serialize, Deserialize};

use crate::db::Database;
use crate::scheduler::Scheduler;
use crate::formats::FormatCache;
use crate::engine::EngineProcess;
use crate::ws::WsClients;

/// Status of a single download job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadStatus {
    pub id: String,
    pub url: String,
    pub file_name: String,
    pub save_path: String,
    pub status: String, // queued, downloading, completed, failed, paused
    pub downloaded: u64,
    pub total: u64,
    pub speed_bps: u64,
    pub eta_secs: u64,
    pub progress_pct: f64,
    pub error: Option<String>,
    pub source: Option<String>,
}

/// Progress update payload emitted via Tauri events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressEvent {
    pub id: String,
    pub downloaded: u64,
    pub total: u64,
    pub speed_bps: u64,
    pub eta_secs: u64,
    pub progress_pct: f64,
}

/// Status update payload emitted when a download transitions state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusEvent {
    pub id: String,
    pub status: String,
    pub error: Option<String>,
}

/// Playlist progress update payload emitted via Tauri events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistProgressEvent {
    #[serde(rename = "playlistId")]
    pub playlist_id: String,
    #[serde(rename = "fileName")]
    pub file_name: String,
    pub status: String,
    pub current: i64,
    pub total: i64,
    pub completed: i64,
    pub failed: i64,
    #[serde(rename = "trackTitle")]
    pub track_title: Option<String>,
    #[serde(rename = "saveDir")]
    pub save_dir: String,
    pub downloaded: i64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: i64,
    pub error: Option<String>,
}

/// Playlist queued event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistQueuedEvent {
    #[serde(rename = "playlistId")]
    pub playlist_id: String,
    pub count: i64,
    pub total: i64,
    pub folder: String,
    pub title: String,
}

/// Playlist finished event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistFinishedEvent {
    #[serde(rename = "playlistId")]
    pub playlist_id: String,
    pub title: String,
    #[serde(rename = "saveDir")]
    pub save_dir: String,
    pub completed: i64,
    pub failed: i64,
    pub total: i64,
}

/// Playlist removed event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistRemovedEvent {
    #[serde(rename = "playlistId")]
    pub playlist_id: String,
}

/// Shared application state.
pub struct AppState {
    pub db: Database,
    pub scheduler: Scheduler,
    pub format_cache: FormatCache,
    pub best_url_cache: FormatCache,
    pub active_engines: Mutex<HashMap<String, EngineProcess>>,
    pub cancellation_flags: Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    pub progress: TokioMutex<HashMap<String, DownloadStatus>>,
    pub ws_clients: Arc<WsClients>,
    app_handle: Mutex<Option<AppHandle>>,
    pub runtime_handle: tokio::runtime::Handle,
}

impl AppState {
    pub fn new(
        db: Database,
        scheduler: Scheduler,
        ws_clients: Arc<WsClients>,
        runtime_handle: tokio::runtime::Handle,
    ) -> Self {
        Self {
            db,
            scheduler,
            format_cache: FormatCache::new(600),
            best_url_cache: FormatCache::new(600),
            active_engines: Mutex::new(HashMap::new()),
            cancellation_flags: Mutex::new(HashMap::new()),
            progress: TokioMutex::new(HashMap::new()),
            ws_clients,
            app_handle: Mutex::new(None),
            runtime_handle,
        }
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.lock().unwrap() = Some(handle);
    }

    pub async fn track_download(&self, status: DownloadStatus) {
        let mut progress = self.progress.lock().await;
        progress.insert(status.id.clone(), status);
    }

    /// Update progress — Tauri UI + extension WebSocket clients.
    pub fn emit_progress(
        &self,
        id: &str,
        downloaded: u64,
        total: u64,
        speed_bps: u64,
        eta_secs: u64,
        progress_pct: f64,
    ) {
        let event = ProgressEvent {
            id: id.to_string(),
            downloaded,
            total,
            speed_bps,
            eta_secs,
            progress_pct,
        };

        let _ = self.runtime_handle.block_on(async {
            let mut progress = self.progress.lock().await;
            if let Some(entry) = progress.get_mut(id) {
                entry.downloaded = downloaded;
                entry.total = total;
                entry.speed_bps = speed_bps;
                entry.eta_secs = eta_secs;
                entry.progress_pct = progress_pct;
                entry.status = "downloading".to_string();
            }
        });

        let _ = self.db.update_download_progress(
            id,
            downloaded as i64,
            total as i64,
        );

        if let Some(app) = self.app_handle.lock().unwrap().as_ref() {
            let _ = app.emit("download-progress", &event);
        }
        self.ws_clients.broadcast_progress(id, downloaded, total, speed_bps, eta_secs);
    }

    pub async fn emit_status(&self, id: &str, status: &str, error: Option<String>) {
        {
            let mut progress = self.progress.lock().await;
            if let Some(entry) = progress.get_mut(id) {
                entry.status = status.to_string();
                entry.error = error.clone();
                if status == "completed" || status == "failed" || status == "cancelled" {
                    entry.speed_bps = 0;
                    entry.eta_secs = 0;
                }
            }
        }

        let event = StatusEvent {
            id: id.to_string(),
            status: status.to_string(),
            error: error.clone(),
        };
        if let Some(app) = self.app_handle.lock().unwrap().as_ref() {
            let _ = app.emit("download-status", &event);
        }

        match status {
            "completed" => self.ws_clients.broadcast_completed(id, status),
            "failed" => {
                self.ws_clients.broadcast_error(
                    id,
                    error.as_deref().unwrap_or("Download failed"),
                );
            }
            "cancelled" => self.ws_clients.broadcast_removed(id),
            "paused" => self.ws_clients.broadcast_paused(id),
            _ => {}
        }
    }

    pub async fn remove_active(&self, id: &str) {
        let mut progress = self.progress.lock().await;
        progress.remove(id);
        {
            let mut engines = self.active_engines.lock().unwrap();
            engines.remove(id);
        }
        {
            let mut flags = self.cancellation_flags.lock().unwrap();
            flags.remove(id);
        }
        self.scheduler.finish(id);
    }

    pub fn emit_playlist_update(&self, event: &PlaylistProgressEvent) {
        if let Some(app) = self.app_handle.lock().unwrap().as_ref() {
            let _ = app.emit("playlist-update", event);
        }
    }

    pub fn emit_playlist_queued(&self, event: &PlaylistQueuedEvent) {
        if let Some(app) = self.app_handle.lock().unwrap().as_ref() {
            let _ = app.emit("playlist-queued", event);
        }
    }

    pub fn emit_playlist_finished(&self, event: &PlaylistFinishedEvent) {
        if let Some(app) = self.app_handle.lock().unwrap().as_ref() {
            let _ = app.emit("playlist-finished", event);
        }
    }

    pub fn emit_playlist_removed(&self, event: &PlaylistRemovedEvent) {
        if let Some(app) = self.app_handle.lock().unwrap().as_ref() {
            let _ = app.emit("playlist-removed", event);
        }
    }

    pub async fn all_statuses(&self) -> Vec<DownloadStatus> {
        let progress = self.progress.lock().await;
        progress.values().cloned().collect()
    }
}
