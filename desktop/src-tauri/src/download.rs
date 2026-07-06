use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use tokio::sync::{Mutex as TokioMutex, broadcast};
use uuid::Uuid;

use crate::config::Config;
use crate::db;
use crate::engine::EngineProcess;
use crate::formats::{self, MediaFormat};
use crate::state::{AppState, DownloadStatus};
use crate::util;
use crate::ytdlp;

const FAIL_CACHE_TTL_SECS: u64 = 90;

static FORMAT_INFLIGHT: Lazy<
    TokioMutex<HashMap<String, broadcast::Sender<Result<Vec<MediaFormat>, String>>>>,
> = Lazy::new(|| TokioMutex::new(HashMap::new()));

static FORMAT_FAIL_CACHE: Lazy<TokioMutex<HashMap<String, (String, u64)>>> =
    Lazy::new(|| TokioMutex::new(HashMap::new()));

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

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
                if !formats.is_empty() {
                    return Ok(formats);
                }
            }
        }
        if let Some((reason, ts)) = FORMAT_FAIL_CACHE.lock().await.get(&normalized).cloned() {
            if now_secs().saturating_sub(ts) < FAIL_CACHE_TTL_SECS {
                return Err(reason);
            }
        }
    }

    // Deduplicate concurrent LIST_FORMATS for the same URL (backend `inflight` map).
    let waiter = {
        let mut map = FORMAT_INFLIGHT.lock().await;
        if let Some(tx) = map.get(&normalized) {
            Some(tx.subscribe())
        } else {
            let (tx, _) = broadcast::channel(1);
            map.insert(normalized.clone(), tx);
            None
        }
    };

    if let Some(mut rx) = waiter {
        return rx
            .recv()
            .await
            .unwrap_or_else(|_| Err("Format list request was cancelled".to_string()));
    }

    let result = list_formats_uncached(state, url, &normalized, source, force).await;

    if let Some(tx) = FORMAT_INFLIGHT.lock().await.remove(&normalized) {
        let _ = tx.send(result.clone());
    }

    result
}

