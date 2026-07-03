//! Auto-tune optimal connection count from a short probe.

use crate::discover::supports_ranges;
use reqwest::header::RANGE;
use reqwest::Client;
use std::time::{Duration, Instant};
use futures::StreamExt;

const PROBE_SECONDS: f64 = 2.5;

/// Run a short ranged download probe and suggest thread count.
pub async fn probe_optimal_threads(
    client: &Client,
    url: &str,
    ceiling: usize,
    piece_size: u64,
) -> usize {
    let ceiling = ceiling.max(1);
    if ceiling == 1 {
        return 1;
    }
    if !supports_ranges(client, url).await {
        return 1;
    }

    let mut best_threads = 2usize.min(ceiling);
    let mut best_bps = 0u64;

    for try_threads in [2usize, 4, 8, 12, 16] {
        if try_threads > ceiling {
            break;
        }
        let bps = measure_parallel_throughput(client, url, try_threads, piece_size).await;
        if bps > best_bps {
            if best_bps == 0 || bps > best_bps * 11 / 10 {
                best_bps = bps;
                best_threads = try_threads;
            } else {
                break;
            }
        } else if try_threads >= 4 {
            break;
        }
    }

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
    let mut handles = Vec::new();

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
        // Invalid URL → supports_ranges false → 1
        let client = Client::builder().build().unwrap();
        let n = probe_optimal_threads(&client, "http://127.0.0.1:1/nope", 8, 1024 * 1024).await;
        assert_eq!(n, 1);
    }
}
