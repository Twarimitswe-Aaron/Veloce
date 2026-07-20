use once_cell::sync::Lazy;
use serde_json;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub use crate::formats::MediaFormat;

/// Match extension prefetch limit — avoids Chrome cookie DB lock contention.
static YTDLP_SLOTS: Lazy<Mutex<usize>> = Lazy::new(|| Mutex::new(0));
const YTDLP_MAX_CONCURRENT: usize = 2;

#[derive(Clone)]
pub struct YtAttempt {
    pub cookie_args: Vec<String>,
    pub extra_args: Vec<String>,
    pub timeout_secs: u64,
    pub label: String,
    /// Instagram carousels need playlist expansion; YouTube listings stay single-video.
    pub allow_playlist: bool,
}

fn ytdlp_missing_err() -> String {
    static WARNED: std::sync::Once = std::sync::Once::new();
    let path = crate::util::find_ytdlp(env!("CARGO_MANIFEST_DIR"));
    WARNED.call_once(|| {
        log::error!(
            "yt-dlp not found (looked for {:?}). Install yt-dlp or place it at backend/bin/yt-dlp",
            path
        );
    });
    format!(
        "yt-dlp not found — install it or copy to backend/bin/yt-dlp (expected {:?})",
        path
    )
}

fn ensure_ytdlp() -> Result<PathBuf, String> {
    crate::util::ytdlp_binary().ok_or_else(ytdlp_missing_err)
}

fn with_ytdlp_slot<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    loop {
        {
            let mut slots = YTDLP_SLOTS.lock().unwrap();
            if *slots < YTDLP_MAX_CONCURRENT {
                *slots += 1;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(80));
    }
    let result = f();
    *YTDLP_SLOTS.lock().unwrap() -= 1;
    result
}

/// Shared yt-dlp args applied for all invocations — mirrors backend `ytdlpSharedArgs()`.
fn ytdlp_shared_args() -> Vec<&'static str> {
    vec!["--js-runtimes", "node"]
}

fn cookie_db_exists(browser: &str) -> bool {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return browser == "firefox",
    };
    let path = match browser {
        "chrome" => home.join(".config/google-chrome/Default/Cookies"),
        "chromium" => home.join(".config/chromium/Default/Cookies"),
        "brave" => home.join(".config/BraveSoftware/Brave-Browser/Default/Cookies"),
        "firefox" => return true,
        _ => return false,
    };
    path.is_file()
}

fn available_cookie_browsers() -> Vec<&'static str> {
    let mut out = Vec::new();
    for browser in ["chrome", "chromium", "firefox", "brave"] {
        if cookie_db_exists(browser) {
            out.push(browser);
        }
    }
    if out.is_empty() {
        out.push("chrome");
    }
    out
}

fn build_args(url: &str, attempt: &YtAttempt) -> Vec<String> {
    let mut args = vec![
        "--no-warnings".into(),
        "--no-progress".into(),
    ];
    // Instagram carousels arrive as yt-dlp playlists — omit --no-playlist so entries expand.
    if !attempt.allow_playlist {
        args.push("--no-playlist".into());
    }
    args.extend([
        "--socket-timeout".into(),
        "15".into(),
        "--retries".into(),
        "1".into(),
        "-J".into(),
    ]);
    args.extend(
        ytdlp_shared_args()
            .into_iter()
            .map(String::from),
    );
    args.extend(attempt.cookie_args.clone());
    args.extend(attempt.extra_args.clone());
    args.push("--".into());
    args.push(url.to_string());
    args
}

fn parse_stderr_error(stderr: &str, code: i32) -> String {
    let mut last = String::new();
    for line in stderr.lines() {
        let t = line.trim();
        if t.starts_with("ERROR:") {
            last = t.trim_start_matches("ERROR:").trim().to_string();
        } else if t.contains("Requested format is not available")
            || t.contains("Sign in to confirm")
            || t.contains("Video unavailable")
        {
            last = t.to_string();
        }
    }
    if last.is_empty() {
        format!("yt-dlp exited with code {code}")
    } else {
        last
    }
}

fn execute_ytdlp(
    args: &[String],
    timeout_secs: u64,
    cancel: Option<&AtomicBool>,
) -> Result<String, String> {
    with_ytdlp_slot(|| {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err("yt-dlp cancelled".to_string());
        }

        let bin = ensure_ytdlp()?;
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut cmd = Command::new(&bin);
        cmd.args(&arg_refs)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn yt-dlp: {}", e))?;

        let start = Instant::now();
        let timeout = Duration::from_secs(timeout_secs);

        loop {
            if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                let _ = child.kill();
                return Err("yt-dlp cancelled".to_string());
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut stdout = String::new();
                    child.stdout.take().unwrap().read_to_string(&mut stdout).ok();
                    let mut stderr = String::new();
                    child.stderr.take().unwrap().read_to_string(&mut stderr).ok();

                    if status.success() && !stdout.trim().is_empty() {
                        return Ok(stdout);
                    }
                    return Err(parse_stderr_error(
                        &stderr,
                        status.code().unwrap_or(-1),
                    ));
                }
                Ok(None) => {
                    if start.elapsed() > timeout {
                        let _ = child.kill();
                        return Err("yt-dlp timed out".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => return Err(format!("yt-dlp wait failed: {e}")),
            }
        }
    })
}

