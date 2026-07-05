use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Instant, Duration};

/// Platform/media source for a URL.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum MediaSource {
    YouTube,
    Instagram,
    TikTok,
    Twitter,
    MediaFire,
    GitHub,
    Direct,
    Generic,
}

/// A single downloadable format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaFormat {
    pub id: String,
    pub label: String,
    pub url: String,
    pub ext: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filesize: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// MediaFire download info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaFireInfo {
    pub file_name: String,
    pub direct_url: String,
    pub size_bytes: Option<u64>,
}

/// Cache entry for extracted best URLs.
struct CacheEntry {
    url: String,
    ts: Instant,
}

/// Format cache with TTL.
pub struct FormatCache {
    cache: Mutex<HashMap<String, CacheEntry>>,
    ttl: Duration,
}

impl FormatCache {
    pub fn new(ttl_secs: u64) -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            ttl: Duration::from_secs(ttl_secs),
        }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let cache = self.cache.lock().unwrap();
        match cache.get(key) {
            Some(entry) if entry.ts.elapsed() < self.ttl => Some(entry.url.clone()),
            _ => None,
        }
    }

    pub fn set(&self, key: &str, url: &str) {
        let mut cache = self.cache.lock().unwrap();
        cache.insert(key.to_string(), CacheEntry {
            url: url.to_string(),
            ts: Instant::now(),
        });
    }

    #[allow(dead_code)]
    pub fn invalidate(&self, key: &str) {
        let mut cache = self.cache.lock().unwrap();
        cache.remove(key);
    }

    #[allow(dead_code)]
    pub fn clear(&self) {
        let mut cache = self.cache.lock().unwrap();
        cache.clear();
    }
}

/// Detect the media source from a URL.
pub fn detect_source(url: &str) -> MediaSource {
    let lower = url.to_lowercase();
    if lower.contains("youtube.com") || lower.contains("youtu.be") {
        MediaSource::YouTube
    } else if lower.contains("instagram.com") {
        MediaSource::Instagram
    } else if lower.contains("tiktok.com") {
        MediaSource::TikTok
    } else if lower.contains("twitter.com") || lower.contains("x.com") {
        MediaSource::Twitter
    } else if lower.contains("mediafire.com") {
        MediaSource::MediaFire
    } else if is_github_url(url) {
        MediaSource::GitHub
    } else if is_direct_file_url(url) {
        MediaSource::Direct
    } else {
        MediaSource::Generic
    }
}

/// Check if a URL is a direct file download link.
pub fn is_direct_file_url(url: &str) -> bool {
    let direct_exts = [
        ".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".mp3",
        ".wav", ".flac", ".ogg", ".m4a", ".zip", ".rar", ".7z",
        ".tar", ".gz", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".xml",
    ];
    let lower = url.to_lowercase();
    // Must be http(s) and end with a direct file extension
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return false;
    }
    // Strip query string before checking extension
    let without_query = lower.split('?').next().unwrap_or(&lower);
    let without_fragment = without_query.split('#').next().unwrap_or(without_query);
    direct_exts.iter().any(|ext| without_fragment.ends_with(ext))
}

pub fn is_github_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("raw.githubusercontent.com")
        || (lower.contains("github.com") && lower.contains("/blob/"))
}

pub fn is_github_raw_url(url: &str) -> bool {
    url.to_lowercase().contains("raw.githubusercontent.com")
}

pub fn github_blob_to_raw(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_lowercase();
    if host == "raw.githubusercontent.com" {
        return Some(url.to_string());
    }
    if !host.ends_with("github.com") {
        return None;
    }
    static BLOB_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"^/([^/]+)/([^/]+)/blob/([^/]+)/(.+)$").expect("github blob regex")
    });
    let caps = BLOB_RE.captures(parsed.path())?;
    Some(format!(
        "https://raw.githubusercontent.com/{}/{}/{}/{}",
        &caps[1], &caps[2], &caps[3], &caps[4]
    ))
}

pub fn resolve_list_url(url: &str) -> String {
    github_blob_to_raw(url).unwrap_or_else(|| url.to_string())
}

