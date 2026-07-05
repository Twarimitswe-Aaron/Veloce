use std::sync::Arc;
use std::sync::atomic::Ordering;

use uuid::Uuid;

use crate::config::Config;
use crate::db;
use crate::engine::EngineProcess;
use crate::formats::{self, MediaFormat};
use crate::state::{AppState, DownloadStatus};
use crate::util;
use crate::ytdlp;

/// List formats with the same routing as the Tauri command (MediaFire, direct, GitHub, yt-dlp).
pub async fn list_formats_for_url(
    state: &AppState,
    url: &str,
    force: bool,
) -> Result<Vec<MediaFormat>, String> {
    if url.is_empty() {
        return Err("No URL provided".to_string());
    }
    if url.starts_with("blob:") || url.starts_with("data:") || url.starts_with("mediastream:") {
        return Err(
            "Browser-only blob URL — refresh the page and use the Veloce badge on the post link."
                .to_string(),
        );
    }
    if !util::is_safe_download_url(url) {
        return Err("Blocked: URL points to a private or local network address".to_string());
    }

    let source = formats::detect_source(url);
    let normalized = formats::normalize_url(url);

    if !force {
        if let Some(cached) = state.format_cache.get(&normalized) {
            if let Ok(formats) = serde_json::from_str::<Vec<MediaFormat>>(&cached) {
                return Ok(formats);
            }
        }
    }

    let formats = match source {
        formats::MediaSource::MediaFire => {
            let info = formats::resolve_mediafire(url).await?;
            vec![formats::MediaFormat {
                id: "0".to_string(),
                label: format!(
                    "{} — {}",
                    info.file_name,
                    formats::format_bytes(info.size_bytes.unwrap_or(0))
                ),
                url: info.direct_url,
                ext: std::path::Path::new(&info.file_name)
                    .extension()
                    .map(|e| format!(".{}", e.to_string_lossy()))
                    .unwrap_or_else(|| ".mp4".to_string()),
                filesize: info.size_bytes,
                source: Some("mediafire".to_string()),
                kind: Some("direct".to_string()),
            }]
        }
        formats::MediaSource::Direct | formats::MediaSource::GitHub => {
            let list_url = formats::resolve_list_url(url);
            let ext = std::path::Path::new(&list_url)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_else(|| ".mp4".to_string());
            vec![formats::MediaFormat {
                id: "0".to_string(),
                label: format!("Direct — {}", ext),
                url: list_url,
                ext,
                filesize: None,
                source: Some(if source == formats::MediaSource::GitHub {
                    "github".to_string()
                } else {
                    "direct".to_string()
                }),
                kind: Some("direct".to_string()),
            }]
        }
        _ => ytdlp::list_formats(url, force)?,
    };

    if let Ok(json) = serde_json::to_string(&formats) {
        state.format_cache.set(&normalized, &json);
    }

    Ok(formats)
}

pub struct StartDownloadRequest {
    pub url: String,
    pub direct_url: Option<String>,
    pub file_name: String,
    pub referer: Option<String>,
    pub device_id: String,
    pub download_id: Option<String>,
    pub save_path: Option<String>,
}

/// Resolve the HTTP URL the engine should fetch.
pub fn resolve_download_url(
    state: &AppState,
    page_url: &str,
    direct_url: Option<&str>,
) -> Result<String, String> {
    if let Some(direct) = direct_url.filter(|u| !u.is_empty()) {
        if !util::is_safe_download_url(direct) {
            return Err("Blocked: direct URL points to a private or local network address".to_string());
        }
        return Ok(direct.to_string());
    }

    if formats::is_direct_file_url(page_url) || formats::is_github_raw_url(page_url) {
        let resolved = formats::resolve_list_url(page_url);
        if !util::is_safe_download_url(&resolved) {
            return Err("Blocked: URL points to a private or local network address".to_string());
        }
        return Ok(resolved);
    }

    let normalized = formats::normalize_url(page_url);
    if let Some(cached) = state.best_url_cache.get(&normalized) {
        return Ok(cached);
    }

    let extracted = ytdlp::extract_best_url(page_url)?;
    state.best_url_cache.set(&normalized, &extracted);
    Ok(extracted)
}

