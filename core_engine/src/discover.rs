//! Size discovery, range probing, and connection warmup.

use anyhow::Context;
use reqwest::header::{
    ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, ETAG, LAST_MODIFIED, RANGE, RETRY_AFTER,
};
use reqwest::Client;
use std::time::Instant;
use tokio::time::Duration;

#[derive(Debug, Clone)]
pub struct Discovery {
    pub total_size: u64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub ranges_hint: Option<bool>,
    /// Warmed TCP+TLS connection reused for first worker when available.
    pub warmed_client: Client,
}

pub fn build_http_client(threads: usize, referer: Option<&str>, origin: Option<&str>) -> anyhow::Result<Client> {
    let mut client_builder = Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .tcp_keepalive(Duration::from_secs(30))
        .tcp_nodelay(true)
        .no_gzip()
        .http2_keep_alive_interval(Some(Duration::from_secs(30)))
        .http2_keep_alive_timeout(Duration::from_secs(5))
        .pool_max_idle_per_host(threads.max(1))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        // Block redirects into private/loopback/metadata — coordinator SSRF defense
        // is not enough once Location headers are followed inside the engine.
        .redirect(crate::safety::safe_redirect_policy());

    let mut default_headers = reqwest::header::HeaderMap::new();
    if let Some(r) = referer {
        if let Ok(val) = r.parse() {
            default_headers.insert(reqwest::header::REFERER, val);
        }
    }
    if let Some(o) = origin {
        if let Ok(val) = o.parse() {
            default_headers.insert(reqwest::header::ORIGIN, val);
        }
    }
    if !default_headers.is_empty() {
        client_builder = client_builder.default_headers(default_headers);
    }
    Ok(client_builder.build()?)
}

fn header_string(headers: &reqwest::header::HeaderMap, key: reqwest::header::HeaderName) -> Option<String> {
    headers.get(key).and_then(|v| v.to_str().ok()).map(|s| s.to_string())
}

fn parse_content_length(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|s| *s > 0)
}

fn parse_total_from_content_range(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let v = headers.get(CONTENT_RANGE)?.to_str().ok()?;
    let total_part = v.rsplit('/').next()?.trim();
    if total_part == "*" {
        return None;
    }
    total_part.parse::<u64>().ok().filter(|s| *s > 0)
}

/// Probe whether the server honors HTTP range requests.
pub async fn supports_ranges(client: &Client, url: &str) -> bool {
    match client.get(url).header(RANGE, "bytes=0-0").send().await {
        Ok(res) => {
            if res.status().as_u16() == 206 {
                return true;
            }
            res.headers()
                .get(ACCEPT_RANGES)
                .and_then(|v| v.to_str().ok())
                .map(|v| v.eq_ignore_ascii_case("bytes"))
                .unwrap_or(false)
        }
        Err(_) => false,
    }
}

/// Fast path for resume: one ranged GET (often faster than HEAD on CDNs).
/// Returns Ok when size matches `expected_size`.
pub async fn discover_resume_quick(
    client: &Client,
    url: &str,
    expected_size: u64,
) -> anyhow::Result<Discovery> {
    let t0 = Instant::now();
    let res = client
        .get(url)
        .header(RANGE, "bytes=0-0")
        .send()
        .await
        .context("resume quick ranged GET failed")?;
    let status = res.status().as_u16();
    let etag = header_string(res.headers(), ETAG);
    let lm = header_string(res.headers(), LAST_MODIFIED);
    if status == 206 {
        if let Some(total) = parse_total_from_content_range(res.headers()) {
            if total == expected_size {
                eprintln!(
                    "   ✓ Resume quick-probe OK in {:.2}s ({} bytes)",
                    t0.elapsed().as_secs_f64(),
                    total
                );
                return Ok(Discovery {
                    total_size: total,
                    etag,
                    last_modified: lm,
                    ranges_hint: Some(true),
                    warmed_client: client.clone(),
                });
            }
            anyhow::bail!(
                "resume size mismatch: got {} expected {}",
                total,
                expected_size
            );
        }
    }
    anyhow::bail!("resume quick-probe got HTTP {status}, need 206")
}