/// Normalize a URL for consistent caching.
pub fn normalize_url(url: &str) -> String {
    let lower = url.to_lowercase();
    if lower.contains("youtube.com") || lower.contains("youtu.be") {
        // Extract video ID and build canonical URL
        if let Some(id) = extract_youtube_id(url) {
            return format!("https://www.youtube.com/watch?v={}", id);
        }
    }
    if lower.contains("instagram.com") {
        // Strip trailing slash and query params
        let no_query = url.split('?').next().unwrap_or(url).trim_end_matches('/');
        return no_query.to_string();
    }
    // Default: strip query string
    url.split('?').next().unwrap_or(url).trim_end_matches('/').to_string()
}

fn extract_youtube_id(url: &str) -> Option<String> {
    // Handle youtu.be/ID
    if let Some(short) = url.split("youtu.be/").nth(1) {
        return short.split('?').next().map(|s| s.split('/').next().unwrap_or(s).to_string());
    }
    // Handle youtube.com/watch?v=ID
    if url.contains("youtube.com/watch") {
        if let Ok(parsed) = url::Url::parse(url) {
            for (key, value) in parsed.query_pairs() {
                if key == "v" && !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    // Handle youtube.com/shorts/ID
    if let Some(shorts) = url.split("youtube.com/shorts/").nth(1) {
        return Some(shorts.split('?').next().unwrap_or(shorts).split('/').next().unwrap_or(shorts).to_string());
    }
    None
}

/// Resolve a MediaFire file page URL to a direct CDN URL by scraping the page.
pub async fn resolve_mediafire(url: &str) -> Result<MediaFireInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let resp = client.get(url).send().await
        .map_err(|e| format!("Failed to fetch MediaFire page: {}", e))?;
    let html = resp.text().await
        .map_err(|e| format!("Failed to read MediaFire page: {}", e))?;

    // Extract file name from og:title or title
    let file_name = extract_meta_content(&html, "og:title")
        .or_else(|| extract_title(&html))
        .unwrap_or_else(|| "mediafire_file".to_string());

    // Extract download URL from the download button or link
    let direct_url = extract_mediafire_download_url(&html)
        .ok_or_else(|| "Could not find download link on MediaFire page".to_string())?;

    // Extract file size from the info section
    let size_bytes = extract_mediafire_size(&html);

    Ok(MediaFireInfo {
        file_name,
        direct_url,
        size_bytes,
    })
}

fn extract_meta_content(html: &str, property: &str) -> Option<String> {
    let search = format!("property=\"{}\"", property);
    // Try pattern: <meta property="og:title" content="..." />
    let start = html.find(&search)?;
    let rest = &html[start..];
    let content_start = rest.find("content=\"")?;
    let value_start = content_start + 9;
    let value_end = rest[value_start..].find('\"')?;
    Some(rest[value_start..value_start + value_end].to_string())
}

fn extract_title(html: &str) -> Option<String> {
    let start = html.find("<title>")?;
    let end = html[start + 7..].find("</title>")?;
    Some(html[start + 7..start + 7 + end].trim().to_string())
}

fn extract_mediafire_download_url(html: &str) -> Option<String> {
    // Pattern 1: download_link class
    if let Some(start) = html.find("class=\"download_link\"") {
        let rest = &html[start..];
        if let Some(href_start) = rest.find("href=\"") {
            let url_start = href_start + 6;
            let url_end = rest[url_start..].find('\"')?;
            let url = &rest[url_start..url_start + url_end];
            if url.starts_with("http") {
                return Some(url.to_string());
            }
        }
    }
    // Pattern 2: #downloadButton
    if let Some(start) = html.find("id=\"downloadButton\"") {
        let rest = &html[start..];
        if let Some(href_start) = rest.find("href=\"") {
            let url_start = href_start + 6;
            let url_end = rest[url_start..].find('\"')?;
            let url = &rest[url_start..url_start + url_end];
            if url.starts_with("http") {
                return Some(url.to_string());
            }
        }
    }
    // Pattern 3: any link in download box
    if let Some(start) = html.find("class=\"input\"") {
        let rest = &html[start..];
        if let Some(href_start) = rest.find("href=\"") {
            let url_start = href_start + 6;
            let url_end = rest[url_start..].find('\"')?;
            let url = &rest[url_start..url_start + url_end];
            if url.starts_with("http") {
                return Some(url.to_string());
            }
        }
    }
    None
}

fn extract_mediafire_size(html: &str) -> Option<u64> {
    // Look for file size text like "102.4 MB"
    let patterns = ["class=\"file_size\"", "class=\"details\"", "\"size\""];
    for pattern in &patterns {
        if let Some(start) = html.find(pattern) {
            let section = &html[start..start + 200];
            // Find numbers followed by KB/MB/GB
            for line in section.lines() {
                if let Some(size) = parse_size_string(line) {
                    return Some(size);
                }
            }
        }
    }
    None
}

static SIZE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"([\d.]+)\s*(B|KB|MB|GB)").expect("Invalid size regex")
});

