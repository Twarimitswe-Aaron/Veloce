//! Per-piece download with shared positioned writes and buffered reads.

use crate::adaptive::FailureKind;
use crate::discover::retry_after_secs;
use crate::file_io::SharedOutput;
use crate::rate_limit::RateLimiter;
use anyhow::Context;
use futures::StreamExt;
use indicatif::ProgressBar;
use reqwest::header::RANGE;
use reqwest::Client;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::time;

#[cfg(target_os = "linux")]
use crate::io_uring_writer::IoUringEngine;

pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_PIECE_RETRIES: usize = 10;

pub fn failure_kind_from_status(code: u16) -> FailureKind {
    match code {
        403 | 416 => FailureKind::Permanent,
        _ => FailureKind::Transient,
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn download_piece(
    client: &Client,
    url: &str,
    output: &SharedOutput,
    start: u64,
    end: u64,
    expect_partial: bool,
    worker_partial: &AtomicU64,
    bar: &ProgressBar,
    idle_timeout: Duration,
    limiter: &RateLimiter,
    read_buffer_bytes: usize,
    #[cfg(target_os = "linux")] mut uring: Option<&mut IoUringEngine>,
) -> anyhow::Result<()> {
    worker_partial.store(0, Ordering::Relaxed);
    let piece_len = end - start + 1;
    bar.set_length(piece_len);
    bar.set_position(0);

    let res = client
        .get(url)
        .header(RANGE, format!("bytes={}-{}", start, end))
        .send()
        .await?;

    let status = res.status();
    let code = status.as_u16();

    if code == 416 {
        anyhow::bail!("range not satisfiable (416)");
    }

    if code == 429 || code == 503 {
        let wait = retry_after_secs(&res);
        time::sleep(Duration::from_secs(wait)).await;
        anyhow::bail!("server busy ({code})");
    }

    if expect_partial && code == 200 {
        anyhow::bail!("server ignored Range (200 for sub-range)");
    }

    if !status.is_success() {
        anyhow::bail!("bad status {status}");
    }

    let mut stream = res.bytes_stream();
    let mut file_offset = start;
    let mut buf: Vec<u8> = Vec::with_capacity(read_buffer_bytes);

    loop {
        match time::timeout(idle_timeout, stream.next()).await {
            Err(_) => anyhow::bail!("stalled: no data for {:?}", idle_timeout),
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(Some(Ok(bytes))) => {
                let n = bytes.len();
                limiter.acquire(n as u64).await;
                buf.extend_from_slice(&bytes);
                if buf.len() >= read_buffer_bytes {
                    #[cfg(target_os = "linux")]
                    if let Some(engine) = uring.as_mut() {
                        engine.write_at(file_offset, &buf).context("disk write")?;
                    } else {
                        output.write_at(file_offset, &buf).context("disk write")?;
                    }
                    #[cfg(not(target_os = "linux"))]
                    output.write_at(file_offset, &buf).context("disk write")?;
                    file_offset += buf.len() as u64;
                    buf.clear();
                }
                worker_partial.fetch_add(n as u64, Ordering::Relaxed);
                bar.inc(n as u64);
            }
        }
    }

    if !buf.is_empty() {
        #[cfg(target_os = "linux")]
        if let Some(engine) = uring.as_mut() {
            engine.write_at(file_offset, &buf).context("disk write")?;
        } else {
            output.write_at(file_offset, &buf).context("disk write")?;
        }
        #[cfg(not(target_os = "linux"))]
        output.write_at(file_offset, &buf).context("disk write")?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_failure_classification() {
        assert_eq!(failure_kind_from_status(403), FailureKind::Permanent);
        assert_eq!(failure_kind_from_status(503), FailureKind::Transient);
    }
}
