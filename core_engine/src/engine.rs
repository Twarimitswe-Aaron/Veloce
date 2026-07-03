//! Download orchestration — workers, progress, resume persistence.

use crate::adaptive::{AdaptiveController, FailureKind};
use crate::args::EngineArgs;
use crate::discover::{build_http_client, discover, supports_ranges};
use crate::download::{download_piece, IDLE_TIMEOUT, MAX_PIECE_RETRIES};
use crate::file_io::{available_space, SharedOutput};
use crate::piece::{adaptive_piece_size, piece_ranges};
use crate::profiles::ProfileStore;
use crate::probe::probe_optimal_threads;
use crate::rate_limit::RateLimiter;
use crate::resume::{validators_match, ResumeState};
use crossbeam_queue::SegQueue;
use indicatif::{MultiProgress, ProgressBar, ProgressDrawTarget, ProgressStyle};
use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::time::{sleep, Duration};

const SAFETY_MARGIN: u64 = 32 * 1024 * 1024;
const RESUME_INTERVAL_MS: u64 = 2000;
const STAGGER_MS: u64 = 75;

pub async fn run_download(args: EngineArgs) -> Result<(), Box<dyn std::error::Error>> {
    let start_time = Instant::now();
    let path = Path::new(&args.save_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let profiles = ProfileStore::load(args.profiles_path.as_deref().map(Path::new));
    let thread_ceiling = profiles.thread_ceiling(&args.url, args.threads) as usize;

    let client = Arc::new(build_http_client(
        thread_ceiling,
        args.referer.as_deref(),
        args.origin.as_deref(),
    )?);

    let discovery = discover(&client, &args.url).await?;
    let total_size = discovery.total_size;

    let sidecar = format!("{}.veloce_done", args.save_path);
    if Path::new(&sidecar).exists() {
        eprintln!("✅ Already complete (sidecar found).");
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

    let state_file = format!("{}.veloce_state", args.save_path);
    let state_path = Path::new(&state_file);

    let resume_state: Option<ResumeState> = if path.exists() && state_path.exists() {
        ResumeState::load(state_path).filter(|s| {
            s.total_size == total_size
                && s.piece_size > 0
                && validators_match(s, &discovery.etag, &discovery.last_modified)
        })
    } else {
        None
    };

    let piece_size: u64;
    let completed_init: Vec<bool>;
    let output: SharedOutput;

    if let Some(state) = resume_state {
        piece_size = state.piece_size;
        completed_init = state.completed;
        output = SharedOutput::open_existing(path)?;
        let done = completed_init.iter().filter(|c| **c).count();
        eprintln!("🔄 Resuming: {}/{} pieces already complete.", done, completed_init.len());
    } else {
        if path.exists() {
            let existing = std::fs::metadata(path)?.len();
            eprintln!(
                "⚠️  Partial file without valid state ({} / {} bytes). Restarting...",
                existing, total_size
            );
            std::fs::remove_file(path)?;
        }
        let _ = std::fs::remove_file(state_path);

        let ranges_ok = thread_ceiling > 1
            && match discovery.ranges_hint {
                Some(v) => v,
                None => supports_ranges(&client, &args.url).await,
            };
        if !ranges_ok {
            eprintln!("⚠️  Server does not support range requests — using a single connection.");
        }

        let profile_piece = profiles.piece_bytes(&args.url);
        piece_size = if args.piece_size_bytes > 0 {
            args.piece_size_bytes
        } else if ranges_ok {
            adaptive_piece_size(total_size, profile_piece)
        } else {
            total_size.max(1)
        };

        if let Some(avail) = available_space(path) {
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

        output = SharedOutput::create_or_open(path, true)?;
        output.preallocate(total_size)?;
        completed_init = vec![false; piece_ranges(total_size, piece_size).len()];
    }

    let pieces: Arc<Vec<(u64, u64)>> = Arc::new(piece_ranges(total_size, piece_size));

    let mut effective_ceiling = std::cmp::min(thread_ceiling.max(1), pieces.len().max(1));
    let auto_tune = args.auto_tune && !args.no_auto_tune;
    if auto_tune && effective_ceiling > 1 && pieces.len() > 1 {
        let tuned = probe_optimal_threads(&client, &args.url, effective_ceiling, piece_size).await;
        eprintln!("📊 Auto-tune selected {tuned} connections (ceiling {effective_ceiling}).");
        effective_ceiling = tuned.max(1).min(effective_ceiling);
    }

    let adaptive = Arc::new(AdaptiveController::new(effective_ceiling));
    let queue: Arc<SegQueue<usize>> = Arc::new(SegQueue::new());
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
    let had_failure = Arc::new(AtomicBool::new(false));
    let worker_partial: Arc<Vec<AtomicU64>> =
        Arc::new((0..effective_ceiling).map(|_| AtomicU64::new(0)).collect());
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

    let mp = Arc::new(if args.quiet {
        MultiProgress::with_draw_target(ProgressDrawTarget::hidden())
    } else {
        MultiProgress::new()
    });
    let header_style = ProgressStyle::with_template(
        "{spinner:.cyan} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {bytes}/{total_bytes} | {binary_bytes_per_sec} | ETA {eta}",
    )
    .unwrap()
    .progress_chars("█▇▆▅▄▃▂▁░");
    let conn_style = ProgressStyle::with_template(
        " C{prefix:>2} [{bar:16.green/black}] {percent:>3}% {bytes:>8}/{total_bytes}",
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
        let client = Arc::clone(&client);
        let url = args.url.clone();
        let output = Arc::clone(&output);
        let queue = Arc::clone(&queue);
        let pieces = Arc::clone(&pieces);
        let completed = Arc::clone(&completed);
        let attempts = Arc::clone(&attempts);
        let remaining = Arc::clone(&remaining);
        let completed_bytes = Arc::clone(&completed_bytes);
        let adaptive = Arc::clone(&adaptive);
        let had_failure = Arc::clone(&had_failure);
        let worker_partial = Arc::clone(&worker_partial);
        let conn_bars = Arc::clone(&conn_bars);
        let limiter = Arc::clone(&limiter);
        let stagger = !args.no_stagger;

        handles.push(tokio::spawn(async move {
            if stagger {
                sleep(Duration::from_millis(STAGGER_MS * w as u64)).await;
            }

            loop {
                let idx = match queue.pop() {
                    Some(i) => i,
                    None => {
                        if remaining.load(Ordering::Acquire) == 0 {
                            break;
                        }
                        sleep(Duration::from_millis(30)).await;
                        continue;
                    }
                };

                while !adaptive.try_acquire_slot() {
                    sleep(Duration::from_millis(20)).await;
                }

                let (start, end) = pieces[idx];
                let piece_len = end - start + 1;
                let bar = &conn_bars[w];
                let expect_partial = piece_len < total_size;

                let res = download_piece(
                    &client,
                    &url,
                    &output,
                    start,
                    end,
                    expect_partial,
                    &worker_partial[w],
                    bar,
                    IDLE_TIMEOUT,
                    &limiter,
                    read_buf,
                )
                .await;

                adaptive.release_slot();

                let full = res.is_ok() && worker_partial[w].load(Ordering::Relaxed) == piece_len;
                worker_partial[w].store(0, Ordering::Relaxed);

                if full {
                    completed[idx].store(true, Ordering::Relaxed);
                    completed_bytes.fetch_add(piece_len, Ordering::Relaxed);
                    remaining.fetch_sub(1, Ordering::Release);
                    adaptive.on_success();
                } else {
                    let n = attempts[idx].fetch_add(1, Ordering::Relaxed) as usize + 1;
                    let kind = res
                        .as_ref()
                        .err()
                        .and_then(|e| {
                            let s = e.to_string();
                            if s.contains("403") || s.contains("416") {
                                Some(FailureKind::Permanent)
                            } else {
                                Some(FailureKind::Transient)
                            }
                        })
                        .unwrap_or(FailureKind::Transient);

                    if let Err(e) = &res {
                        eprintln!("[C{w}] piece {idx} failed (attempt {n}/{MAX_PIECE_RETRIES}): {e}");
                    } else {
                        eprintln!("[C{w}] piece {idx} short read (attempt {n}/{MAX_PIECE_RETRIES})");
                    }

                    if n >= MAX_PIECE_RETRIES {
                        eprintln!("[C{w}] piece {idx} permanently failed");
                        had_failure.store(true, Ordering::Relaxed);
                        remaining.fetch_sub(1, Ordering::Release);
                        adaptive.on_failure(FailureKind::Permanent);
                    } else {
                        adaptive.on_failure(kind);
                        sleep(Duration::from_millis(300 * n as u64)).await;
                        queue.push(idx);
                    }
                }
            }
        }));
    }

    let reporter = {
        let completed_bytes = Arc::clone(&completed_bytes);
        let worker_partial = Arc::clone(&worker_partial);
        let remaining = Arc::clone(&remaining);
        let completed = Arc::clone(&completed);
        let adaptive = Arc::clone(&adaptive);
        let header_bar = header_bar.clone();
        let state_path = state_path.to_path_buf();
        let etag = discovery.etag.clone();
        let last_modified = discovery.last_modified.clone();
        let mut last_persisted_done = completed_init.iter().filter(|c| **c).count();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(500));
            let mut last_bytes = baseline_bytes;
            let mut last_tick = Instant::now();
            let mut last_save = Instant::now();

            loop {
                ticker.tick().await;

                let mut current = completed_bytes.load(Ordering::Relaxed);
                for p in worker_partial.iter() {
                    current += p.load(Ordering::Relaxed);
                }
                current = std::cmp::min(current, total_size);

                let tick_secs = last_tick.elapsed().as_secs_f64();
                let speed_bps = (current.saturating_sub(last_bytes) as f64 / tick_secs) as u64;
                let elapsed = start_time.elapsed().as_secs_f64();
                let eta_secs = if speed_bps > 0 {
                    (total_size.saturating_sub(current) as f64 / speed_bps as f64) as u64
                } else {
                    0
                };
                last_bytes = current;
                last_tick = Instant::now();
                header_bar.set_position(current);

                let done_count = completed.iter().filter(|b| b.load(Ordering::Relaxed)).count();
                let should_save = last_save.elapsed() >= Duration::from_millis(RESUME_INTERVAL_MS)
                    || done_count != last_persisted_done;

                if should_save {
                    last_persisted_done = done_count;
                    last_save = Instant::now();
                    let snapshot: Vec<bool> = completed.iter().map(|b| b.load(Ordering::Relaxed)).collect();
                    let resume = ResumeState {
                        piece_size,
                        total_size,
                        etag: etag.clone(),
                        last_modified: last_modified.clone(),
                        completed: snapshot,
                    };
                    let _ = ResumeState::save_atomic(&state_path, &resume);
                }

                println!(
                    "{}",
                    json!({
                        "type": "progress",
                        "downloaded": current,
                        "total": total_size,
                        "speed_bps": speed_bps,
                        "elapsed_secs": elapsed,
                        "eta_secs": eta_secs,
                        "connections": adaptive.current_limit(),
                        "threads": []
                    })
                );

                if current >= total_size || remaining.load(Ordering::Acquire) == 0 {
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
    let avg_mbps = (final_dl as f64 / 1_048_576.0) / elapsed;

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

    std::fs::write(&sidecar, "done")?;
    let _ = std::fs::remove_file(state_path);

    println!(
        "{}",
        json!({
            "type": "done",
            "total": total_size,
            "elapsed_secs": elapsed,
            "avg_speed_mbps": avg_mbps
        })
    );

    Ok(())
}