fn parse_size_string(s: &str) -> Option<u64> {
    let s = s.trim();
    let caps = SIZE_RE.captures(s)?;
    let num: f64 = caps.get(1)?.as_str().parse().ok()?;
    let unit = caps.get(2)?.as_str();
    let bytes = match unit {
        "B" => num,
        "KB" => num * 1024.0,
        "MB" => num * 1024.0 * 1024.0,
        "GB" => num * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some(bytes as u64)
}

/// Format bytes into human-readable string.
pub fn format_bytes(n: u64) -> String {
    crate::util::format_bytes(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── detect_source ────────────────────────────────────────────────────

    #[test]
    fn test_detect_source_youtube() {
        assert_eq!(detect_source("https://youtube.com/watch?v=dQw4w9WgXcQ"), MediaSource::YouTube);
        assert_eq!(detect_source("https://youtu.be/dQw4w9WgXcQ"), MediaSource::YouTube);
        assert_eq!(detect_source("https://www.youtube.com/shorts/abc123"), MediaSource::YouTube);
        assert_eq!(detect_source("HTTP://YOUTUBE.COM/WATCH?V=ID"), MediaSource::YouTube);
    }

    #[test]
    fn test_detect_source_instagram() {
        assert_eq!(detect_source("https://instagram.com/p/ABC123/"), MediaSource::Instagram);
        assert_eq!(detect_source("https://www.instagram.com/reel/DEF456/"), MediaSource::Instagram);
        assert_eq!(detect_source("https://instagram.com/stories/user/123/"), MediaSource::Instagram);
    }

    #[test]
    fn test_detect_source_tiktok() {
        assert_eq!(detect_source("https://tiktok.com/@user/video/123"), MediaSource::TikTok);
        assert_eq!(detect_source("https://www.tiktok.com/@user/photo/456"), MediaSource::TikTok);
    }

    #[test]
    fn test_detect_source_twitter() {
        assert_eq!(detect_source("https://twitter.com/user/status/123"), MediaSource::Twitter);
        assert_eq!(detect_source("https://x.com/user/status/456"), MediaSource::Twitter);
    }

    #[test]
    fn test_detect_source_mediafire() {
        assert_eq!(detect_source("https://www.mediafire.com/file/abc/file.zip/file"), MediaSource::MediaFire);
    }

    #[test]
    fn test_detect_source_direct() {
        assert_eq!(detect_source("https://cdn.example.com/video.mp4"), MediaSource::Direct);
        assert_eq!(detect_source("https://example.com/file.mp4?token=abc"), MediaSource::Direct);
        assert_eq!(detect_source("https://example.com/image.png"), MediaSource::Direct);
    }

    #[test]
    fn test_detect_source_generic() {
        assert_eq!(detect_source("https://example.com/page"), MediaSource::Generic);
        assert_eq!(detect_source("https://someblog.com/article"), MediaSource::Generic);
    }

    #[test]
    fn test_detect_source_unknown() {
        assert_eq!(detect_source("not-a-url"), MediaSource::Generic);
        assert_eq!(detect_source(""), MediaSource::Generic);
    }

    // ── is_direct_file_url ──────────────────────────────────────────────

    #[test]
    fn test_is_direct_file_url_positive() {
        assert!(is_direct_file_url("https://example.com/video.mp4"));
        assert!(is_direct_file_url("https://example.com/file.mp4?token=abc"));
        assert!(is_direct_file_url("https://example.com/image.png#fragment"));
        assert!(is_direct_file_url("https://cdn.example.com/archive.zip"));
        assert!(is_direct_file_url("HTTP://EXAMPLE.COM/VIDEO.MP4"));
    }

    #[test]
    fn test_is_direct_file_url_negative() {
        assert!(!is_direct_file_url("https://example.com/page"));
        assert!(!is_direct_file_url("https://example.com/video.html"));
        assert!(!is_direct_file_url("not-a-url.mp4"));
        assert!(!is_direct_file_url(""));
        assert!(!is_direct_file_url("ftp://example.com/file.mp4"));
    }

    // ── normalize_url ───────────────────────────────────────────────────

    #[test]
    fn test_normalize_url_youtube_canonical() {
        assert_eq!(
            normalize_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
    }

    #[test]
    fn test_normalize_url_youtube_strips_playlist() {
        assert_eq!(
            normalize_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDMM"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
    }

    #[test]
    fn test_normalize_url_youtube_short() {
        assert_eq!(
            normalize_url("https://youtu.be/dQw4w9WgXcQ"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
    }

    #[test]
    fn test_normalize_url_youtube_shorts() {
        assert_eq!(
            normalize_url("https://www.youtube.com/shorts/abc123"),
            "https://www.youtube.com/watch?v=abc123"
        );
    }

    #[test]
    fn test_normalize_url_instagram() {
        assert_eq!(
            normalize_url("https://www.instagram.com/p/ABC123/?utm_source=ig_web_copy_link"),
            "https://www.instagram.com/p/ABC123"
        );
    }

    #[test]
    fn test_normalize_url_generic() {
        assert_eq!(
            normalize_url("https://example.com/page?query=param"),
            "https://example.com/page"
        );
    }

    #[test]
    fn test_normalize_url_strips_trailing_slash() {
        assert_eq!(
            normalize_url("https://example.com/page/"),
            "https://example.com/page"
        );
    }

    // ── FormatCache ─────────────────────────────────────────────────────

    #[test]
    fn test_format_cache_set_and_get() {
        let cache = FormatCache::new(60);
        cache.set("key1", "value1");
        assert_eq!(cache.get("key1"), Some("value1".to_string()));
    }

    #[test]
    fn test_format_cache_miss() {
        let cache = FormatCache::new(60);
        assert_eq!(cache.get("nonexistent"), None);
    }

    #[test]
    fn test_format_cache_invalidate() {
        let cache = FormatCache::new(60);
        cache.set("key1", "value1");
        cache.invalidate("key1");
        assert_eq!(cache.get("key1"), None);
    }

    #[test]
    fn test_format_cache_clear() {
        let cache = FormatCache::new(60);
        cache.set("key1", "value1");
        cache.set("key2", "value2");
        cache.clear();
        assert_eq!(cache.get("key1"), None);
        assert_eq!(cache.get("key2"), None);
    }

    #[test]
    fn test_format_cache_overwrite() {
        let cache = FormatCache::new(60);
        cache.set("key1", "old");
        cache.set("key1", "new");
        assert_eq!(cache.get("key1"), Some("new".to_string()));
    }

    #[test]
    fn test_format_cache_ttl_expires() {
        let cache = FormatCache::new(0); // 0 second TTL = immediate expiry
        cache.set("key1", "value1");
        std::thread::sleep(std::time::Duration::from_millis(10));
        assert_eq!(cache.get("key1"), None);
    }

    // ── format_bytes ────────────────────────────────────────────────────

    #[test]
    fn test_format_bytes_zero() {
        assert_eq!(format_bytes(0), "0.0 B");
    }

    #[test]
    fn test_format_bytes_bytes() {
        assert_eq!(format_bytes(500), "500.0 B");
    }

    #[test]
    fn test_format_bytes_kilobytes() {
        assert_eq!(format_bytes(2048), "2.0 KB");
    }

    #[test]
    fn test_format_bytes_megabytes() {
        assert_eq!(format_bytes(5_242_880), "5.0 MB");
    }

    #[test]
    fn test_format_bytes_gigabytes() {
        assert_eq!(format_bytes(10_737_418_240), "10.0 GB");
    }

    #[test]
    fn test_format_bytes_boundary() {
        // 1023 bytes should still show as bytes
        assert_eq!(format_bytes(1023), "1023.0 B");
        // 1024 bytes = 1 KB
        assert_eq!(format_bytes(1024), "1.0 KB");
    }
}

