pub mod config;
pub mod db;
pub mod download;
pub mod engine;
pub mod formats;
pub mod playlist;
pub mod scheduler;
pub mod state;
pub mod util;
pub mod ws;
pub mod ytdlp;

use std::sync::Arc;

use tauri::{Manager, State};

use db::Database;
use download::{StartDownloadRequest, list_formats_for_url};
use scheduler::Scheduler;
use state::{AppState, DownloadStatus};

#[tauri::command]
async fn list_formats(
    url: String,
    force: Option<bool>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<formats::MediaFormat>, String> {
    list_formats_for_url(&state, &url, force.unwrap_or(false)).await
}

#[tauri::command]
async fn start_download(
    url: String,
    direct_url: Option<String>,
    file_name: String,
    referer: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    download::enqueue_download_job(
        state.inner().clone(),
        StartDownloadRequest {
            url,
            direct_url,
            file_name,
            referer,
            device_id: "desktop".to_string(),
            download_id: None,
            save_path: None,
            base_directory: None,
            threads: None,
        },
    )
    .await
}

#[tauri::command]
async fn cancel_download(id: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    // Check playlist jobs first (backend parity).
    if playlist::is_playlist_running(&id) {
        playlist::cancel_playlist_job(&state, &id);
        return Ok(());
    }
    download::cancel_download_job(&state, &id).await
}

#[tauri::command]
async fn pause_download(id: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    // Check playlist jobs first (backend parity).
    if playlist::is_playlist_running(&id) {
        playlist::pause_playlist_job(&id);
        return Ok(());
    }
    download::pause_download_job(&state, &id).await
}

#[tauri::command]
async fn resume_download(id: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    // Check if this is a playlist job (backend parity).
    let db_row = state.db.get_playlist_job(&id).map_err(|e| format!("DB error: {}", e))?;
    if let Some(row) = db_row {
        if row.status == "paused" || row.status == "queued" {
            playlist::resume_playlist_job(state.inner().clone(), &id);
            return Ok(());
        }
    }
    // Fall through to regular download resume if not a playlist.
    download::resume_download_job(state.inner().clone(), &id).await
}

#[tauri::command]
async fn get_statuses(state: State<'_, Arc<AppState>>) -> Result<Vec<DownloadStatus>, String> {
    let mut by_id: std::collections::HashMap<String, DownloadStatus> = std::collections::HashMap::new();

    // Live in-memory jobs first.
    for s in state.all_statuses().await {
        by_id.insert(s.id.clone(), s);
    }

    // Hydrate recent DB rows (extension + desktop) so failed/completed match the popup queue.
    for device in ["extension", "desktop"] {
        if let Ok(rows) = state.db.list_recent_downloads(device, 40) {
            for r in rows {
                let downloaded = r.downloaded_bytes.unwrap_or(0) as u64;
                let total = r.total_bytes.unwrap_or(0) as u64;
                let failed = r.status == "failed" || r.status == "error";
                let status = if r.status == "error" {
                    "failed".to_string()
                } else {
                    r.status.clone()
                };
                let id = r.id.clone();
                let save_path = r.save_path.clone();
                by_id.entry(id.clone()).or_insert_with(|| DownloadStatus {
                    id: r.id,
                    url: r.url,
                    file_name: r.file_name,
                    save_path: save_path.clone(),
                    status: status.clone(),
                    downloaded,
                    total,
                    speed_bps: 0,
                    eta_secs: 0,
                    progress_pct: if total > 0 {
                        (downloaded as f64 / total as f64) * 100.0
                    } else {
                        0.0
                    },
                    error: if failed {
                        Some("Download failed — click Retry".into())
                    } else {
                        None
                    },
                    source: None,
                });
                if let Some(live) = by_id.get_mut(&id) {
                    // DB is source of truth for terminal/retryable status when not actively downloading.
                    if matches!(
                        status.as_str(),
                        "queued" | "paused" | "downloading" | "completed"
                    ) {
                        if live.status == "failed" || live.status == "error" {
                            live.status = status.clone();
                        }
                        live.error = None;
                    }
                    if live.downloaded == 0 && downloaded > 0 {
                        live.downloaded = downloaded;
                        live.total = total;
                        live.progress_pct = if total > 0 {
                            (downloaded as f64 / total as f64) * 100.0
                        } else {
                            0.0
                        };
                    }
                    if live.save_path.is_empty() && !save_path.is_empty() {
                        live.save_path = save_path;
                    }
                }
            }
        }
    }

    let mut out: Vec<_> = by_id.into_values().collect();
    out.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(out)
}

#[tauri::command]
async fn get_history(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<db::DownloadRow>, String> {
    state
        .db
        .list_recent_downloads("desktop", 50)
        .map_err(|e| format!("DB error: {}", e))
}

#[tauri::command]
async fn get_settings(state: State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    Ok(state.get_ui_settings())
}

#[tauri::command]
async fn update_settings(settings: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let patch: serde_json::Value =
        serde_json::from_str(&settings).map_err(|e| format!("Parse error: {}", e))?;
    state.apply_settings_patch(&patch);
    Ok(())
}

#[tauri::command]
async fn select_directory(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let path = util::pick_directory().ok_or_else(|| {
        "No folder selected (or install zenity/kdialog for a graphical picker)".to_string()
    })?;
    state.apply_settings_patch(&serde_json::json!({
        "base_dir": &path,
        "baseDirectory": &path,
    }));
    // Notify extension clients so popup Save-to stays in sync.
    state.ws_clients.broadcast(
        &serde_json::json!({
            "type": "DIRECTORY_SELECTED",
            "payload": { "path": &path },
        })
        .to_string(),
    );
    Ok(path)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    util::open_path(&path)
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    util::reveal_in_folder(&path)
}

#[tauri::command]
async fn queue_playlist(
    url: String,
    file_name: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, String> {
    let (_, _, threads) = state.get_runtime_settings();
    let (id, total, title, folder) = playlist::queue_playlist_download(
        &state,
        &url,
        file_name.as_deref(),
        Some(&url),
        threads,
    )
    .await?;
    playlist::schedule_playlist_job(state.inner().clone(), id.clone());
    state.emit_playlist_queued(&state::PlaylistQueuedEvent {
        playlist_id: id.clone(),
        count: total,
        total,
        folder: folder.clone(),
        title: title.clone(),
    });
    state.ws_clients.broadcast_playlist_queued(&id, total, total, &folder, &title);
    Ok(serde_json::json!({
        "playlistId": id,
        "total": total,
        "title": title,
        "folder": folder,
    }))
}

#[tauri::command]
async fn list_playlists(state: State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    let rows = state
        .db
        .list_playlist_jobs_for_ui(30)
        .map_err(|e| format!("DB error: {}", e))?;
    let list: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "playlistId": r.id,
                "fileName": format!("{} ({}/{} tracks)", r.title, r.current_index.max(r.completed_tracks), r.total_tracks),
                "status": r.status,
                "current": r.current_index,
                "total": r.total_tracks,
                "completed": r.completed_tracks,
                "failed": r.failed_tracks,
                "trackTitle": r.current_track_title,
                "saveDir": r.save_dir,
                "downloaded": r.downloaded_bytes.unwrap_or(0),
                "totalBytes": r.total_bytes.unwrap_or(0),
                "error": r.error,
            })
        })
        .collect();
    Ok(serde_json::json!(list))
}