/// Start a download job (shared by Tauri IPC and WebSocket).
pub async fn start_download_job(
    state: Arc<AppState>,
    req: StartDownloadRequest,
) -> Result<String, String> {
    let config = Config::from_env();
    let download_id = req.download_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let save_dir = config.base_directory();

    std::fs::create_dir_all(&save_dir)
        .map_err(|e| format!("Failed to create save directory: {}", e))?;

    let safe_name = util::sanitize_filename(&req.file_name);
    let save_path = if let Some(path) = req.save_path.as_ref() {
        std::path::PathBuf::from(path)
    } else {
        util::unique_save_path(&save_dir.join(&safe_name))
    };
    let save_path_str = save_path.to_string_lossy().to_string();

    let download_url = resolve_download_url(&state, &req.url, req.direct_url.as_deref())?;

    if state.db.get_download(&download_id).ok().flatten().is_some() {
        let _ = state.db.update_download_status(&download_id, "downloading");
    } else {
        let row = db::DownloadRow {
            id: download_id.clone(),
            device_id: req.device_id.clone(),
            url: req.url.clone(),
            direct_url: Some(download_url.clone()),
            referer: req.referer.clone(),
            file_name: safe_name.clone(),
            save_path: save_path_str.clone(),
            status: "downloading".to_string(),
            total_bytes: None,
            downloaded_bytes: Some(0),
        };
        state
            .db
            .insert_download(&row)
            .map_err(|e| format!("DB error: {}", e))?;
    }

    let source = formats::detect_source(&req.url);
    let status = DownloadStatus {
        id: download_id.clone(),
        url: req.url.clone(),
        file_name: safe_name.clone(),
        save_path: save_path_str.clone(),
        status: "downloading".to_string(),
        downloaded: 0,
        total: 0,
        speed_bps: 0,
        eta_secs: 0,
        progress_pct: 0.0,
        error: None,
        source: Some(format!("{:?}", source).to_lowercase()),
    };
    state.track_download(status).await;

    let cancel_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut flags = state.cancellation_flags.lock().unwrap();
        flags.insert(download_id.clone(), cancel_flag.clone());
    }

    let state_spawn = state.clone();
    let id_spawn = download_id.clone();
    let referer = req.referer.clone();

    let on_progress = {
        let state_prog = state.clone();
        let id_prog = download_id.clone();
        move |prog: crate::engine::EngineProgress| {
            let pct = match (prog.downloaded, prog.total) {
                (Some(d), Some(t)) if t > 0 => (d as f64 / t as f64) * 100.0,
                _ => 0.0,
            };
            state_prog.emit_progress(&id_prog, prog.downloaded.unwrap_or(0), prog.total.unwrap_or(0), prog.speed_bps.unwrap_or(0), prog.eta_secs.unwrap_or(0), pct);
        }
    };

    match EngineProcess::spawn(
        download_id.clone(),
        &download_url,
        &save_path_str,
        config.default_threads,
        config.max_rate_bytes,
        config.engine_quiet,
        referer.as_deref(),
        on_progress,
    ) {
        Ok((engine, _reader)) => {
            {
                let mut engines = state.active_engines.lock().unwrap();
                engines.insert(download_id.clone(), engine);
            }

            let state_mon = state_spawn.clone();
            let id_mon = id_spawn.clone();
            let cancel_mon = cancel_flag.clone();
            let runtime_handle = state_spawn.runtime_handle.clone();

            std::thread::spawn(move || {
                let engine = {
                    let mut engines = state_mon.active_engines.lock().unwrap();
                    engines.remove(&id_mon)
                };

                let (exit_status, error) = match engine {
                    Some(mut eng) => {
                        let code = eng.wait();
                        if cancel_mon.load(Ordering::SeqCst) {
                            ("cancelled".to_string(), None)
                        } else if code == Some(0) {
                            ("completed".to_string(), None)
                        } else {
                            (
                                "failed".to_string(),
                                Some(format!(
                                    "Engine exited with code {}",
                                    code.unwrap_or(-1)
                                )),
                            )
                        }
                    }
                    None => {
                        if cancel_mon.load(Ordering::SeqCst) {
                            ("cancelled".to_string(), None)
                        } else {
                            ("failed".to_string(), Some("Engine process lost".to_string()))
                        }
                    }
                };

                let _ = state_mon.db.update_download_status(&id_mon, &exit_status);

                runtime_handle.block_on(async {
                    state_mon.emit_status(&id_mon, &exit_status, error.clone()).await;
                    state_mon.remove_active(&id_mon).await;
                });
            });

            Ok(download_id)
        }
        Err(e) => {
            {
                let mut flags = state.cancellation_flags.lock().unwrap();
                flags.remove(&download_id);
            }
            let _ = state.db.update_download_status(&download_id, "failed");
            state.emit_status(&download_id, "failed", Some(e.clone())).await;
            Err(format!("Failed to start engine: {}", e))
        }
    }
}