fn try_attempt(url: &str, attempt: &YtAttempt, cancel: Option<&AtomicBool>) -> Result<Vec<MediaFormat>, String> {
    if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
        return Err("yt-dlp cancelled".to_string());
    }
    let args = build_args(url, attempt);
    let output = execute_ytdlp(&args, attempt.timeout_secs, cancel)?;
    parse_formats(&output, url)
}

fn youtube_attempts(force: bool) -> Vec<YtAttempt> {
    let timeout = if force { 28 } else { 18 };
    let mut out = Vec::new();

    for browser in available_cookie_browsers() {
        out.push(YtAttempt {
            cookie_args: vec![
                "--cookies-from-browser".into(),
                browser.to_string(),
            ],
            extra_args: vec![],
            timeout_secs: timeout,
            label: format!("youtube/{browser}"),
            allow_playlist: false,
        });
    }

    for client in ["android", "web", "ios"] {
        out.push(YtAttempt {
            cookie_args: vec!["--cookies-from-browser".into(), "chrome".into()],
            extra_args: vec![
                "--extractor-args".into(),
                format!("youtube:player_client={client}"),
            ],
            timeout_secs: if force { 24 } else { 14 },
            label: format!("youtube/chrome/{client}"),
            allow_playlist: false,
        });
    }

    out.push(YtAttempt {
        cookie_args: vec![],
        extra_args: vec![],
        timeout_secs: 10,
        label: "youtube/no-cookies".into(),
        allow_playlist: false,
    });

    out
}

fn generic_attempts(force: bool) -> Vec<YtAttempt> {
    let timeout = if force { 24 } else { 20 };
    vec![
        YtAttempt {
            cookie_args: vec!["--cookies-from-browser".into(), "chrome".into()],
            extra_args: vec![],
            timeout_secs: timeout,
            label: "generic/chrome".into(),
            allow_playlist: false,
        },
        YtAttempt {
            cookie_args: vec!["--cookies-from-browser".into(), "chromium".into()],
            extra_args: vec![],
            timeout_secs: timeout,
            label: "generic/chromium".into(),
            allow_playlist: false,
        },
        YtAttempt {
            cookie_args: vec![],
            extra_args: vec![],
            timeout_secs: 12,
            label: "generic/no-cookies".into(),
            allow_playlist: false,
        },
    ]
}

/// Run specific attempts against a URL and return the first successful result.
/// Used by download.rs for Instagram URL variants (backend parity).
pub fn run_attempts(url: &str, attempts: &[YtAttempt], force: bool) -> Result<Vec<MediaFormat>, String> {
    if attempts.is_empty() {
        return Err("No yt-dlp attempts configured".to_string());
    }
    for attempt in attempts {
        match try_attempt(url, attempt, None) {
            Ok(formats) if !formats.is_empty() => return Ok(formats),
            Ok(_) => {}
            Err(_) => {
                if force {
                    // In force mode, continue to next attempt
                    continue;
                }
                // In non-force mode, return first non-empty result
            }
        }
    }
    // All attempts exhausted
    Err("No formats found".to_string())
}

/// Race yt-dlp attempts: try the primary once, then race up to 4 fallbacks in parallel.
///
/// `force` used to walk attempts **sequentially** (worst case ~28s × N). That made badge
/// clicks slower than background prefetch. Now force only affects attempt lists/timeouts
/// (via `youtube_attempts` / `generic_attempts`); the race strategy is always parallel.
fn race_formats(url: &str, attempts: Vec<YtAttempt>, _force: bool) -> (Vec<MediaFormat>, String) {
    let jobs: Vec<(String, YtAttempt)> = attempts
        .into_iter()
        .map(|a| (url.to_string(), a))
        .collect();
    race_url_attempts(jobs)
}

