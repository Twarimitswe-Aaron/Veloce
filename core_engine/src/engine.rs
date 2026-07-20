//! Download orchestration — workers, progress, resume persistence.

#[cfg(target_os = "linux")]
use crate::io_uring_writer::IoUringEngine;

use crate::adaptive::{AdaptiveController, FailureKind};
use crate::args::EngineArgs;
use crate::discover::{build_http_client, discover, discover_resume_quick, supports_ranges};
use crate::download::{download_piece, format_bytes, PieceMetrics, IDLE_TIMEOUT, MAX_PIECE_RETRIES};
use crate::file_io::{available_space, SharedOutput};
use crate::piece::{adaptive_piece_size, piece_ranges};
use crate::profiles::ProfileStore;
use crate::probe::probe_optimal_threads;
use crate::rate_limit::RateLimiter;
use crate::resume::{
    ensure_sidecar_dir, resolve_done_path, resolve_state_path, validators_match, ResumeState,
};
use crossbeam_queue::SegQueue;
use indicatif::{MultiProgress, ProgressBar, ProgressDrawTarget, ProgressStyle};
use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Notify;
use tokio::time::{sleep, Duration};

const SAFETY_MARGIN: u64 = 32 * 1024 * 1024;
const RESUME_INTERVAL_MS: u64 = 2000;
/// Stagger first requests so CDN rate-limits don't trip; keep short so TTFB stays low.
const STAGGER_MS: u64 = 25;