/// Save base64 blob bytes from the extension (blob:/data: intercept).
pub async fn save_blob_download(
    state: &AppState,
    base64_data: &str,
    file_name: &str,
    _mime: Option<&str>,
    source_url: &str,
) -> Result<String, String> {
    const MAX_BLOB_BYTES: usize = 80 * 1024 * 1024;
    use base64::Engine as _;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.trim())
        .map_err(|e| format!("Invalid base64: {}", e))?;
    if bytes.is_empty() {
        return Err("Empty blob".to_string());
    }
    if bytes.len() > MAX_BLOB_BYTES {
        return Err(format!("Blob too large (max {} MB)", MAX_BLOB_BYTES / 1024 / 1024));
    }

    let config = Config::from_env();
    let save_dir = config.base_directory();
    std::fs::create_dir_all(&save_dir)
        .map_err(|e| format!("Failed to create save directory: {}", e))?;

    let download_id = Uuid::new_v4().to_string();
    let safe_name = util::sanitize_filename(file_name);
    let save_path = util::unique_save_path(&save_dir.join(&safe_name));
    std::fs::write(&save_path, &bytes).map_err(|e| format!("Failed to write file: {}", e))?;

    let save_path_str = save_path.to_string_lossy().to_string();
    let row = db::DownloadRow {
        id: download_id.clone(),
        device_id: "extension".to_string(),
        url: source_url.to_string(),
        direct_url: None,
        referer: None,
        file_name: safe_name.clone(),
        save_path: save_path_str.clone(),
        status: "completed".to_string(),
        total_bytes: Some(bytes.len() as i64),
        downloaded_bytes: Some(bytes.len() as i64),
    };
    state
        .db
        .insert_download(&row)
        .map_err(|e| format!("DB error: {}", e))?;

    state
        .ws_clients
        .broadcast_ack(&download_id, &safe_name, "completed");
    state
        .ws_clients
        .broadcast_completed(&download_id, "completed");

    Ok(download_id)
}

pub async fn cancel_download_job(state: &AppState, id: &str) -> Result<(), String> {
    {
        let flags = state.cancellation_flags.lock().unwrap();
        if let Some(flag) = flags.get(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
    {
        let mut engines = state.active_engines.lock().unwrap();
        if let Some(engine) = engines.get_mut(id) {
            engine.cancel();
        }
    }
    let _ = state.db.update_download_status(id, "cancelled");
    state.scheduler.finish(id);
    state.emit_status(id, "cancelled", None).await;
    state.ws_clients.broadcast_removed(id);
    Ok(())
}

pub async fn pause_download_job(state: &AppState, id: &str) -> Result<(), String> {
    {
        let mut engines = state.active_engines.lock().unwrap();
        if let Some(engine) = engines.get_mut(id) {
            engine.pause();
        }
    }
    let _ = state.db.update_download_status(id, "paused");
    state.emit_status(id, "paused", None).await;
    Ok(())
}

pub async fn resume_download_job(state: Arc<AppState>, id: &str) -> Result<(), String> {
    let row = state
        .db
        .get_download(id)
        .map_err(|e| format!("DB error: {}", e))?
        .ok_or_else(|| "Download not found".to_string())?;

    if !["paused", "error", "queued"].contains(&row.status.as_str()) {
        return Err(format!("Cannot resume download in status {}", row.status));
    }

    {
        let engines = state.active_engines.lock().unwrap();
        if engines.contains_key(id) {
            return Err("Download already running".to_string());
        }
    }

    state.ws_clients.broadcast_ack(id, &row.file_name, "queued");

    start_download_job(
        state,
        StartDownloadRequest {
            url: row.url.clone(),
            direct_url: None,
            file_name: row.file_name.clone(),
            referer: row.referer.clone(),
            device_id: row.device_id.clone(),
            download_id: Some(id.to_string()),
            save_path: Some(row.save_path.clone()),
        },
    )
    .await?;

    Ok(())
}