/// Primary attempt, then parallel fallbacks (each job may use a different page URL —
/// used by Instagram /p/ vs /reel/ variants).
fn race_url_attempts(jobs: Vec<(String, YtAttempt)>) -> (Vec<MediaFormat>, String) {
    if jobs.is_empty() {
        return (vec![], String::new());
    }

    let mut last_err = String::new();
    let (primary_url, primary) = &jobs[0];

    match try_attempt(primary_url, primary, None) {
        Ok(formats) if !formats.is_empty() => return (formats, String::new()),
        Ok(_) => {}
        Err(e) => last_err = e,
    }

    let fallbacks: Vec<(String, YtAttempt)> = jobs.into_iter().skip(1).take(4).collect();
    if fallbacks.is_empty() {
        return (vec![], last_err);
    }

    let resolved = Arc::new(AtomicBool::new(false));
    let result: Arc<Mutex<Option<Vec<MediaFormat>>>> = Arc::new(Mutex::new(None));
    let err_out: Arc<Mutex<String>> = Arc::new(Mutex::new(last_err));

    std::thread::scope(|scope| {
        for (url, attempt) in fallbacks {
            let resolved = Arc::clone(&resolved);
            let result = Arc::clone(&result);
            let err_out = Arc::clone(&err_out);
            scope.spawn(move || {
                if resolved.load(Ordering::Relaxed) {
                    return;
                }
                match try_attempt(&url, &attempt, Some(&resolved)) {
                    Ok(formats) if !formats.is_empty() => {
                        *result.lock().unwrap() = Some(formats);
                        resolved.store(true, Ordering::Relaxed);
                    }
                    Ok(_) => {}
                    Err(e) => {
                        if e != "yt-dlp cancelled" {
                            log::debug!("yt-dlp {} failed: {}", attempt.label, e);
                            let mut err = err_out.lock().unwrap();
                            if err.is_empty() {
                                *err = e;
                            }
                        }
                    }
                }
            });
        }
    });

    let formats = result.lock().unwrap().clone().unwrap_or_default();
    let err = err_out.lock().unwrap().clone();
    (formats, err)
}

/// Instagram: try /p/ + /reel/ variants across cookie browsers with a parallel race
/// (same strategy as YouTube). `allow_playlist` expands carousel entries.
pub fn list_instagram_formats(url: &str, force: bool) -> Result<Vec<MediaFormat>, String> {
    let variants = crate::formats::instagram_url_variants(url);
    let browsers: &[&str] = if force {
        &["chrome", "chromium", "brave", "firefox"]
    } else {
        &["chrome", "chromium"]
    };
    let timeout_secs = if force { 24 } else { 14 };

    let mut jobs: Vec<(String, YtAttempt)> = Vec::new();
    for variant in &variants {
        for browser in browsers {
            jobs.push((
                variant.clone(),
                YtAttempt {
                    cookie_args: vec!["--cookies-from-browser".into(), (*browser).into()],
                    extra_args: vec![],
                    timeout_secs,
                    label: format!("instagram/{browser}"),
                    allow_playlist: true,
                },
            ));
        }
    }

    let (formats, err) = race_url_attempts(jobs);
    if formats.is_empty() {
        return Err(if err.is_empty() {
            "Instagram returned no formats. Log in to Instagram in Chrome, reload the page, and retry."
                .to_string()
        } else {
            err
        });
    }
    // Prefer progressive video+audio — Instagram DASH video-only rows are silent.
    Ok(finalize_combined_av_picker(formats, "instagram"))
}

/// Hide silent video-only DASH; add merged "Best" row (YouTube + Instagram parity).
///
/// Best used to ship with an empty `url`, which forced a second yt-dlp (`-f b -g`)
/// on download. We seed Best with the top progressive video+audio URL from the same
/// `-J` pass so the extension can pass `directUrl` and skip that second extract.
pub fn finalize_combined_av_picker(formats: Vec<MediaFormat>, source: &str) -> Vec<MediaFormat> {
    let mut combined: Vec<MediaFormat> = formats
        .iter()
        .filter(|f| is_combined_av_label(&f.label) && !is_instagram_silent_dash_url(&f.url))
        .cloned()
        .collect();

    if combined.is_empty() {
        combined = formats
            .into_iter()
            .filter(|f| !f.label.to_lowercase().contains("audio only"))
            .collect();
    }

    combined.sort_by(|a, b| {
        let hb = parse_height(&b.label);
        let ha = parse_height(&a.label);
        hb.cmp(&ha).then(b.filesize.unwrap_or(0).cmp(&a.filesize.unwrap_or(0)))
    });

    let title_stem = combined
        .first()
        .map(|f| f.label.split(" — ").next().unwrap_or("video").to_string())
        .unwrap_or_else(|| "video".to_string());

    let best_url = combined
        .first()
        .map(|f| f.url.clone())
        .unwrap_or_default();
    let best_ext = combined
        .first()
        .map(|f| f.ext.clone())
        .unwrap_or_else(|| ".mp4".to_string());
    let best_size = combined.first().and_then(|f| f.filesize);

    let best = MediaFormat {
        id: "best".to_string(),
        label: format!("{title_stem} — Best (video + audio)"),
        url: best_url,
        ext: best_ext,
        filesize: best_size,
        source: Some(source.to_string()),
        kind: Some("progressive".to_string()),
    };

    let mut out = vec![best];
    out.extend(combined.into_iter().take(23));
    out
}