async fn list_formats_uncached(
    state: &AppState,
    url: &str,
    normalized: &str,
    source: formats::MediaSource,
    force: bool,
) -> Result<Vec<MediaFormat>, String> {
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
        formats::MediaSource::Instagram => {
            // Instagram: try URL variants (/p/ & /reel/) with Chrome/Chromium — backend parity.
            let variants = formats::instagram_url_variants(url);
            let browsers: &[&str] = if force {
                &["chrome", "chromium", "brave", "firefox"]
            } else {
                &["chrome", "chromium"]
            };
            let timeout_secs = if force { 24 } else { 14 };

            let mut last_err = String::new();
            let mut result: Vec<MediaFormat> = vec![];

            for variant in &variants {
                for browser in browsers {
                    let v = variant.clone();
                    let b = browser.to_string();
                    match tokio::task::spawn_blocking(move || {
                        // Build specific instagram attempt with single browser
                        let attempts = vec![ytdlp::YtAttempt {
                            cookie_args: vec!["--cookies-from-browser".into(), b],
                            extra_args: vec![],
                            timeout_secs,
                            label: format!("instagram/{browser}"),
                        }];
                        ytdlp::run_attempts(&v, &attempts, false)
                    }).await {
                        Ok(Ok(formats)) if !formats.is_empty() => {
                            result = formats;
                            break;
                        }
                        Ok(Ok(_)) => {} // empty formats, continue
                        Ok(Err(e)) => last_err = e,
                        Err(e) => last_err = format!("Task failed: {e}"),
                    }
                }
                if !result.is_empty() {
                    break;
                }
            }

            if result.is_empty() {
                FORMAT_FAIL_CACHE
                    .lock()
                    .await
                    .insert(normalized.to_string(), (last_err.clone(), now_secs()));
                return Err(if last_err.is_empty() {
                    "Instagram returned no formats. Log in to Instagram in Chrome, reload the page, and retry.".to_string()
                } else {
                    last_err
                });
            }
            result
        }
        _ => {
            let normalized = normalized.to_string();
            tokio::task::spawn_blocking(move || ytdlp::list_formats(&normalized, force))
                .await
                .map_err(|e| format!("yt-dlp task failed: {e}"))??
        }
    };

    if formats.is_empty() {
        let reason = "No downloadable formats found for this link".to_string();
        FORMAT_FAIL_CACHE
            .lock()
            .await
            .insert(normalized.to_string(), (reason.clone(), now_secs()));
        return Err(reason);
    }

    if let Ok(json) = serde_json::to_string(&formats) {
        state.format_cache.set(normalized, &json);
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

    let extracted = ytdlp::extract_best_url(&normalized)?;
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

    let min_free_bytes = config.min_free_disk_mb * 1024 * 1024;
    if let Some(free) = util::free_space(&save_dir) {
        if free < min_free_bytes {
            return Err(format!(
                "Insufficient disk space: {} free, need at least {} MB reserved",
                util::format_bytes(free),
                config.min_free_disk_mb,
            ));
        }
    }

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
    state
        .ws_clients
        .broadcast_ack(&download_id, &safe_name, "downloading");

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
        config.engine_read_buffer_bytes,
        config.engine_auto_tune,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db::Database;
    use crate::scheduler::Scheduler;
    use crate::ws::WsClients;

    fn test_state() -> Arc<AppState> {
        let db = Database::open_in_memory().expect("db");
        let ws = Arc::new(WsClients::new());
        let handle = tokio::runtime::Handle::current();
        Arc::new(AppState::new(
            db,
            Scheduler::new(Config::from_env()),
            ws,
            handle,
        ))
    }

    #[tokio::test]
    async fn rejects_empty_url() {
        let state = test_state();
        let err = list_formats_for_url(&state, "", false).await.unwrap_err();
        assert!(err.contains("No URL"));
    }

    #[tokio::test]
    async fn rejects_blob_urls() {
        let state = test_state();
        let err = list_formats_for_url(&state, "blob:https://x", false)
            .await
            .unwrap_err();
        assert!(err.contains("Browser-only blob URL"));
    }

    #[tokio::test]
    async fn rejects_private_hosts_when_blocked() {
        let state = test_state();
        let err = list_formats_for_url(&state, "http://127.0.0.1/secret.mp4", false)
            .await
            .unwrap_err();
        assert!(err.contains("Blocked"));
    }

    #[tokio::test]
    async fn direct_file_url_returns_single_format_without_ytdlp() {
        let state = test_state();
        let formats = list_formats_for_url(
            &state,
            "https://cdn.example.com/video.mp4",
            false,
        )
        .await
        .expect("direct formats");
        assert_eq!(formats.len(), 1);
        assert_eq!(formats[0].id, "0");
        assert!(formats[0].label.contains("Direct"));
        assert_eq!(formats[0].url, "https://cdn.example.com/video.mp4");
        assert_eq!(formats[0].source.as_deref(), Some("direct"));
    }

    #[tokio::test]
    async fn github_blob_url_resolves_to_raw() {
        let state = test_state();
        let formats = list_formats_for_url(
            &state,
            "https://github.com/o/r/blob/main/readme.md",
            false,
        )
        .await
        .expect("github formats");
        assert_eq!(
            formats[0].url,
            "https://raw.githubusercontent.com/o/r/main/readme.md"
        );
        assert_eq!(formats[0].source.as_deref(), Some("github"));
    }

    #[tokio::test]
    async fn format_cache_hit_skips_second_lookup() {
        let state = test_state();
        let url = "https://cdn.example.com/cached-file.zip";
        let first = list_formats_for_url(&state, url, false)
            .await
            .expect("first");
        let second = list_formats_for_url(&state, url, false)
            .await
            .expect("cached");
        assert_eq!(first[0].url, second[0].url);
    }

    #[tokio::test]
    async fn force_still_validates_url() {
        let state = test_state();
        let err = list_formats_for_url(&state, "", true).await.unwrap_err();
        assert!(err.contains("No URL"));
    }

    #[tokio::test]
    async fn resolve_download_url_uses_direct_when_provided() {
        let state = test_state();
        let url = resolve_download_url(
            &state,
            "https://www.youtube.com/watch?v=x",
            Some("https://cdn.example.com/direct.mp4"),
        )
        .expect("direct");
        assert_eq!(url, "https://cdn.example.com/direct.mp4");
    }

    #[tokio::test]
    async fn resolve_download_url_uses_page_for_direct_file() {
        let state = test_state();
        let url = resolve_download_url(
            &state,
            "https://cdn.example.com/file.mp4",
            None,
        )
        .expect("page direct");
        assert_eq!(url, "https://cdn.example.com/file.mp4");
    }

    #[tokio::test]
    async fn resolve_download_url_blocks_unsafe_direct() {
        let state = test_state();
        let err = resolve_download_url(
            &state,
            "https://example.com/x",
            Some("http://127.0.0.1/internal"),
        )
        .unwrap_err();
        assert!(err.contains("Blocked"));
    }
}
