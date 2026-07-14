use std::path::{Path, PathBuf};

/// Sanitize a filename by removing dangerous characters and limiting length.
pub fn sanitize_filename(name: &str) -> String {
    let mut out: String = name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    if out.len() > 200 {
        let ext = Path::new(&out).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let stem_len = 200 - ext.len();
        if stem_len > 0 {
            let stem: String = out.chars().take(stem_len).collect();
            out = format!("{}{}", stem, ext);
        } else {
            out = out.chars().take(200).collect();
        }
    }
    if out.trim().is_empty() {
        out = "download".to_string();
    }
    out
}

/// Securely join a base directory with a relative path, ensuring the result
/// stays inside the base directory (path traversal protection).
#[allow(dead_code)]
pub fn safe_join(base: &Path, component: &str) -> Option<PathBuf> {
    let cleaned = component.trim_start_matches('/').trim_start_matches('\\');
    let joined = base.join(cleaned);
    // Canonicalize to resolve any .. components
    match joined.canonicalize() {
        Ok(canon) if canon.starts_with(base) => Some(canon),
        Ok(_) => None, // traversal attempt
        Err(_) => {
            // Path may not exist yet — resolve manually
            let mut resolved = base.to_path_buf();
            for part in Path::new(cleaned) {
                match part.to_str() {
                    Some("..") => { resolved.pop(); },
                    Some(".") | None => {},
                    Some(segment) => resolved.push(segment),
                }
            }
            if resolved.starts_with(base) { Some(resolved) } else { None }
        }
    }
}

/// Category based on file extension.
#[allow(dead_code)]
pub fn category_for_ext(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        e if matches!(e, ".mp4" | ".mkv" | ".webm" | ".avi" | ".mov" | ".m4v") => "videos",
        e if matches!(e, ".mp3" | ".wav" | ".flac" | ".ogg" | ".m4a") => "audio",
        e if matches!(e, ".zip" | ".rar" | ".7z" | ".tar" | ".gz" | ".bz2") => "archives",
        e if matches!(e, ".pdf" | ".doc" | ".docx" | ".xls" | ".xlsx") => "documents",
        e if matches!(e, ".png" | ".jpg" | ".jpeg" | ".gif" | ".webp" | ".svg") => "images",
        _ => "other",
    }
}

