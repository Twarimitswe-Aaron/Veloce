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
    /// New bytes transferred in this (final successful) attempt.
    pub bytes_downloaded: u64,
    /// Bytes already on disk when this attempt started (piece-level resume).
    pub resumed_from: u64,
    pub attempt: u8,
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

pub const IDLE_TIMEOUT: Duration = Duration::from_secs(12);
pub const MAX_PIECE_RETRIES: usize = 10;

pub fn failure_kind_from_status(code: u16) -> FailureKind {
    match code {
        403 | 416 => FailureKind::Permanent,
        _ => FailureKind::Transient,
    }
}

/// CDN returned 200 for a Range sub-request — token expired / ranges disabled.
/// Retrying the same URL is almost always useless (MediaFire, signed CDNs).
pub fn is_range_ignored_error(err: &str) -> bool {
    err.contains("ignored Range") || err.contains("200 for sub-range")
}

pub fn failure_kind_from_error(err: &str) -> FailureKind {
    if err.contains("403") || err.contains("416") || is_range_ignored_error(err) {
        FailureKind::Permanent
    } else {
        FailureKind::Transient
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
    already_done: u64,
    // Bytes already flushed for this piece (survives stall retries).
    piece_written: &AtomicU64,
    worker_partial: &AtomicU64,
    bar: &ProgressBar,
    idle_timeout: Duration,
    limiter: &RateLimiter,
    read_buffer_bytes: usize,
    metrics: Option<&SegQueue<PieceMetrics>>,
    attempt: u8,
    #[cfg(target_os = "linux")] mut uring: Option<&mut IoUringEngine>,
) -> anyhow::Result<()> {
    let piece_len = end - start + 1;
    let already_done = already_done.min(piece_len);
    worker_partial.store(already_done, Ordering::Relaxed);
    piece_written.store(already_done, Ordering::Relaxed);
    bar.set_length(piece_len);
    bar.set_position(already_done);

    if already_done >= piece_len {
        return Ok(());
    }

    let range_start = start + already_done;
    let range_str = format!("bytes={}-{}", range_start, end);
    if already_done > 0 {
        eprintln!(
            "   🧩 Piece [{:.1} MB - {:.1} MB] resume +{:.1} MB ({:.1} MB left)",
            start as f64 / 1_048_576.0,
            end as f64 / 1_048_576.0,
            already_done as f64 / 1_048_576.0,
            (piece_len - already_done) as f64 / 1_048_576.0
        );
    } else {
        eprintln!("   🧩 Piece [{:.1} MB - {:.1} MB] ({:.1} MB)",
            start as f64 / 1_048_576.0,
            end as f64 / 1_048_576.0,
            piece_len as f64 / 1_048_576.0
        );
    }

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
    let mut file_offset = range_start;
    let mut buf: Vec<u8> = Vec::with_capacity(read_buffer_bytes);
    let mut piece_done: u64 = already_done;
    let next_milestone = piece_len / 4; // log at 25%, 50%, 75%
    let mut next_milestone_at = ((already_done / next_milestone.max(1)) + 1) * next_milestone.max(1);
    let mut milestone_printed = false;

    let mut total_net_wait = Duration::default();
    let mut total_limit_wait = Duration::default();
    let mut total_disk_wait = Duration::default();

    loop {
        let t_net = Instant::now();
        match time::timeout(idle_timeout, stream.next()).await {
            Err(_) => anyhow::bail!("stalled: no data for {:?}", idle_timeout),
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(Some(Ok(bytes))) => {
                total_net_wait += t_net.elapsed();
                let _ = t_first_byte.get_or_insert_with(Instant::now);
                let remaining = piece_len.saturating_sub(piece_done);
                if remaining == 0 {
                    break;
                }
                // Cap to piece end so over-long responses cannot corrupt neighbours.
                let take = (bytes.len() as u64).min(remaining) as usize;
                let chunk = &bytes[..take];
                let n = take as u64;
                
                let t_limit = Instant::now();
                limiter.acquire(n).await;
                total_limit_wait += t_limit.elapsed();
                
                buf.extend_from_slice(chunk);

                if buf.len() >= read_buffer_bytes {
                    let wrote = buf.len() as u64;
                    let t_disk = Instant::now();
                    flush_piece_buf(
                        output,
                        file_offset,
                        &mut buf,
                        read_buffer_bytes,
                        #[cfg(target_os = "linux")]
                        &mut uring,
                    )?;
                    total_disk_wait += t_disk.elapsed();
                    file_offset += wrote;
                }

                piece_done += n;
                worker_partial.store(piece_done, Ordering::Relaxed);
                piece_written.store(piece_done, Ordering::Relaxed);
                bar.set_position(piece_done);

                while piece_done >= next_milestone_at && next_milestone > 0 {
                    let pct = (piece_done as f64 / piece_len as f64) * 100.0;
                    if !crate::logutil::is_quiet() {
                        crate::elog!(
                            "   📦 Piece {} progress: {:.0}% ({:.1} MB / {:.1} MB) | net_wait: {:?}, limit_wait: {:?}, disk_wait: {:?}",
                            piece_idx, pct,
                            piece_done as f64 / 1_048_576.0,
                            piece_len as f64 / 1_048_576.0,
                            total_net_wait, total_limit_wait, total_disk_wait
                        );
                    }
                    milestone_printed = true;
                    next_milestone_at += next_milestone;
                }

                if piece_done >= piece_len {
                    break;
                }
            }
        }
    }

    // Clear the in-place progress line so the "✅ Piece complete" lands cleanly.
    if milestone_printed && !crate::logutil::is_quiet() {
        eprintln!();
    }

    if !buf.is_empty() {
        flush_piece_buf(
            output,
            file_offset,
            &mut buf,
            read_buffer_bytes,
            #[cfg(target_os = "linux")]
            &mut uring,
        )?;
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

    let bytes_dl = piece_done.saturating_sub(already_done);
    let xfer_speed = bytes_dl as f64 / 1_048_576.0 / transfer_secs.max(0.001);
    crate::elog!(
        "   ✅ Piece [{:.1} MB - {:.1} MB] complete ({}) — TTFB {:5.2}s — Xfer {:5.2}s — {:5.1} MB/s",
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
            resumed_from: already_done,
            attempt,
            duration_secs,
            ttfb_secs,
            transfer_secs,
        });
    }

    Ok(())
}

fn flush_piece_buf(
    output: &SharedOutput,
    file_offset: u64,
    buf: &mut Vec<u8>,
    read_buffer_bytes: usize,
    #[cfg(target_os = "linux")] uring: &mut Option<&mut IoUringEngine>,
) -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    if let Some(engine) = uring.as_deref_mut() {
        let owned = std::mem::replace(buf, Vec::with_capacity(read_buffer_bytes));
        engine
            .write_at_owned(file_offset, owned)
            .context("disk write")?;
        return Ok(());
    }
    let _ = read_buffer_bytes;
    output.write_at(file_offset, buf).context("disk write")?;
    buf.clear();
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

    #[test]
    fn range_ignored_is_permanent() {
        assert!(is_range_ignored_error(
            "server ignored Range (200 for sub-range)"
        ));
        assert_eq!(
            failure_kind_from_error("server ignored Range (200 for sub-range)"),
            FailureKind::Permanent
        );
    }
}
