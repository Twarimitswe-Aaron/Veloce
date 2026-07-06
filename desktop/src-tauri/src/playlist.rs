use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use uuid::Uuid;

use crate::config::Config;
use crate::db;
use crate::engine::EngineProcess;
use crate::state::{AppState, PlaylistProgressEvent, PlaylistQueuedEvent, PlaylistFinishedEvent, PlaylistRemovedEvent};
use crate::util;
use crate::ytdlp;

/// User-configurable playlist format settings (mirrors backend PlaylistFormatSettings).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlaylistFormatSettings {
    pub media_type: String, // "audio" or "video"
    pub video_quality: String, // "1080", "720", "480", "360", "best"
    pub audio_missing_fallback: String, // "video" or "skip"
}

impl Default for PlaylistFormatSettings {
    fn default() -> Self {
        Self {
            media_type: "audio".to_string(),
            video_quality: "720".to_string(),
            audio_missing_fallback: "video".to_string(),
        }
    }
}

/// Runtime settings for a running playlist job.
#[derive(Debug, Clone)]
pub struct PlaylistRuntime {
    pub base_directory: String,
    pub default_threads: u32,
    pub max_rate_bytes: u64,
    pub engine_quiet: bool,
}

/// Maximum number of retry passes for failed playlist tracks.
const MAX_RETRIES: u32 = 3;

/// Running playlist state (not serialized — in-memory only).
struct RunningPlaylist {
    intent: String, // "normal", "paused", "cancelled"
    cancel_flag: Arc<AtomicBool>,
}

/// In-memory registry of running playlist jobs.
static RUNNING_PLAYLISTS: Lazy<Mutex<HashMap<String, RunningPlaylist>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs() as i64
}

/// Queue a playlist download from a URL.
pub async fn queue_playlist_download(
    app: &AppState,
    playlist_url: &str,
    file_name: Option<&str>,
    referer: Option<&str>,
    threads: u32,
) -> Result<(String, i64, String, String), String> {
    let config = Config::from_env();

    // Check for existing active playlist with same URL.
    if let Some(existing_id) = app
        .db
        .has_active_playlist_for_url("extension", playlist_url)
        .map_err(|e| format!("DB error: {}", e))?
    {
        let row = app
            .db
            .get_playlist_job(&existing_id)
            .map_err(|e| format!("DB error: {}", e))?
            .ok_or("Playlist job not found")?;
        return Ok((existing_id, row.total_tracks, row.title, row.save_dir));
    }

    // Resolve playlist entries via yt-dlp.
    let entries = ytdlp::list_playlist_entries(playlist_url)
        .map_err(|e| format!("Failed to resolve playlist: {}", e))?;

    if entries.is_empty() {
        return Err("No playlist entries found (or not a playlist).".to_string());
    }

    if entries.len() > 100 {
        log::warn!("Large playlist ({} tracks) — sequential download may take a while.", entries.len());
    }

    // Determine playlist title.
    let title = file_name
        .and_then(|n| if n.is_empty() { None } else { Some(n) })
        .unwrap_or("Playlist")
        .to_string();

    // Create save directory: base/playlists/<title>/
    let playlist_dir_name = util::sanitize_filename(&title);
    let save_dir = config.base_directory().join("playlists").join(&playlist_dir_name);
    std::fs::create_dir_all(&save_dir)
        .map_err(|e| format!("Failed to create playlist directory: {}", e))?;

    let id = Uuid::new_v4().to_string();
    let entries_json = serde_json::to_string(&entries).unwrap_or_default();

    let row = db::PlaylistJobRow {
        id: id.clone(),
        device_id: "extension".to_string(),
        playlist_url: playlist_url.to_string(),
        title: title.clone(),
        save_dir: save_dir.to_string_lossy().to_string(),
        status: "queued".to_string(),
        current_index: 0,
        total_tracks: entries.len() as i64,
        completed_tracks: 0,
        failed_tracks: 0,
        entries: entries_json,
        settings: Some(serde_json::to_string(&PlaylistFormatSettings::default()).unwrap_or_default()),
        referer: referer.map(|s| s.to_string()),
        threads: threads as i64,
        current_track_title: None,
        error: None,
        failed_indices: None,
        downloaded_bytes: Some(0),
        total_bytes: Some(0),
        created_at: now_secs(),
    };

    app.db
        .insert_playlist_job(&row)
        .map_err(|e| format!("DB error: {}", e))?;

    Ok((id, entries.len() as i64, title, save_dir.to_string_lossy().to_string()))
}