/// Generate a unique save path by appending (1), (2), etc. if the path exists.
pub fn unique_save_path(save_path: &Path) -> PathBuf {
    if !save_path.exists() {
        return save_path.to_path_buf();
    }
    let parent = save_path.parent().unwrap_or(Path::new("."));
    let stem = save_path.file_stem().unwrap().to_string_lossy().to_string();
    let ext = save_path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for i in 1..100 {
        let candidate = parent.join(format!("{} ({}){}", stem, i, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    save_path.to_path_buf()
}

/// Check if a URL is a safe download target (no private/localhost/metadata IPs).
pub fn is_safe_download_url(url: &str) -> bool {
    // Basic URL validation — must be http or https
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return false;
    }
    // Block private hosts if configured
    let config = super::config::Config::from_env();
    if config.block_private_hosts {
        if let Ok(parsed) = url::Url::parse(url) {
            if let Some(host) = parsed.host_str() {
                // Block localhost
                if host == "localhost" || host == "127.0.0.1" || host == "::1" {
                    return false;
                }
                // Block private IP ranges
                if let Some(ip) = parsed.host().and_then(|h| match h {
                    url::Host::Ipv4(ip) => Some(ip),
                    _ => None,
                }) {
                    if ip.is_private() || ip.is_loopback() || ip.is_link_local() {
                        return false;
                    }
                    // Block 169.254.x.x (metadata)
                    if ip.octets()[0] == 169 && ip.octets()[1] == 254 {
                        return false;
                    }
                }
            }
        }
    }
    true
}

/// Get bytes available at or above a given path, walking up to root.
pub fn free_space(path: &Path) -> Option<u64> {
    let mut dir = path.to_path_buf();
    loop {
        match fs2::available_space(&dir) {
            Ok(space) => return Some(space),
            Err(_) => {
                if !dir.pop() {
                    return None;
                }
            }
        }
    }
}

/// Format bytes into human-readable string (e.g. "102.4 MB").
pub fn format_bytes(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB"];
    let mut size = n as f64;
    let mut unit_idx = 0;
    while size >= 1024.0 && unit_idx < 3 {
        size /= 1024.0;
        unit_idx += 1;
    }
    format!("{:.1} {}", size, units[unit_idx])
}

/// Open a graphical folder picker via zenity or kdialog (Linux).
/// Returns `None` if the user cancels or no picker is installed.
pub fn pick_directory() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let zenity = Command::new("zenity")
        .args(["--file-selection", "--directory"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    if let Ok(mut child) = zenity {
        let mut output = String::new();
        if child
            .stdout
            .take()
            .map_or(false, |mut o| o.read_to_string(&mut output).is_ok())
        {
            let trimmed = output.trim().to_string();
            if !trimmed.is_empty() {
                if child.wait().map_or(false, |s| s.success()) {
                    return Some(trimmed);
                }
                return None; // user cancelled
            }
        }
    }

    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".into());
    let kdialog = Command::new("kdialog")
        .args(["--getexistingdirectory", &home])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    if let Ok(mut child) = kdialog {
        let mut output = String::new();
        if child
            .stdout
            .take()
            .map_or(false, |mut o| o.read_to_string(&mut output).is_ok())
        {
            let trimmed = output.trim().to_string();
            if !trimmed.is_empty() {
                if child.wait().map_or(false, |s| s.success()) {
                    return Some(trimmed);
                }
                return None;
            }
        }
    }

    log::warn!("No graphical folder picker available (tried zenity, kdialog).");
    None
}

/// Resolve the path to the core_engine binary, checking relative to executable first,
/// then Tauri resource dir, then release build dir, then PATH.
pub fn find_core_engine(manifest_dir: &str) -> PathBuf {
    // 1. Relative to the running executable
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.parent().unwrap().join("binaries").join("core_engine");
        if sibling.exists() { return sibling; }
    }
    // 2. Bundled with Tauri sidecar (dev path during cargo build)
    let bundled = PathBuf::from(manifest_dir).join("binaries").join("core_engine");
    if bundled.exists() { return bundled; }
    // 3. Project release build
    let project = PathBuf::from(manifest_dir)
        .parent().unwrap()
        .parent().unwrap()
        .join("core_engine")
        .join("target")
        .join("release")
        .join("core_engine");
    if project.exists() { return project; }
    // 4. PATH
    PathBuf::from("core_engine")
}

/// Resolve the path to the yt-dlp binary, checking relative to executable first,
/// then bundled paths, then PATH.
pub fn find_ytdlp(manifest_dir: &str) -> PathBuf {
    let manifest = PathBuf::from(manifest_dir);
    let desktop_root = manifest.parent().unwrap(); // desktop/
    let project_root = desktop_root.parent().unwrap(); // repo root

    let candidates = [
        // 1. Relative to the running executable (packaged sidecar)
        std::env::current_exe()
            .ok()
            .and_then(|exe| {
                let p = exe.parent()?.join("bin").join("yt-dlp");
                p.exists().then_some(p)
            }),
        // 2. desktop/bin/yt-dlp (Tauri bundle dev path)
        Some(desktop_root.join("bin").join("yt-dlp")),
        // 3. backend/bin/yt-dlp (shared with Node coordinator during dev)
        Some(project_root.join("backend").join("bin").join("yt-dlp")),
        // 4. repo/bin/yt-dlp (legacy layout)
        Some(project_root.join("bin").join("yt-dlp")),
    ];

    for path in candidates.into_iter().flatten() {
        if path.exists() {
            return path;
        }
    }

    PathBuf::from("yt-dlp")
}

/// Returns the resolved yt-dlp path if the binary exists on disk.
pub fn ytdlp_binary() -> Option<PathBuf> {
    let path = find_ytdlp(env!("CARGO_MANIFEST_DIR"));
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

/// Sidecar paths under `{parent}/.veloce/` (hidden dir; keeps Downloads tidy).
/// Also recognizes legacy `{save}.veloce_state` / `{save}.veloce_done`.
pub fn resume_sidecar_paths(save_path: &Path) -> (PathBuf, PathBuf) {
    let parent = save_path.parent().unwrap_or_else(|| Path::new("."));
    let name = save_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    let dir = parent.join(".veloce");
    (dir.join(format!("{name}.state")), dir.join(format!("{name}.done")))
}

/// Remove resume sidecars (hidden `.veloce/` + legacy adjacent files).
pub fn remove_resume_sidecars(save_path: &Path) {
    let (state, done) = resume_sidecar_paths(save_path);
    let _ = std::fs::remove_file(&state);
    let _ = std::fs::remove_file(&done);
    let legacy_state = PathBuf::from(format!("{}.veloce_state", save_path.display()));
    let legacy_done = PathBuf::from(format!("{}.veloce_done", save_path.display()));
    let _ = std::fs::remove_file(&legacy_state);
    let _ = std::fs::remove_file(&legacy_done);
}

fn spawn_detached(mut cmd: std::process::Command) -> Result<(), String> {
    use std::process::Stdio;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("Failed to open path: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn file_url(path: &Path) -> String {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    url::Url::from_file_path(&abs)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| format!("file://{}", abs.to_string_lossy()))
}

/// Open a file or folder with the OS default handler (cross-platform).
pub fn open_path(target: &str) -> Result<(), String> {
    use std::process::Command;
    let path = Path::new(target);
    if !path.exists() {
        return Err(format!("Path does not exist: {target}"));
    }

    #[cfg(target_os = "macos")]
    {
        return spawn_detached({
            let mut c = Command::new("open");
            c.arg(target);
            c
        });
    }
    #[cfg(target_os = "windows")]
    {
        return spawn_detached({
            let mut c = Command::new("cmd");
            c.args(["/C", "start", "", target]);
            c
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux / BSD — try xdg-open, then gio
        if spawn_detached({
            let mut c = Command::new("xdg-open");
            c.arg(target);
            c
        })
        .is_ok()
        {
            return Ok(());
        }
        spawn_detached({
            let mut c = Command::new("gio");
            c.args(["open", target]);
            c
        })
    }
}

/// Reveal a file in the file manager (highlight when supported).
pub fn reveal_in_folder(file_path: &str) -> Result<(), String> {
    use std::process::Command;
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("Path does not exist: {file_path}"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "No parent folder".to_string())?;

    #[cfg(target_os = "macos")]
    {
        return spawn_detached({
            let mut c = Command::new("open");
            c.args(["-R", file_path]);
            c
        });
    }
    #[cfg(target_os = "windows")]
    {
        return spawn_detached({
            let mut c = Command::new("explorer");
            c.arg(format!("/select,{file_path}"));
            c
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let uri = file_url(path);
        let dbus = Command::new("dbus-send")
            .args([
                "--session",
                "--print-reply",
                "--dest=org.freedesktop.FileManager1",
                "--type=method_call",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
                &format!("array:string:{uri}"),
                "string:",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        if let Ok(mut child) = dbus {
            let parent_s = parent.to_string_lossy().into_owned();
            std::thread::spawn(move || {
                let ok = child.wait().map(|s| s.success()).unwrap_or(false);
                if !ok {
                    let _ = open_path(&parent_s);
                }
            });
            return Ok(());
        }
        open_path(&parent.to_string_lossy())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── sanitize_filename ───────────────────────────────────────────────

    #[test]
    fn test_sanitize_filename_normal() {
        assert_eq!(sanitize_filename("hello world.mp4"), "hello world.mp4");
    }

    #[test]
    fn test_sanitize_filename_replaces_special_chars() {
        let result = sanitize_filename("file:name/test?foo*bar\"baz<more|pipe");
        assert!(!result.contains(':'));
        assert!(!result.contains('/'));
        assert!(!result.contains('?'));
        assert!(!result.contains('*'));
        assert!(!result.contains('\"'));
        assert!(!result.contains('<'));
        assert!(!result.contains('|'));
        assert!(result.contains('_')); // all replaced with underscores
    }

    #[test]
    fn test_sanitize_filename_truncates_long() {
        let long_name = "a".repeat(300) + ".mp4";
        let result = sanitize_filename(&long_name);
        assert!(result.len() <= 200);
        assert!(result.ends_with(".mp4"));
    }

    #[test]
    fn test_sanitize_filename_empty_becomes_download() {
        assert_eq!(sanitize_filename(""), "download");
    }

    #[test]
    fn test_sanitize_filename_whitespace_becomes_download() {
        assert_eq!(sanitize_filename("   "), "download");
    }

    #[test]
    fn test_sanitize_filename_control_chars() {
        let result = sanitize_filename("file\x00name\x01test.mp4");
        assert!(!result.contains('\x00'));
        assert!(!result.contains('\x01'));
    }

    #[test]
    fn test_sanitize_filename_preserves_unicode() {
        let result = sanitize_filename("日本語ファイル.mp4");
        assert_eq!(result, "日本語ファイル.mp4");
    }

    // ── format_bytes ────────────────────────────────────────────────────

    #[test]
    fn test_format_bytes_zero() {
        assert_eq!(format_bytes(0), "0.0 B");
    }

    #[test]
    fn test_format_bytes_exact_kb() {
        assert_eq!(format_bytes(1024), "1.0 KB");
    }

    #[test]
    fn test_format_bytes_fractional_mb() {
        assert_eq!(format_bytes(1_572_864), "1.5 MB"); // 1.5 * 1024 * 1024
    }

    #[test]
    fn test_format_bytes_large_gb() {
        assert_eq!(format_bytes(3_221_225_472), "3.0 GB"); // 3 * 1024^3
    }

    // ── is_safe_download_url ────────────────────────────────────────────

    #[test]
    fn test_is_safe_download_url_https() {
        assert!(is_safe_download_url("https://example.com/video.mp4"));
    }

    #[test]
    fn test_is_safe_download_url_http() {
        assert!(is_safe_download_url("http://example.com/video.mp4"));
    }

    #[test]
    fn test_is_safe_download_url_rejects_ftp() {
        assert!(!is_safe_download_url("ftp://example.com/file.mp4"));
    }

    #[test]
    fn test_is_safe_download_url_rejects_empty() {
        assert!(!is_safe_download_url(""));
    }

    #[test]
    fn test_is_safe_download_url_rejects_no_protocol() {
        assert!(!is_safe_download_url("just/a/path.mp4"));
    }
}

