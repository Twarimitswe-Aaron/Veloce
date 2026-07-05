use serde_json;
use std::process::{Command, Stdio};
use std::io::Read;
use std::time::Duration;

// MediaFormat is defined in formats.rs — use it here.
pub use crate::formats::MediaFormat;

fn ytdlp_path() -> std::path::PathBuf {
    crate::util::find_ytdlp(env!("CARGO_MANIFEST_DIR"))
}

fn ytdlp_path() -> std::path::PathBuf {
    crate::util::find_ytdlp(env!("CARGO_MANIFEST_DIR"))
}

fn youtube_extra_args(url: &str) -> Vec<&'static str> {
    let lower = url.to_lowercase();
    if lower.contains("youtube.com") || lower.contains("youtu.be") {
        vec!["--js-runtimes", "node"]
    } else {
        vec![]
    }
}

fn execute_ytdlp(args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let mut cmd = Command::new(ytdlp_path());
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn yt-dlp: {}", e))?;

    // Wait with approximate timeout
    let start = std::time::Instant::now();
    let timeout = Duration::from_secs(timeout_secs);

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                child.stdout.take().unwrap().read_to_string(&mut stdout).ok();
                let mut stderr = String::new();
                child.stderr.take().unwrap().read_to_string(&mut stderr).ok();

                if status.success() && !stdout.trim().is_empty() {
                    return Ok(stdout);
                }
                let err_msg = stderr.lines()
                    .find(|l| l.starts_with("ERROR:"))
                    .map(|l| l.trim_start_matches("ERROR: ").to_string())
                    .unwrap_or_else(|| format!("yt-dlp exited with code {}", status.code().unwrap_or(-1)));
                return Err(err_msg);
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err("yt-dlp timed out".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("yt-dlp wait failed: {}", e)),
        }
    }
}

/// List available formats for a media URL using yt-dlp -J.
pub fn list_formats(url: &str, force: bool) -> Result<Vec<MediaFormat>, String> {
    let timeout = if force { 28 } else { 18 };

    // Try with Chrome cookies first, then no cookies
    let cookie_strategies: [(&[&str], u64); 3] = [
        (&["--cookies-from-browser", "chrome"], timeout),
        (&["--cookies-from-browser", "chromium"], timeout),
        (&[], 12),
    ];

    for (cookie_args, to) in &cookie_strategies {
        let mut args = vec![
            "--no-warnings",
            "--no-progress",
            "--socket-timeout", "12",
            "--retries", "1",
            "-J",
            "--",
        ];
        args.extend(youtube_extra_args(url));
        args.extend_from_slice(cookie_args);
        args.push(url);

        match execute_ytdlp(&args, *to) {
            Ok(output) => {
                match parse_formats(&output, url) {
                    Ok(formats) if !formats.is_empty() => return Ok(formats),
                    _ => continue,
                }
            }
            Err(e) => {
                log::warn!("yt-dlp attempt failed for {}: {}", url, e);
                continue;
            }
        }
    }

    Ok(vec![])
}

/// Extract the best direct media URL using yt-dlp -f b -g.
pub fn extract_best_url(url: &str) -> Result<String, String> {
    let cookie_strategies: [&[&str]; 4] = [
        &["--cookies-from-browser", "chrome"],
        &["--cookies-from-browser", "chromium"],
        &["--cookies-from-browser", "firefox"],
        &[],
    ];

    for cookies in &cookie_strategies {
        let mut args = vec![
            "--no-warnings",
            "--no-progress",
            "--socket-timeout", "12",
            "--retries", "1",
            "-f", "b",
            "--no-playlist",
            "-g",
            "--",
        ];
        args.extend(youtube_extra_args(url));
        args.extend_from_slice(cookies);
        args.push(url);

        match execute_ytdlp(&args, 30) {
            Ok(output) => {
                let url = output.lines().next().unwrap_or("").trim().to_string();
                if !url.is_empty() && url.starts_with("http") {
                    return Ok(url);
                }
            }
            Err(_) => continue,
        }
    }

    Err("Could not extract media URL".to_string())
}