fn is_combined_av_label(label: &str) -> bool {
    let l = label.to_lowercase();
    if l.contains("video only") || l.contains("audio only") {
        return false;
    }
    // Explicit muxed rows, or unlabeled progressive (Instagram single-URL / top-level url).
    true
}

/// YouTube picker wrapper — same combined A/V logic as Instagram.
pub fn finalize_youtube_picker(formats: Vec<MediaFormat>) -> Vec<MediaFormat> {
    finalize_combined_av_picker(formats, "youtube")
}

fn parse_height(label: &str) -> u32 {
    if let Some(cap) = regex::Regex::new(r"(\d{3,4})x(\d{3,4})")
        .ok()
        .and_then(|re| re.captures(label))
    {
        return cap.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
    }
    if let Some(cap) = regex::Regex::new(r"(\d{3,4})p")
        .ok()
        .and_then(|re| re.captures(label))
    {
        return cap.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
    }
    0
}

/// List available formats for a media URL using yt-dlp -J.
pub fn list_formats(url: &str, force: bool) -> Result<Vec<MediaFormat>, String> {
    let is_youtube = url.contains("youtube.com") || url.contains("youtu.be");
    let attempts = if is_youtube {
        youtube_attempts(force)
    } else {
        generic_attempts(force)
    };

    let (formats, err) = race_formats(url, attempts, force);

    if formats.is_empty() && !err.is_empty() {
        log::warn!("yt-dlp all attempts failed for {}: {}", url, err);
    }

    Ok(if is_youtube && !formats.is_empty() {
        finalize_youtube_picker(formats)
    } else {
        formats
    })
}

/// Extract the best direct media URL using yt-dlp -f b -g.
pub fn extract_best_url(url: &str) -> Result<String, String> {
    extract_url_with_format(url, "b")
}