/// Schedule a queued playlist job to run.
pub fn schedule_playlist_job(state: Arc<AppState>, playlist_id: String) {
    let mut running = RUNNING_PLAYLISTS.lock().unwrap();
    if running.contains_key(&playlist_id) {
        return;
    }
    running.insert(
        playlist_id.clone(),
        RunningPlaylist {
            intent: "normal".to_string(),
            cancel_flag: Arc::new(AtomicBool::new(false)),
        },
    );
    drop(running);

    std::thread::spawn(move || {
        let rt = tokio::runtime::Handle::current();
        rt.block_on(async move {
            run_playlist_job(state, &playlist_id).await;
        });
    });
}

/// Execute a playlist job — process tracks sequentially, with retry logic for failures.
async fn run_playlist_job(state: Arc<AppState>, playlist_id: &str) {
    let row = match state.db.get_playlist_job(playlist_id).ok().flatten() {
        Some(r) => r,
        None => {
            RUNNING_PLAYLISTS.lock().unwrap().remove(playlist_id);
            return;
        }
    };

    let entries: Vec<ytdlp::PlaylistEntry> =
        serde_json::from_str(&row.entries).unwrap_or_default();
    if entries.is_empty() {
        let _ = state.db.delete_playlist_job(playlist_id);
        RUNNING_PLAYLISTS.lock().unwrap().remove(playlist_id);
        return;
    }

    // Mark as downloading.
    let _ = state.db.update_playlist_job(
        playlist_id,
        &serde_json::json!({"status": "downloading"}),
    );
    broadcast_playlist_update(state.as_ref(), playlist_id, "downloading", 0, 0, "", "");

    let config = Config::from_env();
    let save_dir = row.save_dir.clone();
    let referer = row.referer.clone();

    let mut index = row.current_index;
    let mut completed = row.completed_tracks;
    let mut failed = row.failed_tracks;
    let mut failed_indices: Vec<i64> = row
        .failed_indices
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    // ── Phase 1: Initial pass over all entries ──────────────────────────
    while index < entries.len() as i64 {
        if check_pause_cancel(&state, playlist_id, index, completed, failed, entries.len() as i64).await {
            return;
        }

        // Skip already-failed indices (from a resumed partial run).
        if failed_indices.contains(&index) {
            index += 1;
            let _ = state.db.update_playlist_job(
                playlist_id,
                &serde_json::json!({"current_index": index}),
            );
            continue;
        }

        let (ok, new_index, new_completed, new_failed) = process_single_track(
            &state, playlist_id, index, &entries, &save_dir, &referer, &config,
            completed, failed,
        )
        .await;

        if check_pause_cancel(&state, playlist_id, index, completed, failed, entries.len() as i64).await {
            return;
        }

        if ok {
            completed = new_completed;
        } else {
            failed_indices.push(index);
            failed = new_failed;
        }
        index = new_index;

        let _ = state.db.update_playlist_job(
            playlist_id,
            &serde_json::json!({
                "current_index": index,
                "completed_tracks": completed,
                "failed_tracks": failed,
                "failed_indices": serde_json::to_string(&failed_indices).unwrap_or_default(),
            }),
        );
    }

    // ── Phase 2: Retry failed tracks ───────────────────────────────────
    let mut retry_pass = 0u32;
    while !failed_indices.is_empty() && retry_pass < MAX_RETRIES {
        retry_pass += 1;
        log::info!(
            "Playlist {} retry pass {}/{} for {} failed tracks",
            playlist_id, retry_pass, MAX_RETRIES, failed_indices.len()
        );

        // Take a snapshot of indices to retry this pass.
        let to_retry: Vec<i64> = failed_indices.clone();
        let mut still_failed: Vec<i64> = Vec::new();

        for &idx in &to_retry {
            if check_pause_cancel(&state, playlist_id, idx, completed, failed, entries.len() as i64).await {
                return;
            }

            let (ok, new_index, new_completed, new_failed) = process_single_track(
                &state, playlist_id, idx, &entries, &save_dir, &referer, &config,
                completed, failed,
            )
            .await;

            if check_pause_cancel(&state, playlist_id, idx, completed, failed, entries.len() as i64).await {
                return;
            }

            if ok {
                completed = new_completed;
                log::info!("Retry succeeded for track index {} (pass {})", idx, retry_pass);
            } else {
                still_failed.push(idx);
                failed = new_failed;
                log::warn!(
                    "Retry {}/{} failed for track index {}",
                    retry_pass, MAX_RETRIES, idx
                );
            }
        }

        failed_indices = still_failed;

        let _ = state.db.update_playlist_job(
            playlist_id,
            &serde_json::json!({
                "completed_tracks": completed,
                "failed_tracks": failed,
                "failed_indices": serde_json::to_string(&failed_indices).unwrap_or_default(),
            }),
        );
    }

    if !failed_indices.is_empty() {
        log::warn!(
            "Playlist {} completed with {} permanently failed tracks after {} retries",
            playlist_id, failed_indices.len(), MAX_RETRIES
        );
    }

    // ── Finalize ────────────────────────────────────────────────────────
    playlist_finalize(
        &state, playlist_id, entries.len() as i64,
        completed, failed, &row.title, &row.save_dir,
    ).await;
}