/// List playlist entries using yt-dlp --flat-playlist -J.
pub fn list_playlist_entries(url: &str) -> Result<Vec<PlaylistEntry>, String> {
    let cookie_strategies: [&[&str]; 2] = [
        &["--cookies-from-browser", "chrome"],
        &[],
    ];

    for cookies in &cookie_strategies {
        let mut args = vec![
            "--flat-playlist",
            "--no-warnings",
            "--no-progress",
            "--socket-timeout", "12",
            "--retries", "1",
            "-J",
            "--",
        ];
        args.extend_from_slice(cookies);
        args.push(url);

        match execute_ytdlp(&args, 90) {
            Ok(output) => {
                return parse_playlist(&output);
            }
            Err(_) => continue,
        }
    }

    Ok(vec![])
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlaylistEntry {
    pub url: String,
    pub title: Option<String>,
    pub index: Option<usize>,
}

fn parse_formats(output: &str, _original_url: &str) -> Result<Vec<MediaFormat>, String> {
    let info: serde_json::Value = serde_json::from_str(output)
        .map_err(|e| format!("Failed to parse yt-dlp JSON: {}", e))?;

    let title = info["title"].as_str().unwrap_or("video");
    let safe_title: String = title.chars().map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c }).collect();

    let mut formats: Vec<MediaFormat> = Vec::new();

    // Single direct URL (no formats array)
    if info["url"].is_string() && info["formats"].as_array().map_or(true, |a| a.is_empty()) {
        let ext = info["ext"].as_str().unwrap_or("mp4");
        formats.push(MediaFormat {
            id: "0".to_string(),
            label: format!("{} — {}", safe_title, ext),
            url: info["url"].as_str().unwrap().to_string(),
            ext: format!(".{}", ext.trim_start_matches('.')),
            filesize: info["filesize"].as_u64().or_else(|| info["filesize_approx"].as_u64()),
            source: None,
            kind: Some("progressive".to_string()),
        });
        return Ok(formats);
    }

    // Parse formats array
    if let Some(raw) = info["formats"].as_array() {
        for f in raw {
            if !f["url"].is_string() { continue; }
            let format_id = f["format_id"].as_str().unwrap_or("");
            if f["ext"] == "mhtml" || f["format_note"] == "storyboard" || format_id.starts_with("sb") {
                continue;
            }
            let has_video = f["vcodec"].as_str().map(|c| c != "none").unwrap_or(false);
            let has_audio = f["acodec"].as_str().map(|c| c != "none").unwrap_or(false);
            if !has_video && !has_audio { continue; }

            let resolution = f["resolution"].as_str().unwrap_or("");
            let filesize = f["filesize"].as_u64().or_else(|| f["filesize_approx"].as_u64());
            let ext = f["ext"].as_str().unwrap_or("mp4");

            let av_tag = if has_video && has_audio { "video+audio" }
                else if has_video { "video only" }
                else { "audio only" };
            let size_str = filesize.map(|s| format!(" · {}", crate::util::format_bytes(s))).unwrap_or_default();
            let label = format!("{} {}", resolution, av_tag);
            let label = format!("{} — {}{}", safe_title, label.trim(), size_str);

            let kind = if f["protocol"].as_str().map(|p| p.contains("m3u8") || p.contains("dash")).unwrap_or(false) {
                "manifest"
            } else {
                "progressive"
            };

            formats.push(MediaFormat {
                id: format_id.to_string(),
                label: label.trim().to_string(),
                url: f["url"].as_str().unwrap().to_string(),
                ext: format!(".{}", ext.trim_start_matches('.')),
                filesize,
                source: None,
                kind: Some(kind.to_string()),
            });
        }
    }

    // Sort by filesize descending
    formats.sort_by(|a, b| b.filesize.unwrap_or(0).cmp(&a.filesize.unwrap_or(0)));

    Ok(formats)
}

fn parse_playlist(output: &str) -> Result<Vec<PlaylistEntry>, String> {
    let info: serde_json::Value = serde_json::from_str(output)
        .map_err(|e| format!("Failed to parse playlist JSON: {}", e))?;

    if info["_type"] != "playlist" {
        return Err("Not a playlist".to_string());
    }

    let entries = info["entries"].as_array().ok_or("No entries in playlist")?;
    let mut out = Vec::new();

    for (i, entry) in entries.iter().enumerate() {
        let entry_url: Option<String> = entry["url"].as_str().map(|s| s.to_string())
            .or_else(|| entry["webpage_url"].as_str().map(|s| s.to_string()))
            .or_else(|| {
                entry["id"].as_str().map(|id| {
                    format!("https://www.youtube.com/watch?v={}", id)
                })
            });

        if let Some(url) = entry_url {
            if url.starts_with("http") {
                out.push(PlaylistEntry {
                    url,
                    title: entry["title"].as_str().map(|s| s.to_string()),
                    index: Some(entry["playlist_index"].as_u64().map(|i| i as usize).unwrap_or(i + 1)),
                });
            }
        }
    }

    Ok(out)
}


