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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadAddedEvent {
    pub id: String,
    pub url: String,
    pub file_name: String,
    pub save_path: String,
    pub status: String,
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
    #[serde(rename = "failedIndices")]
    pub failed_indices: Vec<i64>,
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

    pub fn get_runtime_settings(&self) -> (std::path::PathBuf, u32, u32) {
        let config = crate::config::Config::from_env();
        let mut save_dir = config.base_directory();
        let mut default_threads = config.default_threads;
        let mut max_concurrent = config.max_concurrent_downloads;

        // Extension first, then desktop — desktop Settings / folder picker wins.
        for device in ["extension", "desktop"] {
            if let Ok(Some(s)) = self.db.get_device_settings(device) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&s) {
                    let dir = json
                        .get("base_dir")
                        .or_else(|| json.get("baseDirectory"))
                        .and_then(|v| v.as_str());
                    if let Some(d) = dir.filter(|d| !d.is_empty()) {
                        save_dir = crate::config::ensure_media_download_dir(std::path::PathBuf::from(d));
                    }
                    if let Some(t) = json
                        .get("default_threads")
                        .or_else(|| json.get("defaultThreads"))
                        .and_then(|v| v.as_u64())
                    {
                        default_threads = t as u32;
                    }
                    if let Some(c) = json
                        .get("max_concurrent")
                        .or_else(|| json.get("maxConcurrentDownloads"))
                        .and_then(|v| v.as_u64())
                    {
                        max_concurrent = c as u32;
                    }
                }
            }
        }
        (save_dir, max_concurrent.max(1), default_threads.max(1))
    }

    /// Merge a settings patch into both `desktop` and `extension` device rows
    /// (keeps playlistFormats / rate / quiet keys intact) and update the scheduler cap.
    pub fn apply_settings_patch(&self, patch: &serde_json::Value) {
        for device in ["desktop", "extension"] {
            let _ = self.db.upsert_device(device);
            let mut merged = self
                .db
                .get_device_settings(device)
                .ok()
                .flatten()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}));

            if let (Some(dst), Some(src)) = (merged.as_object_mut(), patch.as_object()) {
                for (k, v) in src {
                    dst.insert(k.clone(), v.clone());
                }
            }

            // Keep snake_case + camelCase aliases in sync for folder / threads.
            if let Some(obj) = merged.as_object_mut() {
                if let Some(d) = obj
                    .get("base_dir")
                    .or_else(|| obj.get("baseDirectory"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                {
                    let safe = crate::config::ensure_media_download_dir(std::path::PathBuf::from(d));
                    let s = safe.to_string_lossy().to_string();
                    obj.insert("base_dir".into(), serde_json::json!(s));
                    obj.insert("baseDirectory".into(), serde_json::json!(s));
                }
                if let Some(t) = obj
                    .get("default_threads")
                    .or_else(|| obj.get("defaultThreads"))
                    .cloned()
                {
                    obj.insert("default_threads".into(), t.clone());
                    obj.insert("defaultThreads".into(), t);
                }
                if let Some(c) = obj
                    .get("max_concurrent")
                    .or_else(|| obj.get("maxConcurrentDownloads"))
                    .cloned()
                {
                    obj.insert("max_concurrent".into(), c.clone());
                    obj.insert("maxConcurrentDownloads".into(), c);
                }
                if let Some(r) = obj
                    .get("max_rate_bytes")
                    .or_else(|| obj.get("maxRateBytes"))
                    .cloned()
                {
                    obj.insert("max_rate_bytes".into(), r.clone());
                    obj.insert("maxRateBytes".into(), r);
                }
                if let Some(q) = obj
                    .get("engine_quiet")
                    .or_else(|| obj.get("engineQuiet"))
                    .cloned()
                {
                    obj.insert("engine_quiet".into(), q.clone());
                    obj.insert("engineQuiet".into(), q);
                }
            }

            let _ = self
                .db
                .update_device_settings(device, &merged.to_string());
        }

        let (_, max_c, _) = self.get_runtime_settings();
        self.scheduler.set_max_concurrent(max_c);
    }

    /// Full settings object for the Tauri Settings UI (merged aliases + defaults).
    pub fn get_ui_settings(&self) -> serde_json::Value {
        let config = crate::config::Config::from_env();
        let (save_dir, max_c, threads) = self.get_runtime_settings();

        let mut playlist_formats = serde_json::json!({
            "mediaType": "audio",
            "videoQuality": "720",
            "audioMissingFallback": "video",
        });
        let mut max_rate = config.max_rate_bytes;
        let mut engine_quiet = config.engine_quiet;

        for device in ["extension", "desktop"] {
            if let Ok(Some(s)) = self.db.get_device_settings(device) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&s) {
                    if let Some(pf) = json.get("playlistFormats") {
                        playlist_formats = pf.clone();
                    }
                    if let Some(r) = json
                        .get("max_rate_bytes")
                        .or_else(|| json.get("maxRateBytes"))
                        .and_then(|v| v.as_u64())
                    {
                        max_rate = r;
                    }
                    if let Some(q) = json
                        .get("engine_quiet")
                        .or_else(|| json.get("engineQuiet"))
                        .and_then(|v| v.as_bool())
                    {
                        engine_quiet = q;
                    }
                }
            }
        }

        serde_json::json!({
            "base_dir": save_dir.to_string_lossy(),
            "baseDirectory": save_dir.to_string_lossy(),
            "max_concurrent": max_c,
            "maxConcurrentDownloads": max_c,
            "default_threads": threads,
            "defaultThreads": threads,
            "max_rate_bytes": max_rate,
            "maxRateBytes": max_rate,
            "engine_quiet": engine_quiet,
            "engineQuiet": engine_quiet,
            "playlistFormats": playlist_formats,
        })
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

        let skip = self.runtime_handle.block_on(async {
            let mut progress = self.progress.lock().await;
            if let Some(entry) = progress.get_mut(id) {
                // Ignore late ticks after the job finished — they flip UI back to "loading".
                if matches!(
                    entry.status.as_str(),
                    "completed" | "failed" | "cancelled" | "error"
                ) {
                    return true;
                }
                entry.downloaded = downloaded;
                entry.total = total;
                entry.speed_bps = speed_bps;
                entry.eta_secs = eta_secs;
                entry.progress_pct = progress_pct;
                if entry.status != "paused" {
                    entry.status = "downloading".to_string();
                }
            }
            false
        });
        if skip {
            return;
        }

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
        let mut completed_bytes = (0u64, 0u64);
        {
            let mut progress = self.progress.lock().await;
            if let Some(entry) = progress.get_mut(id) {
                entry.status = status.to_string();
                entry.error = error.clone();
                if status == "completed" || status == "failed" || status == "cancelled" {
                    entry.speed_bps = 0;
                    entry.eta_secs = 0;
                }
                if status == "completed" {
                    let tot = entry.total.max(entry.downloaded);
                    if tot > 0 {
                        entry.downloaded = tot;
                        entry.total = tot;
                        entry.progress_pct = 100.0;
                        let _ = self.db.update_download_progress(
                            id,
                            tot as i64,
                            tot as i64,
                        );
                    }
                    completed_bytes = (entry.downloaded, entry.total);
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
            "completed" => self.ws_clients.broadcast_completed(
                id,
                status,
                completed_bytes.0,
                completed_bytes.1,
            ),
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

    pub fn emit_download_added(&self, id: &str, url: &str, file_name: &str, save_path: &str, status: &str) {
        if let Some(app) = self.app_handle.lock().unwrap().as_ref() {
            let event = DownloadAddedEvent {
                id: id.to_string(),
                url: url.to_string(),
                file_name: file_name.to_string(),
                save_path: save_path.to_string(),
                status: status.to_string(),
            };
            let _ = app.emit("download-added", &event);
        }
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