/// Check pause/cancel and return true if the job should stop.
async fn check_pause_cancel(
    state: &Arc<AppState>,
    playlist_id: &str,
    current_index: i64,
    completed: i64,
    failed: i64,
    total: i64,
) -> bool {
    let running = RUNNING_PLAYLISTS.lock().unwrap();
    if let Some(rp) = running.get(playlist_id) {
        if rp.intent == "cancelled" {
            drop(running);
            let _ = state.db.delete_playlist_job(playlist_id);
            state.ws_clients.broadcast_removed(playlist_id);
            RUNNING_PLAYLISTS.lock().unwrap().remove(playlist_id);
            return true;
        }
        if rp.intent == "paused" {
            drop(running);
            let _ = state.db.update_playlist_job(
                playlist_id,
                &serde_json::json!({
                    "status": "paused",
                    "current_index": current_index,
                    "completed_tracks": completed,
                    "failed_tracks": failed,
                }),
            );
            broadcast_playlist_update(
                state.as_ref(), playlist_id, "paused", current_index, total, "", "",
            );
            RUNNING_PLAYLISTS.lock().unwrap().remove(playlist_id);
            return true;
        }
    } else {
        return true;
    }
    false
}

/// Process a single track: extract media URL, download, return result.
async fn process_single_track(
    state: &Arc<AppState>,
    playlist_id: &str,
    index: i64,
    entries: &[ytdlp::PlaylistEntry],
    save_dir: &str,
    referer: &Option<String>,
    config: &Config,
    completed: i64,
    failed: i64,
) -> (bool, i64, i64, i64) {
    let entry_idx = index as usize;
    if entry_idx >= entries.len() {
        return (false, index + 1, completed, failed);
    }
    let entry = &entries[entry_idx];
    let track_title = entry
        .title
        .clone()
        .unwrap_or_else(|| format!("Track {}", index + 1));
    let num = format!("{:02}", entry.index.unwrap_or(entry_idx + 1));
    let stem = util::sanitize_filename(&format!("{} - {}", num, track_title));

    let _ = state.db.update_playlist_job(
        playlist_id,
        &serde_json::json!({
            "current_index": index,
            "current_track_title": track_title,
        }),
    );
    broadcast_playlist_update(
        state.as_ref(), playlist_id, "downloading", index, entries.len() as i64,
        &stem, &track_title,
    );

    // Extract media URL.
    let entry_url = if entry.url.starts_with("http") {
        entry.url.clone()
    } else {
        format!("https://www.youtube.com/watch?v={}", entry.url)
    };

    let media_url = match ytdlp::extract_best_url(&entry_url) {
        Ok(url) => url,
        Err(e) => {
            log::error!("Failed to extract URL for track {}: {}", track_title, e);
            return (false, index + 1, completed, failed + 1);
        }
    };

    let ext = std::path::Path::new(&media_url)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .filter(|e| e.len() <= 5)
        .unwrap_or_else(|| ".mp4".to_string());

    let file_name = format!("{}{}", stem, ext);
    let save_path = std::path::Path::new(save_dir).join(&file_name);

    // Check if already completed on disk.
    if save_path.exists() && save_path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return (true, index + 1, completed + 1, failed);
    }

    // Reset cancel flag.
    {
        let running = RUNNING_PLAYLISTS.lock().unwrap();
        if let Some(rp) = running.get(playlist_id) {
            rp.cancel_flag.store(false, Ordering::SeqCst);
        }
    }

    let save_path_str = save_path.to_string_lossy().to_string();

    let (track_completed, track_error) = download_track(
        state,
        &format!("{}-t{}", playlist_id, index),
        &media_url,
        &save_path_str,
        config.default_threads,
        config.max_rate_bytes,
        config.engine_quiet,
        config.engine_read_buffer_bytes,
        config.engine_auto_tune,
        referer.as_deref(),
    )
    .await;

    if track_completed {
        (true, index + 1, completed + 1, failed)
    } else {
        if let Some(err) = track_error {
            log::error!("Track {} failed: {}", track_title, err);
        }
        (false, index + 1, completed, failed + 1)
    }
}