/// Extract a direct media URL with an explicit yt-dlp `-f` selector (playlist format ladder).
pub fn extract_url_with_format(url: &str, format: &str) -> Result<String, String> {
    let cookie_strategies: [&[&str]; 4] = [
        &["--cookies-from-browser", "chrome"],
        &["--cookies-from-browser", "chromium"],
        &["--cookies-from-browser", "firefox"],
        &[],
    ];

    let format = if format.trim().is_empty() { "b" } else { format };

    for cookies in &cookie_strategies {
        let mut args: Vec<String> = vec![
            "--no-warnings".into(),
            "--no-progress".into(),
            "--no-playlist".into(),
            "--socket-timeout".into(),
            "15".into(),
            "--retries".into(),
            "1".into(),
            "-f".into(),
            format.to_string(),
            "-g".into(),
        ];
        args.extend(
            ytdlp_shared_args()
                .into_iter()
                .map(String::from),
        );
        for c in *cookies {
            args.push((*c).into());
        }
        args.push("--".into());
        args.push(url.to_string());

        match execute_ytdlp(&args, 30, None) {
            Ok(output) => {
                let url = output.lines().next().unwrap_or("").trim().to_string();
                if !url.is_empty() && url.starts_with("http") {
                    return Ok(url);
                }
            }
            Err(e) => {
                log::debug!("yt-dlp extract_url_with_format({format}) failed: {}", e);
            }
        }
    }

    Err("Could not extract media URL".to_string())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[allow(dead_code)]
pub struct PlaylistEntry {
    pub url: String,
    pub title: Option<String>,
    pub index: Option<usize>,
}

#[allow(dead_code)]
pub fn list_playlist_entries(url: &str) -> Result<Vec<PlaylistEntry>, String> {
    let cookie_strategies: [&[&str]; 2] = [
        &["--cookies-from-browser", "chrome"],
        &[],
    ];

    for cookies in &cookie_strategies {
        let mut args: Vec<String> = vec![
            "--flat-playlist".into(),
            "--no-warnings".into(),
            "--no-progress".into(),
            "--socket-timeout".into(),
            "12".into(),
            "--retries".into(),
            "1".into(),
            "-J".into(),
        ];
        for c in *cookies {
            args.push((*c).into());
        }
        args.push("--".into());
        args.push(url.to_string());

        if let Ok(output) = execute_ytdlp(&args, 90, None) {
            return parse_playlist(&output);
        }
    }

    Ok(vec![])
}

fn parse_formats(output: &str, _original_url: &str) -> Result<Vec<MediaFormat>, String> {
    let info: serde_json::Value = serde_json::from_str(output)
        .map_err(|e| format!("Failed to parse yt-dlp JSON: {e}"))?;

    // Instagram carousels (and similar) arrive as playlists — expand each entry
    // into labeled format rows so the menu can offer every slide.
    if info["_type"] == "playlist" {
        if let Some(entries) = info["entries"].as_array() {
            let base_title = get_smart_title(&info);
            let total = entries.len();
            let mut merged = Vec::new();
            for (i, entry) in entries.iter().enumerate() {
                let suffix = if total > 1 {
                    format!(" [{}/{}]", i + 1, total)
                } else {
                    String::new()
                };
                let mut slide = entry.clone();
                let slide_title = get_smart_title(&slide);
                let titled = if slide_title != "video" && slide_title != "post" {
                    format!("{slide_title}{suffix}")
                } else {
                    format!("{base_title}{suffix}")
                };
                slide["title"] = serde_json::Value::String(titled);
                if let Ok(part) = parse_formats_single(&slide) {
                    merged.extend(part);
                }
            }
            if !merged.is_empty() {
                merged.truncate(40);
                return Ok(merged);
            }
        }
    }

    parse_formats_single(&info)
}

/// Prefer caption / uploader over Instagram's generic "Video by …" / "Reel" titles.
fn get_smart_title(info: &serde_json::Value) -> String {
    let uploader = info["uploader"]
        .as_str()
        .or_else(|| info["creator"].as_str())
        .or_else(|| info["channel"].as_str())
        .or_else(|| info["uploader_id"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let mut t = info["title"].as_str().unwrap_or("").trim().to_string();
    let lower = t.to_lowercase();
    let by_user = ["video by ", "photo by ", "reel by "]
        .iter()
        .find_map(|prefix| {
            if !lower.starts_with(prefix) {
                return None;
            }
            let rest = t[prefix.len()..].trim().to_string();
            if rest.is_empty() {
                None
            } else {
                Some(rest)
            }
        });
    let generic = t.is_empty()
        || lower == "post"
        || lower == "reel"
        || lower == "instagram"
        || by_user.is_some();

    if generic {
        let desc = info["description"].as_str().unwrap_or("").trim();
        if !desc.is_empty() {
            let first = desc.lines().next().unwrap_or(desc).chars().take(80).collect::<String>();
            let first = first.trim().to_string();
            t = if !uploader.is_empty() && !first.to_lowercase().contains(&uploader.to_lowercase()) {
                format!("{uploader} - {first}")
            } else {
                first
            };
        } else if let Some(user) = by_user {
            t = user;
        } else if !uploader.is_empty() {
            t = uploader.clone();
        } else {
            t.clear();
        }
    }

    let raw = if t.is_empty() {
        if uploader.is_empty() {
            "video".to_string()
        } else {
            uploader
        }
    } else {
        t
    };

    raw.chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .take(120)
        .collect()
}

fn parse_formats_single(info: &serde_json::Value) -> Result<Vec<MediaFormat>, String> {
    let safe_title = get_smart_title(info);

    let mut formats: Vec<MediaFormat> = Vec::new();
    let mut seen_urls = std::collections::HashSet::new();

    // Progressive / default URL — only treat as video+audio when codecs / CDN heuristics agree.
    // Instagram often puts a silent DASH rendition in `url` alongside real formats[].
    if let Some(direct) = info["url"].as_str() {
        let ext = info["ext"].as_str().unwrap_or("mp4");
        seen_urls.insert(direct.to_string());
        let av = av_from_codecs(info.get("vcodec"), info.get("acodec"), direct)
            .unwrap_or(AvKind::Both);
        let av_tag = av.label();
        formats.push(MediaFormat {
            id: "0".to_string(),
            label: format!("{safe_title} — {av_tag} {ext}"),
            url: direct.to_string(),
            ext: format!(".{}", ext.trim_start_matches('.')),
            filesize: info["filesize"]
                .as_u64()
                .or_else(|| info["filesize_approx"].as_u64()),
            source: None,
            kind: Some("progressive".to_string()),
        });
        if info["formats"].as_array().map_or(true, |a| a.is_empty()) {
            return Ok(formats);
        }
    }

    if let Some(raw) = info["formats"].as_array() {
        for f in raw {
            if !f["url"].is_string() {
                continue;
            }
            let format_url = f["url"].as_str().unwrap();
            if seen_urls.contains(format_url) {
                continue;
            }
            let format_id = f["format_id"].as_str().unwrap_or("");
            if f["ext"] == "mhtml" || f["format_note"] == "storyboard" || format_id.starts_with("sb")
            {
                continue;
            }
            let Some(av) = av_from_codecs(f.get("vcodec"), f.get("acodec"), format_url) else {
                continue;
            };
            let av_tag = av.label();
            let resolution = f["resolution"].as_str().unwrap_or("");
            let filesize = f["filesize"]
                .as_u64()
                .or_else(|| f["filesize_approx"].as_u64());
            let ext = f["ext"].as_str().unwrap_or("mp4");
            let size_str = filesize
                .map(|s| format!(" · {}", crate::util::format_bytes(s)))
                .unwrap_or_default();

            let mut parts: Vec<&str> = Vec::new();
            if !resolution.is_empty() && resolution != "audio only" {
                parts.push(resolution);
            }
            parts.push(av_tag);
            parts.push(ext);
            let body = parts.join(" ");
            let label = if size_str.is_empty() {
                format!("{safe_title} — {body}")
            } else {
                format!("{safe_title} — {body}{size_str}")
            };

            let kind = if f["protocol"]
                .as_str()
                .map(|p| p.contains("m3u8") || p.contains("dash"))
                .unwrap_or(false)
            {
                "manifest"
            } else {
                "progressive"
            };

            seen_urls.insert(format_url.to_string());
            formats.push(MediaFormat {
                id: format_id.to_string(),
                label: label.trim().to_string(),
                url: format_url.to_string(),
                ext: format!(".{}", ext.trim_start_matches('.')),
                filesize,
                source: None,
                kind: Some(kind.to_string()),
            });
        }
    }

    formats.sort_by(|a, b| b.filesize.unwrap_or(0).cmp(&a.filesize.unwrap_or(0)));
    Ok(formats)
}

#[derive(Clone, Copy)]
enum AvKind {
    Both,
    Video,
    Audio,
}

impl AvKind {
    fn label(self) -> &'static str {
        match self {
            AvKind::Both => "video+audio",
            AvKind::Video => "video only",
            AvKind::Audio => "audio only",
        }
    }
}

/// Instagram CDN: `efg` embeds vencode_tag with `dash_…` for silent video-only DASH.
pub fn is_instagram_silent_dash_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    if !(host.contains("instagram.") || host.contains("fbcdn.net") || host.contains("cdninstagram"))
    {
        return false;
    }
    if parsed.path().to_lowercase().contains(".m4a") {
        return false;
    }
    let Some(efg) = parsed
        .query_pairs()
        .find(|(k, _)| k == "efg")
        .map(|(_, v)| v.into_owned())
    else {
        return false;
    };
    use base64::Engine as _;
    let padded = {
        let pad = (4 - (efg.len() % 4)) % 4;
        format!("{efg}{}", "=".repeat(pad))
    };
    let std = padded.replace('-', "+").replace('_', "/");
    base64::engine::general_purpose::STANDARD
        .decode(std.as_bytes())
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .map(|s| s.to_lowercase().contains("dash_"))
        .unwrap_or(false)
}

fn av_from_codecs(
    vcodec: Option<&serde_json::Value>,
    acodec: Option<&serde_json::Value>,
    url: &str,
) -> Option<AvKind> {
    let has_video = vcodec.and_then(|v| v.as_str()).map(|c| c != "none").unwrap_or(false);
    let has_audio = acodec.and_then(|v| v.as_str()).map(|c| c != "none").unwrap_or(false);
    if has_video || has_audio {
        if has_video && has_audio && is_instagram_silent_dash_url(url) {
            return Some(AvKind::Video);
        }
        return Some(if has_video && has_audio {
            AvKind::Both
        } else if has_video {
            AvKind::Video
        } else {
            AvKind::Audio
        });
    }
    if is_instagram_silent_dash_url(url) {
        return Some(AvKind::Video);
    }
    None
}

#[allow(dead_code)]
fn parse_playlist(output: &str) -> Result<Vec<PlaylistEntry>, String> {
    let info: serde_json::Value = serde_json::from_str(output)
        .map_err(|e| format!("Failed to parse playlist JSON: {e}"))?;

    if info["_type"] != "playlist" {
        return Err("Not a playlist".to_string());
    }

    let entries = info["entries"].as_array().ok_or("No entries in playlist")?;
    let mut out = Vec::new();

    for (i, entry) in entries.iter().enumerate() {
        let entry_url: Option<String> = entry["url"]
            .as_str()
            .map(|s| s.to_string())
            .or_else(|| entry["webpage_url"].as_str().map(|s| s.to_string()))
            .or_else(|| {
                entry["id"].as_str().map(|id| {
                    format!("https://www.youtube.com/watch?v={id}")
                })
            });

        if let Some(url) = entry_url {
            if url.starts_with("http") {
                out.push(PlaylistEntry {
                    url,
                    title: entry["title"].as_str().map(|s| s.to_string()),
                    index: Some(
                        entry["playlist_index"]
                            .as_u64()
                            .map(|i| i as usize)
                            .unwrap_or(i + 1),
                    ),
                });
            }
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const YOUTUBE_MULTI: &str = include_str!("../tests/fixtures/youtube_multi_format.json");
    const INSTAGRAM_DIRECT: &str = include_str!("../tests/fixtures/instagram_direct.json");
    const YOUTUBE_PLAYLIST: &str = include_str!("../tests/fixtures/youtube_playlist.json");

    #[test]
    fn parse_youtube_formats_filters_storyboard_and_video_only_labels() {
        let formats = parse_formats(YOUTUBE_MULTI, "https://www.youtube.com/watch?v=abc").unwrap();
        let ids: Vec<_> = formats.iter().map(|f| f.id.as_str()).collect();
        assert!(!ids.contains(&"sb0"));
        assert!(ids.contains(&"137"));
        assert!(ids.contains(&"18"));
        assert!(ids.contains(&"140"));
        assert!(formats.iter().any(|f| f.label.contains("video only")));
        assert!(formats.iter().any(|f| f.label.contains("video+audio")));
    }

    #[test]
    fn parse_youtube_marks_dash_as_manifest() {
        let json = r#"{
            "title": "Clip",
            "formats": [{
                "format_id": "96",
                "url": "https://example.com/dash.mpd",
                "ext": "mp4",
                "protocol": "http_dash_segments",
                "vcodec": "avc1",
                "acodec": "mp4a",
                "resolution": "1920x1080"
            }]
        }"#;
        let formats = parse_formats(json, "https://youtube.com/watch?v=x").unwrap();
        assert_eq!(formats[0].kind.as_deref(), Some("manifest"));
    }

    #[test]
    fn parse_instagram_prefers_caption_title_and_keeps_progressive() {
        let formats =
            parse_formats(INSTAGRAM_DIRECT, "https://www.instagram.com/reel/AbCd/").unwrap();
        // Top-level silent dash (reclassified) + dash-v + dash-a + progressive
        assert!(formats.len() >= 3);
        assert!(formats.iter().any(|f| f.label.contains("cool_creator")));
        assert!(formats.iter().any(|f| f.label.contains("Sunset over the bay")));
        let progressive = formats.iter().find(|f| f.id == "progressive").unwrap();
        assert!(progressive.url.contains("combined.mp4"));
        assert!(progressive.label.contains("video+audio"));
        // Top-level url has dash_ in efg — must not be offered as video+audio.
        let top = formats.iter().find(|f| f.id == "0").unwrap();
        assert!(top.label.contains("video only"));
        assert!(is_instagram_silent_dash_url(&top.url));
    }

    #[test]
    fn finalize_instagram_picker_hides_silent_dash() {
        let formats =
            parse_formats(INSTAGRAM_DIRECT, "https://www.instagram.com/reel/AbCd/").unwrap();
        let out = finalize_combined_av_picker(formats, "instagram");
        assert_eq!(out[0].id, "best");
        assert!(out[0].url.contains("combined.mp4"));
        assert_eq!(out[0].source.as_deref(), Some("instagram"));
        assert!(out.iter().any(|f| f.id == "progressive"));
        assert!(!out.iter().any(|f| f.label.contains("video only")));
        assert!(!out.iter().any(|f| f.label.contains("audio only")));
        assert!(!out.iter().any(|f| is_instagram_silent_dash_url(&f.url)));
    }

    #[test]
    fn parse_formats_rejects_invalid_json() {
        assert!(parse_formats("{not json", "https://example.com").is_err());
    }

    #[test]
    fn finalize_youtube_picker_adds_best_and_hides_video_only() {
        let raw = vec![
            MediaFormat {
                id: "137".into(),
                label: "Song — 1920x1080 video only webm · 200 MB".into(),
                url: "https://v.example/v".into(),
                ext: ".webm".into(),
                filesize: Some(200_000_000),
                source: None,
                kind: Some("progressive".into()),
            },
            MediaFormat {
                id: "18".into(),
                label: "Song — 640x360 video+audio mp4 · 11 MB".into(),
                url: "https://v.example/p".into(),
                ext: ".mp4".into(),
                filesize: Some(11_000_000),
                source: None,
                kind: Some("progressive".into()),
            },
            MediaFormat {
                id: "140".into(),
                label: "Song — audio only m4a".into(),
                url: "https://v.example/a".into(),
                ext: ".m4a".into(),
                filesize: None,
                source: None,
                kind: Some("progressive".into()),
            },
        ];
        let out = finalize_youtube_picker(raw);
        assert_eq!(out[0].id, "best");
        // Best must carry the top progressive URL so download skips a second yt-dlp.
        assert_eq!(out[0].url, "https://v.example/p");
        assert!(out.iter().any(|f| f.id == "18"));
        assert!(!out.iter().any(|f| f.id == "137"));
        assert!(!out.iter().any(|f| f.id == "140"));
        assert_eq!(out[0].source.as_deref(), Some("youtube"));
    }

    #[test]
    fn parse_height_from_resolution_and_p_label() {
        assert_eq!(parse_height("1920x1080 video+audio"), 1080);
        assert_eq!(parse_height("720p mp4"), 720);
        assert_eq!(parse_height("audio only"), 0);
    }

    #[test]
    fn parse_stderr_error_prefers_youtube_messages() {
        let stderr = "WARNING: foo\nERROR: [youtube] abc: Sign in to confirm you're not a bot";
        assert!(parse_stderr_error(stderr, 1).contains("Sign in"));
    }

    #[test]
    fn force_attempts_keep_longer_timeouts_than_prefetch() {
        // force still means "harder / longer tries" — only the race strategy was unified.
        let forced = youtube_attempts(true);
        let soft = youtube_attempts(false);
        assert!(forced.len() >= soft.len());
        assert!(forced[0].timeout_secs >= soft[0].timeout_secs);
        assert!(forced[0].timeout_secs >= 24);
    }

    #[test]
    fn ytdlp_shared_args_includes_node_runtime() {
        let args = ytdlp_shared_args();
        assert_eq!(args, vec!["--js-runtimes", "node"]);
    }

    #[test]
    fn build_args_includes_no_playlist_and_js_runtime() {
        let attempt = YtAttempt {
            cookie_args: vec!["--cookies-from-browser".into(), "chrome".into()],
            extra_args: vec![],
            timeout_secs: 18,
            label: "test".into(),
            allow_playlist: false,
        };
        let args = build_args("https://www.youtube.com/watch?v=x", &attempt);
        assert!(args.contains(&"--no-playlist".to_string()));
        assert!(args.contains(&"--js-runtimes".to_string()));
        assert!(args.contains(&"node".to_string()));
        assert!(args.contains(&"https://www.youtube.com/watch?v=x".to_string()));

        // Non-YouTube URLs also get --js-runtimes node (backend parity).
        let args_non_yt = build_args("https://www.instagram.com/reel/x", &attempt);
        assert!(args_non_yt.contains(&"--js-runtimes".to_string()));
        assert!(args_non_yt.contains(&"node".to_string()));
    }

    #[test]
    fn build_args_omits_no_playlist_when_carousel_allowed() {
        let attempt = YtAttempt {
            cookie_args: vec!["--cookies-from-browser".into(), "chrome".into()],
            extra_args: vec![],
            timeout_secs: 14,
            label: "instagram/chrome".into(),
            allow_playlist: true,
        };
        let args = build_args("https://www.instagram.com/p/abc/", &attempt);
        assert!(!args.contains(&"--no-playlist".to_string()));
    }

    #[test]
    fn parse_formats_expands_instagram_carousel_playlist() {
        const CAROUSEL: &str = include_str!("../tests/fixtures/instagram_carousel.json");
        let formats = parse_formats(CAROUSEL, "https://www.instagram.com/p/abc/").unwrap();
        assert_eq!(formats.len(), 2);
        // Slash in slide marks is sanitized (same as filename-safe stem) → [1_2].
        assert!(formats.iter().any(|f| f.label.contains("[1_2]")));
        assert!(formats.iter().any(|f| f.label.contains("[2_2]")));
        assert!(formats.iter().any(|f| f.url.contains("slide1")));
        assert!(formats.iter().any(|f| f.url.contains("slide2")));
    }

    #[test]
    fn youtube_attempts_include_cookie_browsers_and_player_clients() {
        let attempts = youtube_attempts(false);
        assert!(attempts.len() >= 5);
        assert!(attempts.iter().any(|a| a.label.starts_with("youtube/chrome")));
        assert!(attempts.iter().any(|a| a.label == "youtube/no-cookies"));
        assert!(attempts
            .iter()
            .any(|a| a.extra_args.iter().any(|x| x.contains("player_client"))));
    }

    #[test]
    fn parse_playlist_entries() {
        let entries = parse_playlist(YOUTUBE_PLAYLIST).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].url, "https://www.youtube.com/watch?v=abc111");
        assert_eq!(entries[1].title.as_deref(), Some("Second Track"));
    }

    #[test]
    fn parse_playlist_rejects_non_playlist() {
        assert!(parse_playlist(r#"{"_type":"video","title":"solo"}"#).is_err());
    }

    #[test]
    fn list_formats_applies_youtube_picker_to_fixture_json() {
        let parsed = parse_formats(YOUTUBE_MULTI, "https://www.youtube.com/watch?v=abc").unwrap();
        let picked = finalize_youtube_picker(parsed);
        assert!(!picked.is_empty());
        assert_eq!(picked[0].id, "best");
    }
}
