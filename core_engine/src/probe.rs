//! Auto-tune optimal connection count from a short probe.
//!
//! Candidates are probed **sequentially with early exit** so time-to-first-byte
//! stays low when 2–4 connections already saturate the link (previously all
//! levels ran at once and hammered the CDN before the real download).

use crate::discover::supports_ranges;
use reqwest::header::RANGE;
use reqwest::Client;
use std::time::{Duration, Instant};
use futures::StreamExt;

const PROBE_SECONDS: f64 = 1.2;

/// Run a short ranged download probe and suggest thread count.
pub async fn probe_optimal_threads(
    client: &Client,
    url: &str,
    ceiling: usize,
    piece_size: u64,
) -> usize {
    let ceiling = ceiling.max(1);
    crate::elog!("   📊 Running auto-tune probe (sequential, early-exit)...");
    if ceiling == 1 {
        crate::elog!("   → Ceiling is 1, using single connection");
        return 1;
    }
    if !supports_ranges(client, url).await {
        crate::elog!("   → No range support, using single connection");
        return 1;
    }

    let candidates: Vec<usize> = [2usize, 4, 8, 12, 16]
        .into_iter()
        .filter(|&t| t <= ceiling)
        .collect();

    crate::elog!("   Testing candidates: {:?} connections", candidates);

    if candidates.len() <= 1 {
        let result = candidates.first().copied().unwrap_or(2).max(1).min(ceiling);
        crate::elog!("   → Only one candidate: {} connection(s)", result);
        return result;
    }

    let mut best_threads = 2usize.min(ceiling);
    let mut best_bps = 0u64;

    for &try_threads in &candidates {
        let bps = measure_parallel_throughput(client, url, try_threads, piece_size).await;
        crate::elog!(
            "   ⏱  {} conn(s): {:.1} MB/s",
            try_threads,
            bps as f64 / 1_048_576.0
        );

        if bps > best_bps {
            if best_bps == 0 || bps > best_bps * 11 / 10 {
                best_bps = bps;
                best_threads = try_threads;
            } else {
                crate::elog!(
                    "   → Diminishing returns at {} connections (≤10% improvement)",
                    try_threads
                );
                break;
            }
        } else if try_threads >= 4 {
            crate::elog!(
                "   → Performance dropped at {} connections",
                try_threads
            );
            break;
        }
    }

    crate::elog!(
        "   ✓ Selected: {} connection(s) at {:.1} MB/s",
        best_threads,
        best_bps as f64 / 1_048_576.0
    );
    best_threads.max(1).min(ceiling)
}

async fn measure_parallel_throughput(
    client: &Client,
    url: &str,
    threads: usize,
    piece_size: u64,
) -> u64 {
    let chunk = std::cmp::min(piece_size, 512 * 1024).max(64 * 1024);
    let start = Instant::now();
    let mut handles = Vec::with_capacity(threads);

    for i in 0..threads {
        let client = client.clone();
        let url = url.to_string();
        let offset = (i as u64) * chunk;
        handles.push(tokio::spawn(async move {
            let end = offset + chunk - 1;
            let res = client
                .get(&url)
                .header(RANGE, format!("bytes={}-{}", offset, end))
                .send()
                .await?;
            let mut bytes = 0u64;
            let mut stream = res.bytes_stream();
            while let Some(item) = stream.next().await {
                bytes += item?.len() as u64;
            }
            Ok::<u64, anyhow::Error>(bytes)
        }));
    }

    let deadline = Duration::from_secs_f64(PROBE_SECONDS);
    let mut total = 0u64;
    while start.elapsed() < deadline {
        let mut done = true;
        for h in &handles {
            if !h.is_finished() {
                done = false;
            }
        }
        if done {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    for h in handles {
        if h.is_finished() {
            if let Ok(Ok(n)) = h.await {
                total += n;
            }
        } else {
            h.abort();
        }
    }

    let secs = start.elapsed().as_secs_f64().max(0.1);
    (total as f64 / secs) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn probe_returns_one_without_ranges() {
        let client = Client::builder()
            .redirect(crate::safety::safe_redirect_policy())
            .build()
            .unwrap();
        let n = probe_optimal_threads(&client, "http://127.0.0.1:1/nope", 8, 1024 * 1024).await;
        assert_eq!(n, 1);
    }
}