/// Discover size + validators. Retries transient connect/timeout failures.
pub async fn discover(client: &Client, url: &str) -> anyhow::Result<Discovery> {
    let mut last_err = None;
    for attempt in 1..=3u32 {
        match discover_once(client, url).await {
            Ok(d) => return Ok(d),
            Err(e) => {
                let msg = e.to_string();
                let retryable = msg.contains("timed out")
                    || msg.contains("timeout")
                    || msg.contains("connection")
                    || msg.contains("Connect")
                    || msg.contains("reset")
                    || msg.contains("temporarily");
                eprintln!(
                    "   ⚠️  Discovery attempt {attempt}/3 failed: {msg}"
                );
                last_err = Some(e);
                if !retryable || attempt == 3 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("discovery failed")))
}

async fn discover_once(client: &Client, url: &str) -> anyhow::Result<Discovery> {
    let _warmup_start = Instant::now();

    eprintln!(" 🔍 Discovering file metadata...");

    if let Ok(head) = client.head(url).send().await {
        if head.status().is_success() {
            if let Some(len) = parse_content_length(head.headers()) {
                let etag = header_string(head.headers(), ETAG);
                let lm = header_string(head.headers(), LAST_MODIFIED);
                let ar = head
                    .headers()
                    .get(ACCEPT_RANGES)
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v.eq_ignore_ascii_case("bytes"));
                eprintln!("   ✓ HEAD request succeeded");
                eprintln!("   📦 Size:       {} bytes ({:.1} MB)", len, len as f64 / 1_048_576.0);
                if let Some(ref e) = etag {
                    eprintln!("   🏷️  ETag:       {}", e);
                }
                if let Some(ref l) = lm {
                    eprintln!("   📅 Modified:   {}", l);
                }
                eprintln!("   📐 Ranges:     {}", ar.map(|v| if v { "supported" } else { "unsupported" }).unwrap_or("unknown"));
                return Ok(Discovery {
                    total_size: len,
                    etag,
                    last_modified: lm,
                    ranges_hint: ar,
                    warmed_client: client.clone(),
                });
            }
        }
    }

    eprintln!("   ⚠️  HEAD failed or no content-length — trying ranged GET");

    let res = client
        .get(url)
        .header(RANGE, "bytes=0-0")
        .send()
        .await
        .context("discovery GET failed")?;
    let status = res.status();
    let etag = header_string(res.headers(), ETAG);
    let lm = header_string(res.headers(), LAST_MODIFIED);

    eprintln!("   ℹ️  Ranged GET response: {} {}", status.as_u16(), status.canonical_reason().unwrap_or(""));

    if status.as_u16() == 206 {
        if let Some(total) = parse_total_from_content_range(res.headers()) {
            eprintln!("   ✓ Server supports ranges (206 Partial Content)");
            eprintln!("   📦 Size:       {} bytes ({:.1} MB)", total, total as f64 / 1_048_576.0);
            if let Some(ref e) = etag {
                eprintln!("   🏷️  ETag:       {}", e);
            }
            if let Some(ref l) = lm {
                eprintln!("   📅 Modified:   {}", l);
            }
            return Ok(Discovery {
                total_size: total,
                etag,
                last_modified: lm,
                ranges_hint: Some(true),
                warmed_client: client.clone(),
            });
        }
        eprintln!("   ⚠️  206 response without Content-Range total — falling back to full GET");
    }

    // Some hosts (e.g. GitHub HTML) answer ranges with `bytes 0-0/*` — try a full GET.
    eprintln!("   📥 Performing full GET to determine file size...");
    let full = client.get(url).send().await.context("discovery full GET failed")?;
    let full_status = full.status();
    let full_etag = header_string(full.headers(), ETAG).or_else(|| etag.clone());
    let full_lm = header_string(full.headers(), LAST_MODIFIED).or_else(|| lm.clone());

    eprintln!("   ℹ️  Full GET response: {} {}", full_status.as_u16(), full_status.canonical_reason().unwrap_or(""));

    if full_status.is_success() {
        if let Some(len) = parse_content_length(full.headers()) {
            eprintln!("   ✓ File size determined from full GET");
            eprintln!("   📦 Size:       {} bytes ({:.1} MB)", len, len as f64 / 1_048_576.0);
            if let Some(ref e) = full_etag {
                eprintln!("   🏷️  ETag:       {}", e);
            }
            if let Some(ref l) = full_lm {
                eprintln!("   📅 Modified:   {}", l);
            }
            let ranges_ok = status.as_u16() == 206;
            eprintln!("   📐 Ranges:     {}", if ranges_ok { "supported (from earlier probe)" } else { "unsupported" });
            return Ok(Discovery {
                total_size: len,
                etag: full_etag,
                last_modified: full_lm,
                ranges_hint: Some(ranges_ok),
                warmed_client: client.clone(),
            });
        }
    }

    anyhow::bail!(
        "Could not discover file size (HTTP {})",
        full_status.as_u16()
    )
}

pub fn retry_after_secs(res: &reqwest::Response) -> u64 {
    res.headers()
        .get(RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(2)
        .min(10)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_content_range_total() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            CONTENT_RANGE,
            reqwest::header::HeaderValue::from_static("bytes 0-0/12345"),
        );
        assert_eq!(parse_total_from_content_range(&headers), Some(12345));
    }

    #[test]
    fn parse_content_range_unknown_total() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            CONTENT_RANGE,
            reqwest::header::HeaderValue::from_static("bytes 0-0/*"),
        );
        assert_eq!(parse_total_from_content_range(&headers), None);
    }
}