pub async fn run_download(args: EngineArgs) -> Result<(), Box<dyn std::error::Error>> {
    let args = args.normalize();
    crate::logutil::set_quiet(args.quiet);

    // SSRF guard on the initial URL (redirects also checked in the HTTP client).
    crate::safety::is_safe_download_url(&args.url).map_err(|e| e)?;

    let resolved_save = crate::safety::resolve_save_path(args.base_dir.as_deref(), &args.save_path)
        .map_err(|e| e)?;
    let mut args = args;
    args.save_path = resolved_save.to_string_lossy().to_string();

    let start_time = Instant::now();
    let path = Path::new(&args.save_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    crate::elog!("");
    crate::elog!("━━━ [1/5] Initializing ───────────────────────────── +0.00s");

    let profiles = ProfileStore::load(args.profiles_path.as_deref().map(Path::new));
    let thread_ceiling = profiles.thread_ceiling(&args.url, args.threads) as usize;
    crate::elog!(
        "   📋 Thread ceiling: {} (from {})",
        thread_ceiling,
        if args.profiles_path.is_some() {
            "host profile"
        } else {
            "args"
        }
    );

    let client = Arc::new(build_http_client(
        thread_ceiling,
        args.referer.as_deref(),
        args.origin.as_deref(),
    )?);
    crate::elog!(
        "   🌐 HTTP client ready (pool: {}, referer: {})",
        thread_ceiling,
        args.referer.as_deref().unwrap_or("none")
    );
    let t_init = start_time.elapsed();

    crate::elog!("");
    crate::elog!(
        "━━━ [2/5] Discovering file ───────────────────────── +{}.{:02}s",
        t_init.as_secs(),
        t_init.subsec_millis() / 10
    );

    // Peek resume state before discovery — prefer a fast ranged probe over HEAD.
    let state_path_buf = resolve_state_path(path);
    let _ = ensure_sidecar_dir(path);
    let peeked_resume = if path.exists() && state_path_buf.exists() {
        ResumeState::load(&state_path_buf).filter(|s| s.total_size > 0 && s.piece_size > 0)
    } else {
        None
    };

    let discovery = if let Some(ref peeked) = peeked_resume {
        match discover_resume_quick(&client, &args.url, peeked.total_size).await {
            Ok(d) => d,
            Err(e) => {
                crate::elog!("   ⚠️  Resume quick-probe failed ({e}); full discovery…");
                discover(&client, &args.url).await?
            }
        }
    } else {
        discover(&client, &args.url).await?
    };
    let total_size = discovery.total_size;
    if total_size == 0 {
        return Err("Discovered file size is zero".into());
    }
    if total_size > crate::safety::MAX_FILE_BYTES {
        return Err(format!(
            "File too large ({} bytes > {} byte limit)",
            total_size,
            crate::safety::MAX_FILE_BYTES
        )
        .into());
    }
    crate::elog!(
        "   ✅ Discovery complete: {} bytes ({:.1} MB)",
        total_size,
        total_size as f64 / 1_048_576.0
    );
    let t_discover = start_time.elapsed();

    // Resume / done markers live in `{parent}/.veloce/` (hidden), not beside the media file.
    let sidecar = resolve_done_path(path);
    if sidecar.exists() {
        // Integrity: sidecar alone is not enough — file must exist and match size.
        let complete = path.exists()
            && std::fs::metadata(path)
                .map(|m| m.len() == total_size)
                .unwrap_or(false);
        if complete {
            crate::elog!("   ✅ Already complete (sidecar + matching size).");
            println!(
                "{}",
                json!({
                    "type": "already_exists",
                    "downloaded": total_size,
                    "total": total_size,
                    "elapsed_secs": 0
                })
            );
            return Ok(());
        }
        crate::elog!("   ⚠️  Stale sidecar — file missing or size mismatch; re-downloading");
        let _ = std::fs::remove_file(&sidecar);
    }

    let state_path = state_path_buf.as_path();

    let resume_state: Option<ResumeState> = peeked_resume.filter(|s| {
        s.total_size == total_size
            && s.piece_size > 0
            && s.completed.len() == piece_ranges(total_size, s.piece_size).len()
            && validators_match(s, &discovery.etag, &discovery.last_modified)
    });

    eprintln!("");
    eprintln!("━━━ [3/5] Preparing download ──────────────────── +{}.{:02}s",
        t_discover.as_secs(), t_discover.subsec_millis() / 10
    );

    let ranges_ok = thread_ceiling > 1
        && match discovery.ranges_hint {
            Some(v) => v,
            None => supports_ranges(&client, &args.url).await,
        };

    let piece_size: u64;
    let completed_init: Vec<bool>;
    let output: SharedOutput;

    if let Some(state) = resume_state {
        piece_size = state.piece_size;
        completed_init = state.completed;
        output = SharedOutput::open_existing(path)?;
        let done = completed_init.iter().filter(|c| **c).count();
        eprintln!("   🔄 Resume state found: {}/{} pieces already complete ({:.1}%)",
            done, completed_init.len(),
            (done as f64 / completed_init.len() as f64) * 100.0
        );
        eprintln!("   📐 Piece size: {} bytes ({:.1} MB)", piece_size, piece_size as f64 / 1_048_576.0);
    } else {
        eprintln!("   🆕 Fresh download — no resume state found");
        let keep_partial = if path.exists() {
            let existing = std::fs::metadata(path)?.len();
            if existing > total_size {
                eprintln!(
                    "   ⚠️  Partial file larger than remote ({} > {}) — removing",
                    existing, total_size
                );
                std::fs::remove_file(path)?;
                false
            } else if existing > 0 {
                eprintln!(
                    "   ⚠️  Partial file without valid state: {} / {} bytes — keeping file, re-fetching pieces",
                    existing, total_size
                );
                true
            } else {
                false
            }
        } else {
            false
        };
        let _ = std::fs::remove_file(state_path);

        eprintln!("   📐 Range requests: {}", if ranges_ok { "supported ✓" } else { "NOT supported — single connection only" });

        let profile_piece = profiles.piece_bytes(&args.url);
        piece_size = if args.piece_size_bytes > 0 {
            crate::elog!("   📐 Piece size: {} B (from args)", args.piece_size_bytes);
            args.piece_size_bytes
        } else if ranges_ok {
            let ps = adaptive_piece_size(total_size, profile_piece);
            crate::elog!("   📐 Piece size: {} B ({:.1} MB) (adaptive)", ps, ps as f64 / 1_048_576.0);
            ps
        } else {
            crate::elog!("   📐 Piece size: {} B (entire file — no ranges)", total_size);
            total_size.max(1)
        };
        crate::safety::validate_discovery_size(total_size, piece_size).map_err(|e| e)?;

        if let Some(avail) = available_space(path) {
            eprintln!("   💾 Free space: {} MB", avail as f64 / 1_048_576.0);
            if avail < total_size.saturating_add(SAFETY_MARGIN) {
                println!(
                    "{}",
                    json!({
                        "type": "fatal",
                        "error": format!(
                            "Insufficient disk space: need {:.1} MB, only {:.1} MB free.",
                            total_size as f64 / 1048576.0,
                            avail as f64 / 1048576.0
                        )
                    })
                );
                std::process::exit(1);
            }
        }

        if keep_partial {
            output = SharedOutput::open_existing(path)?;
            let existing = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            if existing < total_size {
                let t_alloc = Instant::now();
                eprintln!(
                    "   💾 Reserving file size {} ({:.1} MB)…",
                    total_size,
                    total_size as f64 / 1_048_576.0
                );
                output.preallocate(total_size)?;
                eprintln!(
                    "   💾 Size reserved in {:.2}s (sparse)",
                    t_alloc.elapsed().as_secs_f64()
                );
            }
            eprintln!("   💾 Resuming into existing partial file");
        } else {
            output = SharedOutput::create_or_open(path, true)?;
            let t_alloc = Instant::now();
            eprintln!(
                "   💾 Reserving file size {} ({:.1} MB)…",
                total_size,
                total_size as f64 / 1_048_576.0
            );
            output.preallocate(total_size)?;
            eprintln!(
                "   💾 Size reserved in {:.2}s (sparse) — ready to download",
                t_alloc.elapsed().as_secs_f64()
            );
        }
        completed_init = vec![false; piece_ranges(total_size, piece_size).len()];
    }

    let pieces: Arc<Vec<(u64, u64)>> = Arc::new(piece_ranges(total_size, piece_size));
    let num_pieces = pieces.len();
    eprintln!("   🧩 Pieces:     {} total ({} bytes each)", num_pieces, piece_size);

    let mut effective_ceiling = std::cmp::min(thread_ceiling.max(1), pieces.len().max(1));
    let auto_tune = args.auto_tune && !args.no_auto_tune;
    if auto_tune && effective_ceiling > 1 && pieces.len() > 1 {
        let tuned = probe_optimal_threads(&client, &args.url, effective_ceiling, piece_size).await;
        eprintln!("   📊 Auto-tune selected {tuned} connections (ceiling {effective_ceiling}).");
        effective_ceiling = tuned.max(1).min(effective_ceiling);
    } else if !auto_tune {
        eprintln!("   ⏭  Auto-tune disabled, using {} connection(s)", effective_ceiling);
    } else if pieces.len() <= 1 {
        eprintln!("   ⏭  Only 1 piece, using 1 connection");
    }

    let piece_metrics: Arc<SegQueue<PieceMetrics>> = Arc::new(SegQueue::new());
    let adaptive = Arc::new(AdaptiveController::new(effective_ceiling));
    let queue: Arc<SegQueue<usize>> = Arc::new(SegQueue::new());
    let notify = Arc::new(Notify::new());
    let slot_notify = Arc::new(Notify::new());
    let completed: Arc<Vec<AtomicBool>> = Arc::new(
        completed_init
            .iter()
            .map(|c| AtomicBool::new(*c))
            .collect(),
    );
    let attempts: Arc<Vec<AtomicU8>> = Arc::new((0..pieces.len()).map(|_| AtomicU8::new(0)).collect());

    let mut baseline_bytes = 0u64;
    let mut remaining_count = 0usize;
    for i in 0..pieces.len() {
        let (start, end) = pieces[i];
        if completed_init[i] {
            baseline_bytes += end - start + 1;
        } else {
            queue.push(i);
            remaining_count += 1;
        }
    }

    let completed_bytes = Arc::new(AtomicU64::new(baseline_bytes));
    let remaining = Arc::new(AtomicUsize::new(remaining_count));
    let completed_count = Arc::new(AtomicU64::new((pieces.len() - remaining_count) as u64));
    let had_failure = Arc::new(AtomicBool::new(false));
    let failed_count = Arc::new(AtomicU64::new(0));
    let retry_count = Arc::new(AtomicU64::new(0));
    let stall_count = Arc::new(AtomicU64::new(0));
    let busy_count = Arc::new(AtomicU64::new(0)); // 429/503
    let peak_speed_bps = Arc::new(AtomicU64::new(0));
    let worker_partial: Arc<Vec<AtomicU64>> =
        Arc::new((0..effective_ceiling).map(|_| AtomicU64::new(0)).collect());
    // Survives stall retries so we don't re-fetch already-written piece bytes.
    let piece_written: Arc<Vec<AtomicU64>> =
        Arc::new((0..pieces.len()).map(|_| AtomicU64::new(0)).collect());
    let limiter = Arc::new(RateLimiter::new(args.max_rate));
    let output = Arc::new(output);

    println!(
        "{}",
        json!({
            "type": "info",
            "threads": effective_ceiling,
            "chunk_size_bytes": piece_size,
            "total_size_bytes": total_size,
            "pieces": pieces.len(),
            "auto_tune": auto_tune,
        })
    );

    let t_prep = start_time.elapsed();

    eprintln!("");
    eprintln!("━━━ [4/5] Downloading ──────────────────────────── +{}.{:02}s",
        t_prep.as_secs(), t_prep.subsec_millis() / 10
    );
    if !ranges_ok && thread_ceiling > 1 {
        eprintln!("   ⚠️  Single connection — no parallel download (server does not support range requests)");
    }
    eprintln!("   🚀 Starting {} worker(s) for {} piece(s)", effective_ceiling, num_pieces);
    eprintln!("   📊 Progress: ████████████████████████████████████ 0%");

    let mp = Arc::new(if args.quiet {
        MultiProgress::with_draw_target(ProgressDrawTarget::hidden())
    } else {
        MultiProgress::new()
    });
    let header_style = ProgressStyle::with_template(
        "{spinner:.cyan} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {bytes}/{total_bytes} | {binary_bytes_per_sec} | ETA {eta} {msg}",
    )
    .unwrap()
    .progress_chars("█▇▆▅▄▃▂▁░");
    let conn_style = ProgressStyle::with_template(
        " C{prefix:>2} [{bar:16.green/black}] {percent:>3}% {bytes:>8}/{total_bytes} {msg}",
    )
    .unwrap()
    .progress_chars("█░░");

    let header_bar = mp.add(ProgressBar::new(total_size));
    header_bar.set_style(header_style);
    header_bar.set_position(baseline_bytes);

    let conn_bars: Arc<Vec<ProgressBar>> = Arc::new(
        (0..effective_ceiling)
            .map(|w| {
                let b = mp.add(ProgressBar::new(piece_size));
                b.set_style(conn_style.clone());
                b.set_prefix(format!("{w}"));
                b
            })
            .collect(),
    );

    let read_buf = args.read_buffer_bytes.max(64 * 1024);
    let mut handles = vec![];

    for w in 0..effective_ceiling {
        let piece_metrics = Arc::clone(&piece_metrics);
        let client = Arc::clone(&client);
        let url = args.url.clone();
        let output = Arc::clone(&output);
        let queue = Arc::clone(&queue);
        let pieces = Arc::clone(&pieces);
        let completed = Arc::clone(&completed);
        let attempts = Arc::clone(&attempts);
        let remaining = Arc::clone(&remaining);
        let completed_bytes = Arc::clone(&completed_bytes);
        let completed_count = Arc::clone(&completed_count);
        let adaptive = Arc::clone(&adaptive);
        let had_failure = Arc::clone(&had_failure);
        let failed_count = Arc::clone(&failed_count);
        let retry_count = Arc::clone(&retry_count);
        let stall_count = Arc::clone(&stall_count);
        let busy_count = Arc::clone(&busy_count);
        let worker_partial = Arc::clone(&worker_partial);
        let piece_written = Arc::clone(&piece_written);
        let conn_bars = Arc::clone(&conn_bars);
        let limiter = Arc::clone(&limiter);
        let notify = Arc::clone(&notify);
        let slot_notify = Arc::clone(&slot_notify);
        let stagger = !args.no_stagger;

        handles.push(tokio::spawn(async move {
            if stagger {
                sleep(Duration::from_millis(STAGGER_MS * w as u64)).await;
            }

            // Each worker gets its own io_uring engine so writes
            // to disjoint file offsets are never serialised.
            // Created once per worker, reused for every piece.
            #[cfg(target_os = "linux")]
            let mut uring = IoUringEngine::try_new(&output.inner, 64)
                .ok()
                .flatten();

            loop {
                let idx = match queue.pop() {
                    Some(i) => i,
                    None => {
                        if remaining.load(Ordering::Acquire) == 0 {
                            break;
                        }
                        // Zero-wait blocking: notify_one() from re-pushed pieces
                        // wakes us immediately. 1s safety timeout prevents deadlock
                        // if remaining hits 0 between our check and the .notified() call.
                        tokio::select! {
                            _ = notify.notified() => {},
                            _ = sleep(Duration::from_millis(1000)) => {},
                        }
                        continue;
                    }
                };

                while !adaptive.try_acquire_slot() {
                    tokio::select! {
                        _ = slot_notify.notified() => {},
                        _ = sleep(Duration::from_millis(1000)) => {},
                    }
                }

                let (start, end) = pieces[idx];
                let piece_len = end - start + 1;
                let bar = &conn_bars[w];
                bar.set_message(""); // clear timing from previous piece
                let expect_partial = piece_len < total_size;

                let already = piece_written[idx].load(Ordering::Relaxed);
                let attempt_n = attempts[idx].load(Ordering::Relaxed).saturating_add(1);
                let res = download_piece(
                    &client,
                    &url,
                    &output,
                    start,
                    end,
                    expect_partial,
                    idx,
                    w,
                    already,
                    &piece_written[idx],
                    &worker_partial[w],
                    bar,
                    IDLE_TIMEOUT,
                    &limiter,
                    read_buf,
                    Some(&piece_metrics),
                    attempt_n,
                    #[cfg(target_os = "linux")]
                    uring.as_mut(),
                )
                .await;

                adaptive.release_slot();
                slot_notify.notify_one();

                let written = piece_written[idx].load(Ordering::Relaxed);
                let full = res.is_ok() && written == piece_len;
                worker_partial[w].store(0, Ordering::Relaxed);

                if full {
                    completed[idx].store(true, Ordering::Relaxed);
                    // Move bytes from in-piece progress into completed_bytes.
                    piece_written[idx].store(0, Ordering::Relaxed);
                    completed_bytes.fetch_add(piece_len, Ordering::Relaxed);
                    if remaining.fetch_sub(1, Ordering::Release) == 1 {
                        notify.notify_waiters();
                    }
                    completed_count.fetch_add(1, Ordering::Relaxed);
                    adaptive.on_success();
                } else {
                    let n = attempts[idx].fetch_add(1, Ordering::Relaxed) as usize + 1;
                    retry_count.fetch_add(1, Ordering::Relaxed);
                    let err_s = res.as_ref().err().map(|e| e.to_string()).unwrap_or_default();
                    if err_s.contains("stalled") {
                        stall_count.fetch_add(1, Ordering::Relaxed);
                    }
                    if err_s.contains("429") || err_s.contains("503") || err_s.contains("server busy") {
                        busy_count.fetch_add(1, Ordering::Relaxed);
                    }
                    let kind = if err_s.contains("403") || err_s.contains("416") {
                        FailureKind::Permanent
                    } else {
                        FailureKind::Transient
                    };

                    if let Err(e) = &res {
                        eprintln!("[C{w}] piece {idx} failed (attempt {n}/{MAX_PIECE_RETRIES}): {e}");
                    } else {
                        eprintln!("[C{w}] piece {idx} short read (attempt {n}/{MAX_PIECE_RETRIES})");
                    }

                    if n >= MAX_PIECE_RETRIES {
                        eprintln!("[C{w}] piece {idx} permanently failed");
                        had_failure.store(true, Ordering::Relaxed);
                        failed_count.fetch_add(1, Ordering::Relaxed);
                        if remaining.fetch_sub(1, Ordering::Release) == 1 {
                            notify.notify_waiters();
                        }
                        adaptive.on_failure(FailureKind::Permanent);
                    } else {
                        adaptive.on_failure(kind);
                        sleep(Duration::from_millis(300 * n as u64)).await;
                        queue.push(idx);
                        notify.notify_one();
                    }
                }
            }
        }));
    }

    let reporter = {
        let completed_bytes = Arc::clone(&completed_bytes);
        let piece_written = Arc::clone(&piece_written);
        let remaining = Arc::clone(&remaining);
        let completed = Arc::clone(&completed);
        let completed_count = Arc::clone(&completed_count);
        let failed_count = Arc::clone(&failed_count);
        let peak_speed_bps = Arc::clone(&peak_speed_bps);
        let adaptive = Arc::clone(&adaptive);
        let header_bar = header_bar.clone();
        let state_path = state_path.to_path_buf();
        let total_pieces = num_pieces;
        let etag = discovery.etag.clone();
        let last_modified = discovery.last_modified.clone();
        let mut last_persisted_done = completed_count.load(Ordering::Relaxed) as usize;
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(500));
            let mut last_bytes = baseline_bytes;
            let mut last_tick = Instant::now();
            let mut last_save = Instant::now();
            let mut smoothed_speed: f64 = 0.0;
            // High-water: piece retries / partial resets must not drop displayed bytes
            // or invent fake 0 B/s / GiB/s spikes.
            let mut high_water = baseline_bytes;
            let mut calibrate_ticks: u8 = 0;
            let mut stall_ticks: u8 = 0;

            let mut last_tune = Instant::now();
            let mut last_tune_speed: f64 = 0.0;
            let mut max_speed_reached: f64 = 0.0;
            let mut locked_optimum_speed: f64 = 0.0;
            let mut locked = false;
            let mut consecutive_drops: u8 = 0;
            let mut re_probe_ticks: u8 = 0;

            loop {
                ticker.tick().await;

                let mut current = completed_bytes.load(Ordering::Relaxed);
                for p in piece_written.iter() {
                    current += p.load(Ordering::Relaxed);
                }
                current = std::cmp::min(current, total_size);
                if current > high_water {
                    high_water = current;
                }

                let tick_secs = last_tick.elapsed().as_secs_f64().max(0.001);
                // Skip first ticks after resume so loading baseline ≠ GiB/s spike.
                if calibrate_ticks < 2 {
                    calibrate_ticks += 1;
                    last_bytes = high_water;
                    last_tick = Instant::now();
                    header_bar.set_position(high_water);
                    let done_count = completed_count.load(Ordering::Relaxed) as usize;
                    header_bar.set_message(format!("{}/{} pieces", done_count, total_pieces));
                    println!(
                        "{}",
                        json!({
                            "type": "progress",
                            "downloaded": high_water,
                            "total": total_size,
                            "speed_bps": 0,
                            "elapsed_secs": start_time.elapsed().as_secs_f64(),
                            "eta_secs": 0,
                            "connections": adaptive.current_limit(),
                            "threads": []
                        })
                    );
                    continue;
                }

                let delta = high_water.saturating_sub(last_bytes);
                let instant = delta as f64 / tick_secs;
                if delta == 0 {
                    // Hold last speed ~2s (4 × 500ms) before decaying — CDN idle
                    // gaps are common and must not report as 0 B/s instantly.
                    stall_ticks = stall_ticks.saturating_add(1);
                    if stall_ticks > 4 {
                        smoothed_speed *= 0.88;
                        if smoothed_speed < 1024.0 {
                            smoothed_speed = 0.0;
                        }
                    }
                } else {
                    stall_ticks = 0;
                    if smoothed_speed <= 0.0 {
                        smoothed_speed = instant;
                    } else {
                        smoothed_speed = smoothed_speed * 0.70 + instant * 0.30;
                    }
                }

                let speed_bps = smoothed_speed as u64;
                let prev_peak = peak_speed_bps.load(Ordering::Relaxed);
                if speed_bps > prev_peak {
                    peak_speed_bps.store(speed_bps, Ordering::Relaxed);
                }
                let elapsed = start_time.elapsed().as_secs_f64();
                let eta_secs = if speed_bps > 1024 {
                    (total_size.saturating_sub(high_water) as f64 / speed_bps as f64) as u64
                } else {
                    0
                };

                // Adaptive tuning every 2 seconds (was 5s — too slow to recover).
                if auto_tune && last_tune.elapsed().as_secs() >= 2 {
                    let limit = adaptive.current_limit();
                    let ceiling = adaptive.ceiling();

                    if smoothed_speed > max_speed_reached {
                        max_speed_reached = smoothed_speed;
                    }

                    if !locked {
                        if smoothed_speed > (last_tune_speed * 1.05) && last_tune_speed > 1024.0 {
                            if limit < ceiling {
                                adaptive.set_limit(limit + 1);
                                slot_notify.notify_waiters();
                                eprintln!("   📈 Auto-tune: Speed increased to {:.1} MB/s. Probing {} -> {} connections.", smoothed_speed / 1_048_576.0, limit, limit + 1);
                            }
                        } else {
                            if limit > 1 {
                                adaptive.set_limit(limit - 1);
                            }
                            locked = true;
                            locked_optimum_speed = smoothed_speed.max(last_tune_speed);
                            consecutive_drops = 0;
                            re_probe_ticks = 0;
                            eprintln!("   🔒 Auto-tune: Locked optimal connections at {} (Speed: {:.1} MB/s).", limit.saturating_sub(1).max(1), locked_optimum_speed / 1_048_576.0);
                        }
                    } else {
                        if smoothed_speed < (locked_optimum_speed * 0.85) && locked_optimum_speed > 1024.0 {
                            consecutive_drops += 1;
                        } else {
                            consecutive_drops = 0;
                        }

                        if consecutive_drops >= 2 {
                            if limit > 1 {
                                adaptive.set_limit(limit - 1);
                                locked_optimum_speed = smoothed_speed;
                                consecutive_drops = 0;
                                re_probe_ticks = 0;
                                eprintln!("   📉 Auto-tune: Speed degraded to {:.1} MB/s. Reducing to {} connections.", smoothed_speed / 1_048_576.0, limit - 1);
                            } else {
                                locked_optimum_speed = smoothed_speed;
                                consecutive_drops = 0;
                            }
                        } else {
                            re_probe_ticks += 1;
                            if re_probe_ticks >= 15 && limit < ceiling {
                                if smoothed_speed < (max_speed_reached * 0.90) {
                                    eprintln!("   🔍 Auto-tune: Re-probing for more bandwidth to reach historic max {:.1} MB/s...", max_speed_reached / 1_048_576.0);
                                    locked = false;
                                }
                                re_probe_ticks = 0;
                            }
                        }
                    }

                    last_tune = Instant::now();
                    last_tune_speed = smoothed_speed;
                }

                last_bytes = high_water;
                last_tick = Instant::now();
                header_bar.set_position(high_water);

                let done_count = completed_count.load(Ordering::Relaxed) as usize;
                let fail = failed_count.load(Ordering::Relaxed);
                if fail > 0 {
                    header_bar.set_message(format!("{}/{} pieces, {} failed", done_count, total_pieces, fail));
                } else {
                    header_bar.set_message(format!("{}/{} pieces", done_count, total_pieces));
                }
                let should_save = last_save.elapsed() >= Duration::from_millis(RESUME_INTERVAL_MS)
                    || done_count != last_persisted_done;

                if should_save {
                    last_persisted_done = done_count;
                    last_save = Instant::now();
                    let _ = crate::resume::save_bitmap_atomic(
                        &state_path,
                        piece_size,
                        total_size,
                        &etag,
                        &last_modified,
                        &completed,
                    );
                }

                println!(
                    "{}",
                    json!({
                        "type": "progress",
                        "downloaded": high_water,
                        "total": total_size,
                        "speed_bps": speed_bps,
                        "elapsed_secs": elapsed,
                        "eta_secs": eta_secs,
                        "connections": adaptive.current_limit(),
                        "threads": []
                    })
                );

                if high_water >= total_size || remaining.load(Ordering::Acquire) == 0 {
                    break;
                }
            }
        })
    };

    for handle in handles {
        let _ = handle.await;
    }
    let _ = reporter.await;

    header_bar.finish_with_message("✅ Done!");

    let final_dl = completed_bytes.load(Ordering::SeqCst);
    let elapsed = start_time.elapsed().as_secs_f64();
    let t_download = start_time.elapsed() - t_prep;
    let session_bytes = final_dl.saturating_sub(baseline_bytes);
    let download_secs = t_download.as_secs_f64().max(0.001);
    let session_mbps = (session_bytes as f64 / 1_048_576.0) / download_secs;
    // Wall average over full file size is misleading on resume — keep for compat only.
    let wall_mbps = (final_dl as f64 / 1_048_576.0) / elapsed.max(0.001);
    let peak_mbps = peak_speed_bps.load(Ordering::Relaxed) as f64 / 1_048_576.0;
    let retries = retry_count.load(Ordering::Relaxed);
    let stalls = stall_count.load(Ordering::Relaxed);
    let busy = busy_count.load(Ordering::Relaxed);
    let fails = failed_count.load(Ordering::Relaxed);

    // Collect and sort piece metrics for the summary table
    let mut sorted_metrics: Vec<PieceMetrics> = Vec::with_capacity(num_pieces);
    while let Some(m) = piece_metrics.pop() {
        sorted_metrics.push(m);
    }
    sorted_metrics.sort_by_key(|m| m.piece_idx);

    let host = url::Url::parse(&args.url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| "unknown".into());

    eprintln!("");
    eprintln!("━━━ [5/5] Complete ─────────────────────────────── +{:.1}s", elapsed);

    // Diagnostic block — the useful signals for CDN / resume / throttle analysis.
    eprintln!("   ┌──── Session diagnostics ──────────────────────────────────────────────────────────┐");
    eprintln!(
        "   │ Host: {:<62} │",
        truncate_str(&host, 62)
    );
    eprintln!(
        "   │ Workers: {}  |  piece: {} MB  |  auto-tune: {:<5}  |  ranges: {:<5} │",
        effective_ceiling,
        piece_size / (1024 * 1024),
        if auto_tune { "on" } else { "off" },
        if ranges_ok { "yes" } else { "no" }
    );
    eprintln!(
        "   │ Resume baseline: {} ({:.1}%)  |  session transfer: {}  │",
        format_bytes(baseline_bytes),
        if total_size > 0 {
            baseline_bytes as f64 / total_size as f64 * 100.0
        } else {
            0.0
        },
        format_bytes(session_bytes)
    );
    eprintln!(
        "   │ Speed: session {:.2} MB/s  |  peak {:.2} MB/s  |  wall {:.2} MB/s (full file/time) │",
        session_mbps, peak_mbps, wall_mbps
    );
    eprintln!(
        "   │ Health: retries={}  stalls={}  busy(429/503)={}  permanent_fail={}  │",
        retries, stalls, busy, fails
    );

    if !sorted_metrics.is_empty() {
        let mut ttfbs: Vec<f64> = sorted_metrics.iter().map(|m| m.ttfb_secs).collect();
        let mut xfers: Vec<f64> = sorted_metrics.iter().map(|m| m.transfer_secs).collect();
        ttfbs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        xfers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let p = |v: &[f64], q: f64| -> f64 {
            if v.is_empty() {
                return 0.0;
            }
            let i = ((v.len() as f64 - 1.0) * q).round() as usize;
            v[i.min(v.len() - 1)]
        };
        let slow = sorted_metrics
            .iter()
            .filter(|m| m.transfer_secs >= 60.0 || m.ttfb_secs >= 10.0)
            .count();
        let resumed_pieces = sorted_metrics.iter().filter(|m| m.resumed_from > 0).count();
        let multi_attempt = sorted_metrics.iter().filter(|m| m.attempt > 1).count();
        eprintln!(
            "   │ TTFB p50/p95: {:.2}s / {:.2}s  |  Xfer p50/p95: {:.1}s / {:.1}s  │",
            p(&ttfbs, 0.50),
            p(&ttfbs, 0.95),
            p(&xfers, 0.50),
            p(&xfers, 0.95)
        );
        eprintln!(
            "   │ Pieces this session: {}  |  slow (TTFB≥10s or Xfer≥60s): {}  │",
            sorted_metrics.len(),
            slow
        );
        eprintln!(
            "   │ Piece-resume hits: {}  |  finished after retry: {}  │",
            resumed_pieces, multi_attempt
        );
    }
    eprintln!(
        "   │ Stages: init {:.2}s + discover {:.2}s + prep {:.2}s + download {:.1}s  │",
        t_init.as_secs_f64(),
        (t_discover - t_init).as_secs_f64(),
        (t_prep - t_discover).as_secs_f64(),
        download_secs
    );
    eprintln!("   └──────────────────────────────────────────────────────────────────────────────────┘");

    // Chunk table: full when small; otherwise only the slowest outliers.
    let show_all = sorted_metrics.len() <= 24;
    let table_rows: Vec<&PieceMetrics> = if show_all {
        sorted_metrics.iter().collect()
    } else {
        let mut slowest: Vec<&PieceMetrics> = sorted_metrics.iter().collect();
        slowest.sort_by(|a, b| {
            b.transfer_secs
                .partial_cmp(&a.transfer_secs)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        slowest.truncate(12);
        slowest.sort_by_key(|m| m.piece_idx);
        slowest
    };

    if !table_rows.is_empty() {
        eprintln!("   ┌──── Chunk detail {}──────────────────────────────────────────────────────────────────┐",
            if show_all { "" } else { "(slowest 12) " }
        );
        eprintln!("   │ {:>5} │ {:>18} │ {:>9} │ {:>8} │ {:>6} │ {:>6} │ {:>7} │ {:>3} │",
            "Chunk", "Range", "New bytes", "Resume+", "TTFB", "Xfer", "MB/s", "Try");
        eprintln!("   ├{:─>7}┼{:─>20}┼{:─>11}┼{:─>10}┼{:─>8}┼{:─>8}┼{:─>9}┼{:─>5}┤",
            "─", "─", "─", "─", "─", "─", "─", "─");

        let mut total_dl_bytes: u64 = 0;
        for m in &sorted_metrics {
            total_dl_bytes += m.bytes_downloaded;
        }
        for m in &table_rows {
            let range = format!(
                "{:.1}–{:.1} MB",
                m.start_byte as f64 / 1_048_576.0,
                m.end_byte as f64 / 1_048_576.0
            );
            eprintln!(
                "   │ {:>5} │ {:>18} │ {:>9} │ {:>8} │ {:>5.2}s │ {:>5.1}s │ {:>5.2} │ {:>3} │",
                m.piece_idx,
                range,
                format_bytes(m.bytes_downloaded),
                if m.resumed_from > 0 {
                    format_bytes(m.resumed_from)
                } else {
                    "—".into()
                },
                m.ttfb_secs,
                m.transfer_secs,
                m.speed_mbps(),
                m.attempt
            );
        }

        eprintln!("   ├{:─>7}┼{:─>20}┼{:─>11}┼{:─>10}┼{:─>8}┼{:─>8}┼{:─>9}┼{:─>5}┤",
            "─", "─", "─", "─", "─", "─", "─", "─");
        eprintln!(
            "   │ {:>5} │ {:>18} │ {:>9} │ {:>8} │ {:>6} │ {:>5.1}s │ {:>5.2} │ {:>3} │",
            "Σ",
            format!("session pieces"),
            format_bytes(total_dl_bytes),
            "—",
            "—",
            download_secs,
            session_mbps,
            "—"
        );
        if !show_all {
            eprintln!(
                "   │ … {} other pieces omitted (see diagnostics for p50/p95)                              │",
                sorted_metrics.len().saturating_sub(table_rows.len())
            );
        }
        eprintln!("   └──────────────────────────────────────────────────────────────────────────────────────┘");
    }

    eprintln!("   📦 File: {} / {}  |  session {}", format_bytes(final_dl), format_bytes(total_size), format_bytes(session_bytes));
    eprintln!("   ⚡ Session {:.2} MB/s (peak {:.2}) — use this, not wall {:.2} on resumes", session_mbps, peak_mbps, wall_mbps);

    println!(
        "{}",
        json!({
            "type": "progress",
            "downloaded": final_dl,
            "total": total_size,
            "speed_bps": 0,
            "elapsed_secs": elapsed,
            "eta_secs": 0,
            "threads": []
        })
    );

    if had_failure.load(Ordering::SeqCst) || final_dl < total_size {
        eprintln!(
            "✗ Incomplete: {}/{} bytes ({:.1}%) — state kept for resume.",
            final_dl,
            total_size,
            (final_dl as f64 / total_size as f64) * 100.0
        );
        std::process::exit(1);
    }

    let _ = ensure_sidecar_dir(path);
    std::fs::write(&sidecar, "done")?;
    let _ = std::fs::remove_file(state_path);

    println!(
        "{}",
        json!({
            "type": "done",
            "total": total_size,
            "elapsed_secs": elapsed,
            "avg_speed_mbps": session_mbps,
            "session_bytes": session_bytes,
            "baseline_bytes": baseline_bytes,
            "peak_speed_mbps": peak_mbps,
            "retries": retries,
            "stalls": stalls,
            "busy_responses": busy,
            "workers": effective_ceiling,
            "host": host,
        })
    );

    Ok(())
}

fn truncate_str(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max.saturating_sub(1)])
    }
}
