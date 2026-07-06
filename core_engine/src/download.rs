//! Per-piece download with shared positioned writes and buffered reads.

use crate::adaptive::FailureKind;
use crate::discover::retry_after_secs;
use crate::file_io::SharedOutput;
use crate::rate_limit::RateLimiter;
use anyhow::Context;
use crossbeam_queue::SegQueue;
use futures::StreamExt;
use indicatif::ProgressBar;
use reqwest::header::RANGE;
use reqwest::Client;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::time;

#[cfg(target_os = "linux")]
use crate::io_uring_writer::IoUringEngine;

/// Per-piece metrics collected at download completion.
#[derive(Clone, Debug)]
pub struct PieceMetrics {
    pub piece_idx: usize,
    pub worker: usize,
    pub start_byte: u64,
    pub end_byte: u64,
    pub bytes_downloaded: u64,
    pub duration_secs: f64,
    /// Time from request start to first body byte (includes any DNS, TCP, TLS, and server processing).
    pub ttfb_secs: f64,
    /// Time from first body byte to last body byte (actual data transfer).
    pub transfer_secs: f64,
}

impl PieceMetrics {
    pub fn size(&self) -> u64 {
        self.end_byte - self.start_byte + 1
    }
    /// Transfer speed based on actual data transfer time (excluding TTFB overhead).
    pub fn speed_mbps(&self) -> f64 {
        let t = if self.transfer_secs > 0.001 {
            self.transfer_secs
        } else {
            self.duration_secs.max(0.001)
        };
        self.bytes_downloaded as f64 / 1_048_576.0 / t
    }
}

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
    piece_idx: usize,
    worker_id: usize,
    worker_partial: &AtomicU64,
    bar: &ProgressBar,
    idle_timeout: Duration,
    limiter: &RateLimiter,
    read_buffer_bytes: usize,
    metrics: Option<&SegQueue<PieceMetrics>>,
    #[cfg(target_os = "linux")] mut uring: Option<&mut IoUringEngine>,
) -> anyhow::Result<()> {
    worker_partial.store(0, Ordering::Relaxed);
    let piece_len = end - start + 1;
    bar.set_length(piece_len);
    bar.set_position(0);

    let range_str = format!("bytes={}-{}", start, end);
    eprintln!("   🧩 Piece [{:.1} MB - {:.1} MB] ({:.1} MB)",
        start as f64 / 1_048_576.0,
        end as f64 / 1_048_576.0,
        piece_len as f64 / 1_048_576.0
    );

    let t_req = Instant::now();
    let res = client
        .get(url)
        .header(RANGE, &range_str)
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
    let mut t_first_byte: Option<Instant> = None;
    let mut file_offset = start;
    let mut buf: Vec<u8> = Vec::with_capacity(read_buffer_bytes);
    let mut piece_done: u64 = 0;
    let next_milestone = piece_len / 4; // log at 25%, 50%, 75%
    let mut next_milestone_at = next_milestone;
    let mut milestone_printed = false;

    loop {
        match time::timeout(idle_timeout, stream.next()).await {
            Err(_) => anyhow::bail!("stalled: no data for {:?}", idle_timeout),
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(Some(Ok(bytes))) => {
                let _ = t_first_byte.get_or_insert_with(Instant::now);
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
                piece_done += n as u64;
                bar.inc(n as u64);

                // Milestone progress — in-place update (no newline)
                while piece_done >= next_milestone_at && next_milestone > 0 {
                    let pct = (piece_done as f64 / piece_len as f64) * 100.0;
                    eprint!("   \r📦 Chunk progress: {:.0}% ({:.1} MB / {:.1} MB)  ",
                        pct,
                        piece_done as f64 / 1_048_576.0,
                        piece_len as f64 / 1_048_576.0
                    );
                    milestone_printed = true;
                    next_milestone_at += next_milestone;
                }
            }
        }
    }

    // Clear the in-place progress line so the "✅ Piece complete" lands cleanly.
    if milestone_printed {
        eprintln!("");
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

    // Flush any remaining batched writes to ensure all data is visible
    // to the kernel page cache before we report the piece as complete.
    #[cfg(target_os = "linux")]
    if let Some(engine) = uring.as_mut() {
        engine.flush()?;
    }

    let t_done = Instant::now();
    let duration_secs = (t_done - t_req).as_secs_f64();
    let ttfb_secs = t_first_byte
        .map(|t| (t - t_req).as_secs_f64())
        .unwrap_or(duration_secs);
    let transfer_secs = duration_secs - ttfb_secs;

    let bytes_dl = piece_done;
    let xfer_speed = bytes_dl as f64 / 1_048_576.0 / transfer_secs.max(0.001);
    eprintln!("   ✅ Piece [{:.1} MB - {:.1} MB] complete ({}) — TTFB {:5.2}s — Xfer {:5.2}s — {:5.1} MB/s",
        start as f64 / 1_048_576.0,
        end as f64 / 1_048_576.0,
        format_bytes(piece_len),
        ttfb_secs,
        transfer_secs,
        xfer_speed
    );

    // Update the connection bar with timing info for live overlay
    bar.set_message(format!("#{} T{:.2}s+X{:.2}s", piece_idx, ttfb_secs, transfer_secs));

    if let Some(q) = metrics {
        q.push(PieceMetrics {
            piece_idx,
            worker: worker_id,
            start_byte: start,
            end_byte: end,
            bytes_downloaded: bytes_dl,
            duration_secs,
            ttfb_secs,
            transfer_secs,
        });
    }

    Ok(())
}

pub fn format_bytes(bytes: u64) -> String {
    if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
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
