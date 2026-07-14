//! SSRF / DoS guards for the download engine.
//!
//! The coordinator validates URLs at queue time, but the engine must also protect
//! itself: redirects can jump to private IPs, threads can be inflated, and
//! malicious Content-Length can exhaust memory/disk.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use url::Url;

/// Hard ceiling for parallel connections (coordinator + CLI).
pub const MAX_THREADS: u64 = 64;
/// Reject discoveries larger than this (512 GiB) to avoid OOM / disk fill.
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024 * 1024;
/// Reject absurd piece maps from tiny piece_size + huge file.
pub const MAX_PIECES: usize = 1_000_000;
/// Max redirects in a single request chain.
pub const MAX_REDIRECTS: usize = 5;

/// Integration tests / local fixtures only — never set in production.
pub fn allow_local_urls() -> bool {
    matches!(
        std::env::var("VELOCE_ALLOW_LOCAL_URLS").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

/// Clamp CLI/WS thread count into a safe range.
pub fn clamp_threads(threads: u64) -> u64 {
    threads.clamp(1, MAX_THREADS)
}

/// True when the host must never be fetched (loopback / private / metadata).
pub fn is_blocked_host(host: &str) -> bool {
    let h = host.trim().trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if h.is_empty()
        || h == "localhost"
        || h == "0.0.0.0"
        || h == "::1"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
    {
        return true;
    }
    if let Ok(ip) = h.parse::<Ipv4Addr>() {
        return is_blocked_ipv4(ip);
    }
    if let Ok(ip) = h.parse::<Ipv6Addr>() {
        return is_blocked_ipv6(ip);
    }
    // Hostname that looks like an IPv4 with leading zeros already handled by parse.
    false
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_unspecified()
        || {
            // Cloud metadata (AWS/GCP/Azure link-local).
            let o = ip.octets();
            o[0] == 169 && o[1] == 254
        }
        || {
            // CGNAT 100.64.0.0/10
            let o = ip.octets();
            o[0] == 100 && (o[1] & 0xc0) == 64
        }
}

fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    ip.is_loopback()
        || ip.is_unspecified()
        || matches!(ip.segments()[0] & 0xffc0, 0xfe80) // link-local
        || matches!(ip.segments()[0] & 0xfe00, 0xfc00) // unique local
}

/// Only http(s) to non-private hosts.
pub fn is_safe_download_url(raw: &str) -> Result<(), String> {
    let u = Url::parse(raw).map_err(|_| "Invalid URL".to_string())?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err(format!(
            "Unsupported protocol \"{}\". Only http/https are allowed.",
            u.scheme()
        ));
    }
    let host = u
        .host_str()
        .ok_or_else(|| "URL missing host".to_string())?;
    if is_blocked_host(host) && !allow_local_urls() {
        return Err(
            "Downloads from local/private/metadata network addresses are blocked.".to_string(),
        );
    }
    Ok(())
}

/// reqwest redirect policy: hop limit + block private redirect targets.
pub fn safe_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > MAX_REDIRECTS {
            return attempt.error("too many redirects");
        }
        let next = attempt.url();
        if next.scheme() != "http" && next.scheme() != "https" {
            return attempt.error("redirect to non-http(s) scheme blocked");
        }
        match next.host_str() {
            Some(host) if is_blocked_host(host) && !allow_local_urls() => {
                attempt.error("redirect to private/local/metadata address blocked")
            }
            Some(_) => attempt.follow(),
            None => attempt.error("redirect missing host"),
        }
    })
}

/// Ensure `save_path` resolves under `base_dir` (path traversal guard).
pub fn resolve_save_path(base_dir: Option<&str>, save_path: &str) -> Result<PathBuf, String> {
    let save = PathBuf::from(save_path);
    let Some(base) = base_dir.filter(|b| !b.trim().is_empty()) else {
        return Ok(save);
    };
    let base = PathBuf::from(base);
    let base_canon = std::fs::canonicalize(&base).unwrap_or(base.clone());

    let candidate = if save.is_absolute() {
        save.clone()
    } else {
        base.join(&save)
    };

    // Create parent so canonicalize can succeed for new files.
    if let Some(parent) = candidate.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Canonicalize parent + append file name (file may not exist yet).
    let (parent, name) = match (candidate.parent(), candidate.file_name()) {
        (Some(p), Some(n)) => (p.to_path_buf(), n.to_os_string()),
        _ => return Err("Invalid save path".to_string()),
    };
    let parent_canon = std::fs::canonicalize(&parent).unwrap_or(parent);
    let resolved = parent_canon.join(name);

    if !resolved.starts_with(&base_canon) {
        return Err(format!(
            "save_path escapes base directory ({})",
            base_canon.display()
        ));
    }
    Ok(resolved)
}

/// Reject absurd discovery sizes before we allocate piece maps / preallocate.
pub fn validate_discovery_size(total_size: u64, piece_size: u64) -> Result<(), String> {
    if total_size == 0 {
        return Err("Discovered file size is zero".to_string());
    }
    if total_size > MAX_FILE_BYTES {
        return Err(format!(
            "File too large ({} bytes > {} byte limit)",
            total_size, MAX_FILE_BYTES
        ));
    }
    let ps = piece_size.max(1);
    let pieces = ((total_size + ps - 1) / ps) as usize;
    if pieces > MAX_PIECES {
        return Err(format!(
            "Too many pieces ({pieces} > {MAX_PIECES}) — refuse malicious Content-Length"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_loopback_and_private() {
        assert!(is_blocked_host("127.0.0.1"));
        assert!(is_blocked_host("localhost"));
        assert!(is_blocked_host("10.0.0.1"));
        assert!(is_blocked_host("192.168.1.1"));
        assert!(is_blocked_host("172.16.0.1"));
        assert!(is_blocked_host("169.254.169.254"));
        assert!(is_blocked_host("::1"));
        assert!(!is_blocked_host("cdn.example.com"));
        assert!(!is_blocked_host("8.8.8.8"));
    }

    #[test]
    fn safe_url_rejects_private() {
        assert!(is_safe_download_url("http://127.0.0.1/x").is_err());
        assert!(is_safe_download_url("https://cdn.example.com/x.mp4").is_ok());
        assert!(is_safe_download_url("ftp://cdn.example.com/x").is_err());
    }

    #[test]
    fn threads_clamped() {
        assert_eq!(clamp_threads(0), 1);
        assert_eq!(clamp_threads(8), 8);
        assert_eq!(clamp_threads(9999), MAX_THREADS);
    }

    #[test]
    fn discovery_size_caps() {
        assert!(validate_discovery_size(1024, 1024).is_ok());
        assert!(validate_discovery_size(MAX_FILE_BYTES + 1, 1024).is_err());
        assert!(validate_discovery_size(MAX_FILE_BYTES, 1).is_err()); // too many pieces
    }

    #[test]
    fn save_path_confined() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_string_lossy().to_string();
        let ok = resolve_save_path(Some(&base), "video.mp4").unwrap();
        assert!(ok.starts_with(dir.path()));
        let escape = resolve_save_path(Some(&base), "../outside.mp4");
        assert!(escape.is_err());
    }
}