#[tauri::command]
async fn dismiss_playlist(id: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    playlist::dismiss_playlist_job(&state, &id);
    Ok(())
}

#[tauri::command]
async fn retry_failed_playlist(
    playlist_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, String> {
    playlist::retry_failed_playlist(state.inner().clone(), &playlist_id)
        .await
        .map(|(id, count, title, folder)| {
            serde_json::json!({
                "id": id,
                "count": count,
                "title": title,
                "folder": folder,
            })
        })
}

#[tauri::command]
async fn list_playlist_files(path: String) -> Result<serde_json::Value, String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err("Directory not found".to_string());
    }

    let mut file_count: i64 = 0;
    let mut total_size: i64 = 0;

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_file() {
                    file_count += 1;
                    total_size += metadata.len() as i64;
                }
            }
        }
    }

    Ok(serde_json::json!({
        "fileCount": file_count,
        "totalSize": total_size,
    }))
}

#[tauri::command]
async fn get_config() -> Result<serde_json::Value, String> {
    let config = config::Config::from_env();
    Ok(serde_json::json!({
        "port": config.port,
        "max_concurrent_downloads": config.max_concurrent_downloads,
        "default_threads": config.default_threads,
        "engine_auto_tune": config.engine_auto_tune,
        "base_dir": config.base_directory().to_string_lossy().to_string(),
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let config = config::Config::from_env();

    let db_path = config.database_path();
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).expect("Failed to create database directory");
    }

    let db = Database::open(&db_path).expect("Failed to open database");
    log::info!("Database opened at {:?}", db_path);

    match util::ytdlp_binary() {
        Some(path) => log::info!("yt-dlp found at {:?}", path),
        None => log::warn!(
            "yt-dlp not found — YouTube/Instagram/TikTok extraction disabled. \
             Place binary at backend/bin/yt-dlp or install via package manager."
        ),
    }

    let ws_rt = tokio::runtime::Runtime::new().expect("Failed to create WS tokio runtime");
    let runtime_handle = ws_rt.handle().clone();

    let ws_clients = Arc::new(ws::WsClients::new());
    let app_state = Arc::new(AppState::new(
        db,
        Scheduler::new(config::Config::from_env()),
        ws_clients.clone(),
        runtime_handle,
    ));

    let ws_port = config.port;
    let ws_app_state = app_state.clone();
    let ws_clients_task = ws_clients.clone();

    std::thread::spawn(move || {
        ws_rt.block_on(ws::start_ws_server(ws_app_state, ws_clients_task, ws_port));
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(app_state)
        .manage(ws_clients)
        .invoke_handler(tauri::generate_handler![
            list_formats,
            start_download,
            cancel_download,
            pause_download,
            resume_download,
            dismiss_playlist,
            retry_failed_playlist,
            list_playlist_files,
            get_statuses,
            get_history,
            get_settings,
            update_settings,
            select_directory,
            open_path,
            reveal_in_folder,
            queue_playlist,
            list_playlists,
            get_config,
        ])
        .setup(|app| {
            let state = app.state::<Arc<AppState>>();
            state.set_app_handle(app.handle().clone());
            // Ensure desktop device row exists and scheduler uses saved concurrency.
            let _ = state.db.upsert_device("desktop");
            let (_, max_c, _) = state.get_runtime_settings();
            state.scheduler.set_max_concurrent(max_c);
            // Re-schedule any playlists left mid-flight after a crash/restart.
            if let Ok(active) = state.db.list_playlist_jobs_for_ui(20) {
                for job in active {
                    if matches!(job.status.as_str(), "queued" | "downloading" | "paused")
                        && !playlist::is_playlist_running(&job.id)
                    {
                        if job.status == "paused" {
                            continue; // wait for user Resume
                        }
                        let _ = state.db.update_playlist_job(
                            &job.id,
                            &serde_json::json!({"status": "queued"}),
                        );
                        playlist::schedule_playlist_job(state.inner().clone(), job.id);
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Error while running Veloce Desktop");
}