/// Finalize a playlist job — update status, emit events, keep DB row for retry.
async fn playlist_finalize(
    state: &Arc<AppState>,
    playlist_id: &str,
    total_tracks: i64,
    completed: i64,
    failed: i64,
    title: &str,
    save_dir: &str,
) {
    // Grab the final failed_indices from the DB before we lose them.
    let failed_indices: Vec<i64> = state
        .db
        .get_playlist_job(playlist_id)
        .ok()
        .flatten()
        .and_then(|r| {
            r.failed_indices
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
        })
        .unwrap_or_default();

    let _ = state.db.update_playlist_job(
        playlist_id,
        &serde_json::json!({
            "status": "completed",
            "completed_tracks": completed,
            "failed_tracks": failed,
        }),
    );

    state.emit_playlist_finished(&PlaylistFinishedEvent {
        playlist_id: playlist_id.to_string(),
        title: title.to_string(),
        save_dir: save_dir.to_string(),
        completed,
        failed,
        total: total_tracks,
        failed_indices: failed_indices.clone(),
    });

    state.ws_clients.broadcast(
        &serde_json::json!({
            "type": "PLAYLIST_FINISHED",
            "playlistId": playlist_id,
            "title": title,
            "saveDir": save_dir,
            "completed": completed,
            "failed": failed,
            "total": total_tracks,
        })
        .to_string(),
    );

    RUNNING_PLAYLISTS.lock().unwrap().remove(playlist_id);
    // Keep the DB row so the user can retry failed tracks.
}

