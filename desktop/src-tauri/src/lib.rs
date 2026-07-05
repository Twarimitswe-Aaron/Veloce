mod config;
mod db;
mod download;
mod engine;
mod formats;
mod scheduler;
mod state;
mod util;
mod ws;
mod ytdlp;

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
    download::start_download_job(
        state.inner().clone(),
        StartDownloadRequest {
            url,
            direct_url,
            file_name,
            referer,
            device_id: "desktop".to_string(),
            download_id: None,
            save_path: None,
        },
    )
    .await
}

#[tauri::command]
async fn cancel_download(id: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    download::cancel_download_job(&state, &id).await
}

#[tauri::command]
async fn pause_download(id: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    download::pause_download_job(&state, &id).await
}

#[tauri::command]
async fn get_statuses(state: State<'_, Arc<AppState>>) -> Result<Vec<DownloadStatus>, String> {
    Ok(state.all_statuses().await)
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
    let settings = state
        .db
        .get_device_settings("desktop")
        .map_err(|e| format!("DB error: {}", e))?;
    match settings {
        Some(s) => serde_json::from_str(&s).map_err(|e| format!("Parse error: {}", e)),
        None => Ok(serde_json::json!({
            "base_dir": config::Config::from_env().base_directory().to_string_lossy().to_string(),
            "max_concurrent": 10,
            "default_threads": 8,
            "max_rate": 0,
        })),
    }
}

#[tauri::command]
async fn update_settings(settings: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state
        .db
        .update_device_settings("desktop", &settings)
        .map_err(|e| format!("DB error: {}", e))
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

    let data_dir = dirs::data_dir()
        .unwrap_or(std::path::PathBuf::from("."))
        .join("Veloce");
    std::fs::create_dir_all(&data_dir).expect("Failed to create data directory");
    let db_path = data_dir.join("veloce.db");

    let db = Database::open(&db_path).expect("Failed to open database");
    log::info!("Database opened at {:?}", db_path);

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
            get_statuses,
            get_history,
            get_settings,
            update_settings,
            get_config,
        ])
        .setup(|app| {
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                state.set_app_handle(app.handle().clone());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Error while running Veloce Desktop");
}
