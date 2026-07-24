//! Download URL normalization for CDNs that embed byte ranges in the query string.

use url::Url;

/// Query keys that pin the response to a byte slice (YouTube googlevideo, etc.).
/// Leaving them in place makes HEAD/Content-Length report only that slice, so the
/// engine thinks a multi‑hundred‑MB file is e.g. 10 MB and exits "complete" early.
const RANGE_KEYS: &[&str] = &["range"];

/// Strip embedded `range=` (and aliases) while preserving the order of other params.
pub fn strip_embedded_range(url: &str) -> String {
    let Ok(parsed) = Url::parse(url) else {
        return url.to_string();
    };
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(k, _)| !RANGE_KEYS.iter().any(|rk| k.eq_ignore_ascii_case(rk)))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    let had_range = parsed
        .query_pairs()
        .any(|(k, _)| RANGE_KEYS.iter().any(|rk| k.eq_ignore_ascii_case(rk)));
    if !had_range {
        return url.to_string();
    }

    let mut out = parsed;
    if pairs.is_empty() {
        out.set_query(None);
    } else {
        let mut ser = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in &pairs {
            ser.append_pair(k, v);
        }
        out.set_query(Some(&ser.finish()));
    }
    out.to_string()
}

/// YouTube `clen` (and similar) declare the full object size independent of `range=`.
pub fn url_declared_content_length(url: &str) -> Option<u64> {
    let parsed = Url::parse(url).ok()?;
    for (k, v) in parsed.query_pairs() {
        if k.eq_ignore_ascii_case("clen") {
            let n = v.parse::<u64>().ok()?;
            if n > 0 {
                return Some(n);
            }
        }
    }
    None
}

/// Prefer URL-declared size when headers only reflect an embedded range slice.
pub fn resolve_discovered_size(url: &str, header_size: u64) -> u64 {
    match url_declared_content_length(url) {
        Some(clen) if clen > header_size => clen,
        _ => header_size,
    }
}

/// Normalize media URL before discovery / download.
pub fn normalize_download_url(url: &str) -> String {
    strip_embedded_range(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_range_preserves_other_params() {
        let raw = "https://rr1---sn-abc.googlevideo.com/videoplayback?id=1&range=0-9999999&clen=500000000&expire=99";
        let out = strip_embedded_range(raw);
        assert!(!out.contains("range="));
        assert!(out.contains("clen=500000000"));
        assert!(out.contains("expire=99"));
        assert!(out.contains("id=1"));
    }

    #[test]
    fn unchanged_without_range() {
        let raw = "https://example.com/a.mp4?token=abc";
        assert_eq!(strip_embedded_range(raw), raw);
    }

    #[test]
    fn clen_override_when_header_too_small() {
        let raw = "https://x/videoplayback?clen=500000000&range=0-9";
        assert_eq!(resolve_discovered_size(raw, 10), 500_000_000);
        assert_eq!(resolve_discovered_size(raw, 500_000_000), 500_000_000);
    }

    #[test]
    fn no_clen_keeps_header() {
        assert_eq!(
            resolve_discovered_size("https://x/a.mp4", 12345),
            12345
        );
    }
}