/// Retry failed tracks from a completed playlist — creates a new playlist job.
pub async fn retry_failed_playlist(
    state: Arc<AppState>,
    playlist_id: &str,
) -> Result<(String, i64, String, String), String> {
    let row = state
        .db
        .get_playlist_job(playlist_id)
        .map_err(|e| format!("DB error: {}", e))?
        .ok_or_else(|| "Playlist job not found".to_string())?;

    if row.failed_tracks == 0 {
        return Err("No failed tracks to retry".to_string());
    }

    let failed_indices: Vec<i64> = row
        .failed_indices
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    if failed_indices.is_empty() {
        return Err("No failed track indices found".to_string());
    }

    let all_entries: Vec<ytdlp::PlaylistEntry> =
        serde_json::from_str(&row.entries).unwrap_or_default();

    // Filter to only the failed entries, clearing indices for sequential numbering.
    let retry_entries: Vec<ytdlp::PlaylistEntry> = failed_indices
        .iter()
        .filter_map(|&idx| {
            let i = idx as usize;
            if i < all_entries.len() {
                let mut entry = all_entries[i].clone();
                entry.index = None; // Sequential from 1 in the retry
                Some(entry)
            } else {
                None
            }
        })
        .collect();

    if retry_entries.is_empty() {
        return Err("Failed to resolve entries for retry".to_string());
    }

    let config = Config::from_env();
    let retry_title = format!("{} - Retry", row.title);
    let playlist_dir_name = util::sanitize_filename(&retry_title);
    let save_dir = config.base_directory().join("playlists").join(&playlist_dir_name);
    std::fs::create_dir_all(&save_dir)
        .map_err(|e| format!("Failed to create retry directory: {}", e))?;

    let id = Uuid::new_v4().to_string();
    let entries_json = serde_json::to_string(&retry_entries).unwrap_or_default();

    let new_row = db::PlaylistJobRow {
        id: id.clone(),
        device_id: "desktop".to_string(),
        playlist_url: row.playlist_url.clone(),
        title: retry_title.clone(),
        save_dir: save_dir.to_string_lossy().to_string(),
        status: "queued".to_string(),
        current_index: 0,
        total_tracks: retry_entries.len() as i64,
        completed_tracks: 0,
        failed_tracks: 0,
        entries: entries_json,
        settings: row.settings.clone(),
        referer: row.referer.clone(),
        threads: row.threads,
        current_track_title: None,
        error: None,
        failed_indices: None,
        downloaded_bytes: Some(0),
        total_bytes: Some(0),
        created_at: now_secs(),
    };

    state.db.insert_playlist_job(&new_row).map_err(|e| format!("DB error: {}", e))?;

    // Emit playlist-queued Tauri event so the frontend shows the retry immediately.
    state.emit_playlist_queued(&PlaylistQueuedEvent {
        playlist_id: id.clone(),
        count: 0,
        total: retry_entries.len() as i64,
        folder: save_dir.to_string_lossy().to_string(),
        title: retry_title.clone(),
    });

    schedule_playlist_job(state, id.clone());

    Ok((id, retry_entries.len() as i64, retry_title, save_dir.to_string_lossy().to_string()))
}

/// Download a single track by spawning the engine process.
async fn download_track(
    state: &Arc<AppState>,
    track_key: &str,
    url: &str,
    save_path: &str,
    threads: u32,
    max_rate: u64,
    quiet: bool,
    read_buffer: u32,
    auto_tune: bool,
    referer: Option<&str>,
) -> (bool, Option<String>) {
    let on_progress = {
        let state = state.clone();
        let key = track_key.to_string();
        move |prog: crate::engine::EngineProgress| {
            let pct = match (prog.downloaded, prog.total) {
                (Some(d), Some(t)) if t > 0 => (d as f64 / t as f64) * 100.0,
                _ => 0.0,
            };
            state.emit_progress(
                &key,
                prog.downloaded.unwrap_or(0),
                prog.total.unwrap_or(0),
                prog.speed_bps.unwrap_or(0),
                prog.eta_secs.unwrap_or(0),
                pct,
            );
        }
    };

    match EngineProcess::spawn(
        track_key.to_string(),
        url,
        save_path,
        threads,
        max_rate,
        quiet,
        read_buffer,
        auto_tune,
        referer,
        on_progress,
    ) {
        Ok((mut engine, _reader)) => {
            let code = engine.wait();
            if code == Some(0) {
                (true, None)
            } else {
                (false, Some(format!("Engine exited with code {}", code.unwrap_or(-1))))
            }
        }
        Err(e) => (false, Some(e)),
    }
}

/// Pause a running playlist job.
pub fn pause_playlist_job(playlist_id: &str) {
    let mut running = RUNNING_PLAYLISTS.lock().unwrap();
    if let Some(rp) = running.get_mut(playlist_id) {
        rp.intent = "paused".to_string();
    }
}

/// Cancel a running playlist job.
pub fn cancel_playlist_job(app: &AppState, playlist_id: &str) {
    {
        let mut running = RUNNING_PLAYLISTS.lock().unwrap();
        if let Some(rp) = running.get_mut(playlist_id) {
            rp.intent = "cancelled".to_string();
            rp.cancel_flag.store(true, Ordering::SeqCst);
        }
    }
    // Tauri event.
    app.emit_playlist_removed(&PlaylistRemovedEvent {
        playlist_id: playlist_id.to_string(),
    });
    // WebSocket broadcast.
    app.ws_clients.broadcast_playlist_removed(playlist_id);
    let _ = app.db.delete_playlist_job(playlist_id);
    RUNNING_PLAYLISTS.lock().unwrap().remove(playlist_id);
}

/// Resume a paused playlist job.
pub fn resume_playlist_job(state: Arc<AppState>, playlist_id: &str) {
    let row = match state.db.get_playlist_job(playlist_id).ok().flatten() {
        Some(r) => r,
        None => return,
    };
    if row.status != "paused" && row.status != "queued" {
        return;
    }
    let _ = state
        .db
        .update_playlist_job(playlist_id, &serde_json::json!({"status": "queued"}));
    schedule_playlist_job(state, playlist_id.to_string());
}

/// Check if a playlist job is currently running.
pub fn is_playlist_running(playlist_id: &str) -> bool {
    RUNNING_PLAYLISTS.lock().unwrap().contains_key(playlist_id)
}

/// Broadcast a playlist update event (WebSocket + Tauri event).
fn broadcast_playlist_update(
    state: &AppState,
    playlist_id: &str,
    status: &str,
    current: i64,
    total: i64,
    stem: &str,
    track_title: &str,
) {
    let row = match state.db.get_playlist_job(playlist_id).ok().flatten() {
        Some(r) => r,
        None => return,
    };

    let file_name = format!("{} ({}/{})", row.title, current + 1, total);
    let tauri_event = PlaylistProgressEvent {
        playlist_id: playlist_id.to_string(),
        file_name: file_name.clone(),
        status: status.to_string(),
        current: current + 1,
        total,
        completed: row.completed_tracks,
        failed: row.failed_tracks,
        track_title: if stem.is_empty() {
            row.current_track_title.clone()
        } else {
            Some(track_title.to_string())
        },
        save_dir: row.save_dir.clone(),
        downloaded: row.downloaded_bytes.unwrap_or(0),
        total_bytes: row.total_bytes.unwrap_or(0),
        error: row.error.clone(),
    };

    // Emit Tauri event for the desktop frontend.
    state.emit_playlist_update(&tauri_event);

    // Broadcast via WebSocket for the extension.
    state.ws_clients.broadcast(
        &serde_json::json!({
            "type": "PLAYLIST_UPDATE",
            "playlistId": playlist_id,
            "fileName": file_name,
            "status": status,
            "current": current + 1,
            "total": total,
            "completed": row.completed_tracks,
            "failed": row.failed_tracks,
            "trackTitle": tauri_event.track_title,
            "saveDir": row.save_dir,
            "downloaded": row.downloaded_bytes.unwrap_or(0),
            "totalBytes": row.total_bytes.unwrap_or(0),
            "error": row.error,
            "isPlaylist": true,
        })
        .to_string(),
    );
}
