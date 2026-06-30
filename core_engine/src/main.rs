use clap::Parser;
use crossbeam_queue::SegQueue;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use reqwest::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, ETAG, LAST_MODIFIED, RANGE};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::SeekFrom;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering};
use std::time::Instant;
use tokio::io::{AsyncSeekExt, AsyncWriteExt, BufWriter};
use tokio::time::Duration;

/// Fixed work unit. The file is divided into pieces of this size; idle
/// connections pull the next pending piece, so a slow connection never stalls
/// the whole download (no fixed per-thread tail). 4 MiB balances HTTP overhead
/// against work-stealing granularity.
const PIECE_SIZE: u64 = 4 * 1024 * 1024;

/// Abort a piece only if NO bytes arrive for this long. Unlike a total-request
/// timeout, a legitimately slow-but-progressing transfer is never killed.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Max attempts per piece before it is declared permanently failed.
const MAX_PIECE_RETRIES: usize = 10;

/// Veloce high-performance download engine
#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Args {
    #[arg(long)]
    id: String,

    #[arg(long)]
    url: String,

    #[arg(long)]
    save_path: String,

    /// Maximum number of parallel connections.
    /// 8 is optimal for most servers — above that many CDNs throttle per-IP.
    #[arg(long, default_value_t = 8)]
    threads: u64,
}

/// On-disk resume metadata written next to the file as `{save_path}.veloce_state`.
/// A piece bitmap (O(1) per-piece lookup) plus the server validators let us
/// resume safely and reject a stale state for a file that changed server-side.
#[derive(Serialize, Deserialize)]
struct ResumeState {
    piece_size:    u64,
    total_size:    u64,
    etag:          Option<String>,
    last_modified: Option<String>,
    completed:     Vec<bool>,
}

/// Probe whether the server honors HTTP range requests.
/// A `206` proves it; otherwise trust an explicit `Accept-Ranges: bytes`.
async fn supports_ranges(client: &reqwest::Client, url: &str) -> bool {
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

/// Reserve real disk blocks up front (not a sparse file) so we fail fast on a
/// full disk and reduce fragmentation. Falls back to `set_len` where
/// `posix_fallocate` is unsupported (e.g. tmpfs/overlay) or off-Linux.
fn preallocate(file: &std::fs::File, len: u64) -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::io::AsRawFd;
        let ret = unsafe { libc::posix_fallocate(file.as_raw_fd(), 0, len as libc::off_t) };
        if ret == 0 {
            return Ok(());
        }
    }
    file.set_len(len)
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

/// Extract the total size from a `Content-Range: bytes 0-0/12345` header.
fn parse_total_from_content_range(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let v = headers.get(CONTENT_RANGE)?.to_str().ok()?;
    v.rsplit('/').next()?.trim().parse::<u64>().ok().filter(|s| *s > 0)
}

/// Discover `(total_size, etag, last_modified, ranges_supported_hint)`.
/// HEAD is tried first; if it fails or omits a usable `Content-Length` (very
/// common for signed CDN URLs such as Instagram/fbcdn), we fall back to a
/// 1-byte ranged GET and read the size from `Content-Range`/`Content-Length`.
async fn discover(
    client: &reqwest::Client,
    url: &str,
) -> anyhow::Result<(u64, Option<String>, Option<String>, Option<bool>)> {
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
                return Ok((len, etag, lm, ar));
            }
        }
    }

    // Fallback: a ranged GET reveals size even when HEAD is unhelpful.
    let res = client.get(url).header(RANGE, "bytes=0-0").send().await?;
    let status = res.status();
    let etag = header_string(res.headers(), ETAG);
    let lm = header_string(res.headers(), LAST_MODIFIED);

    if status.as_u16() == 206 {
        if let Some(total) = parse_total_from_content_range(res.headers()) {
            return Ok((total, etag, lm, Some(true)));
        }
    }
    if status.is_success() {
        if let Some(len) = parse_content_length(res.headers()) {
            // A 200 response to a range request means ranges are ignored.
            return Ok((len, etag, lm, Some(false)));
        }
    }
    anyhow::bail!("could not determine file size (status {status})");
}

/// Resume is only valid if the file identity matches. We compare any validators
/// both sides actually provided; unknown validators are treated as compatible.
fn validators_match(state: &ResumeState, etag: &Option<String>, last_modified: &Option<String>) -> bool {
    if let (Some(a), Some(b)) = (&state.etag, etag) {
        if a != b {
            return false;
        }
    }
    if let (Some(a), Some(b)) = (&state.last_modified, last_modified) {
        if a != b {
            return false;
        }
    }
    true
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let start_time = Instant::now();

    let path = Path::new(&args.save_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Connection pool sized to the max parallelism. No gzip (raw bytes), TCP
    // nodelay (no Nagle latency), HTTP/1.1 only (avoid single-socket H2
    // multiplex throttling). NOTE: only a connect timeout — body reads are
    // governed by a per-read idle timeout, never a total-request deadline.
    let client = Arc::new(
        reqwest::Client::builder()
            // A browser-like User-Agent — many CDNs (Instagram/fbcdn, Cloudflare,
            // etc.) reject default library agents with 403.
            .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
            .tcp_keepalive(Duration::from_secs(30))
            .tcp_nodelay(true)
            .no_gzip()
            .http1_only()
            .pool_max_idle_per_host(args.threads as usize)
            .connect_timeout(Duration::from_secs(30))
            .build()?,
    );

    // Discover size + validators (HEAD, falling back to a ranged GET).
    let (total_size, etag, last_modified, ranges_hint) = match discover(&client, &args.url).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("Discovery failed: {e}");
            std::process::exit(1);
        }
    };

    // Already complete? The sidecar is authoritative (a pre-allocated file
    // always equals total_size even when empty).
    let sidecar = format!("{}.veloce_done", args.save_path);
    if Path::new(&sidecar).exists() {
        eprintln!("✅ Already complete (sidecar found).");
        println!("{}", json!({
            "type": "already_exists",
            "downloaded": total_size,
            "total": total_size,
            "elapsed_secs": 0
        }));
        std::process::exit(0);
    }

    let state_file = format!("{}.veloce_state", args.save_path);

    // ── Determine piece layout + which pieces are already done (resume) ──
    let resume_state: Option<ResumeState> = if path.exists() && Path::new(&state_file).exists() {
        std::fs::read_to_string(&state_file)
            .ok()
            .and_then(|c| serde_json::from_str::<ResumeState>(&c).ok())
            .filter(|s| {
                s.total_size == total_size
                    && s.piece_size > 0
                    && validators_match(s, &etag, &last_modified)
            })
    } else {
        None
    };

    let piece_size: u64;
    let completed_init: Vec<bool>;

    if let Some(state) = resume_state {
        piece_size = state.piece_size;
        completed_init = state.completed;
        let done = completed_init.iter().filter(|c| **c).count();
        eprintln!("🔄 Resuming: {}/{} pieces already complete.", done, completed_init.len());
    } else {
        // Fresh download: clear any stale partial + state.
        if path.exists() {
            let existing = std::fs::metadata(&args.save_path)?.len();
            eprintln!("⚠️  Partial file without valid state ({} / {} bytes). Restarting...", existing, total_size);
            std::fs::remove_file(&args.save_path)?;
        }
        let _ = std::fs::remove_file(&state_file);

        // If the server ignores ranges, a single piece covering the whole file
        // is the only safe layout (every ranged GET would return the full body).
        // Reuse the hint from discovery; only probe again if it was inconclusive.
        let ranges_ok = args.threads > 1
            && match ranges_hint {
                Some(v) => v,
                None => supports_ranges(&client, &args.url).await,
            };
        if !ranges_ok {
            eprintln!("⚠️  Server does not support range requests — using a single connection.");
        }
        piece_size = if ranges_ok { PIECE_SIZE } else { total_size.max(1) };

        let num_pieces = total_size.div_ceil(piece_size) as usize;
        completed_init = vec![false; num_pieces];

        // Reserve disk space up front.
        let file = std::fs::OpenOptions::new()
            .write(true).create(true).truncate(true)
            .open(&args.save_path)?;
        preallocate(&file, total_size)?;
    }

    let num_pieces = completed_init.len();

    // Piece byte ranges (start, end inclusive). Lookup is O(1).
    let pieces: Arc<Vec<(u64, u64)>> = Arc::new(
        (0..num_pieces)
            .map(|i| {
                let start = i as u64 * piece_size;
                let end = std::cmp::min(start + piece_size, total_size) - 1;
                (start, end)
            })
            .collect(),
    );

    // Connections = min(requested, number of pieces). This is also the ceiling
    // the adaptive controller can ramp back up to.
    let ceiling = std::cmp::min(args.threads.max(1) as usize, num_pieces.max(1));

    // Lock-free pending-piece queue (O(1) push/pop). Seed with every piece that
    // is not already complete; sum bytes of completed pieces for the baseline.
    let queue: Arc<SegQueue<usize>> = Arc::new(SegQueue::new());
    let completed: Arc<Vec<AtomicBool>> = Arc::new(completed_init.iter().map(|c| AtomicBool::new(*c)).collect());
    let attempts: Arc<Vec<AtomicU8>> = Arc::new((0..num_pieces).map(|_| AtomicU8::new(0)).collect());

    let mut baseline_bytes = 0u64;
    let mut remaining_count = 0usize;
    for i in 0..num_pieces {
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
    let max_conn = Arc::new(AtomicUsize::new(ceiling));
    let active = Arc::new(AtomicUsize::new(0));
    let had_failure = Arc::new(AtomicBool::new(false));
    // Per-connection in-flight byte counters (each worker owns one slot — no contention).
    let worker_partial: Arc<Vec<AtomicU64>> = Arc::new((0..ceiling).map(|_| AtomicU64::new(0)).collect());

    println!("{}", json!({
        "type": "info",
        "threads": ceiling,
        "chunk_size_bytes": piece_size,
        "total_size_bytes": total_size,
        "pieces": num_pieces
    }));

    // ── Progress bars (stderr; bypasses Node buffering, renders ANSI when TTY) ──
    let mp = Arc::new(MultiProgress::new());
    let header_style = ProgressStyle::with_template(
        "{spinner:.cyan} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {bytes}/{total_bytes} | {binary_bytes_per_sec} | ETA {eta}",
    )
    .unwrap()
    .progress_chars("█▇▆▅▄▃▂▁░");
    let conn_style = ProgressStyle::with_template(" C{prefix:>2} [{bar:16.green/black}] {percent:>3}% {bytes:>8}/{total_bytes}")
        .unwrap()
        .progress_chars("█░░");

    let header_bar = mp.add(ProgressBar::new(total_size));
    header_bar.set_style(header_style);
    header_bar.set_position(baseline_bytes);

    let conn_bars: Arc<Vec<ProgressBar>> = Arc::new(
        (0..ceiling)
            .map(|w| {
                let b = mp.add(ProgressBar::new(piece_size));
                b.set_style(conn_style.clone());
                b.set_prefix(format!("{}", w));
                b
            })
            .collect(),
    );

    // ── Spawn one worker per connection. Each pulls pieces until none remain. ──
    let mut handles = vec![];
    for w in 0..ceiling {
        let client = Arc::clone(&client);
        let url = args.url.clone();
        let save_path = args.save_path.clone();
        let queue = Arc::clone(&queue);
        let pieces = Arc::clone(&pieces);
        let completed = Arc::clone(&completed);
        let attempts = Arc::clone(&attempts);
        let remaining = Arc::clone(&remaining);
        let completed_bytes = Arc::clone(&completed_bytes);
        let max_conn = Arc::clone(&max_conn);
        let active = Arc::clone(&active);
        let had_failure = Arc::clone(&had_failure);
        let worker_partial = Arc::clone(&worker_partial);
        let conn_bars = Arc::clone(&conn_bars);

        handles.push(tokio::spawn(async move {
            loop {
                // Claim the next pending piece (O(1)).
                let idx = match queue.pop() {
                    Some(i) => i,
                    None => {
                        if remaining.load(Ordering::Acquire) == 0 {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        continue;
                    }
                };

                // Acquire a concurrency slot (adaptive cap).
                loop {
                    let a = active.load(Ordering::Relaxed);
                    let m = max_conn.load(Ordering::Relaxed);
                    if a < m {
                        if active.compare_exchange(a, a + 1, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                            break;
                        }
                    } else {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }

                let (start, end) = pieces[idx];
                let piece_len = end - start + 1;
                let bar = &conn_bars[w];

                let res = download_piece(&client, &url, &save_path, start, end, &worker_partial[w], bar, IDLE_TIMEOUT).await;
                active.fetch_sub(1, Ordering::SeqCst);

                let full = res.is_ok() && worker_partial[w].load(Ordering::Relaxed) == piece_len;
                worker_partial[w].store(0, Ordering::Relaxed);

                if full {
                    completed[idx].store(true, Ordering::Relaxed);
                    completed_bytes.fetch_add(piece_len, Ordering::Relaxed);
                    remaining.fetch_sub(1, Ordering::Release);
                    // Ramp concurrency back up after any earlier throttle-down.
                    let m = max_conn.load(Ordering::Relaxed);
                    if m < ceiling {
                        let _ = max_conn.compare_exchange(m, m + 1, Ordering::SeqCst, Ordering::SeqCst);
                    }
                } else {
                    let n = attempts[idx].fetch_add(1, Ordering::Relaxed) as usize + 1;
                    match &res {
                        Err(e) => eprintln!("[C{w}] piece {idx} failed (attempt {n}/{MAX_PIECE_RETRIES}): {e}"),
                        Ok(()) => eprintln!("[C{w}] piece {idx} short read (attempt {n}/{MAX_PIECE_RETRIES})"),
                    }
                    if n >= MAX_PIECE_RETRIES {
                        eprintln!("[C{w}] piece {idx} permanently failed");
                        had_failure.store(true, Ordering::Relaxed);
                        remaining.fetch_sub(1, Ordering::Release);
                    } else {
                        // Halve the concurrency cap to ease server pressure, back off, requeue.
                        let m = max_conn.load(Ordering::SeqCst);
                        if m > 1 {
                            let nm = std::cmp::max(1, m / 2);
                            if max_conn.compare_exchange(m, nm, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                                eprintln!("[C{w}] reduced max connections to {nm}");
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(300 * n as u64)).await;
                        queue.push(idx);
                    }
                }
            }
        }));
    }

    // ── Progress reporter: JSON to stdout + persist resume state (off hot path) ──
    let reporter = {
        let completed_bytes = Arc::clone(&completed_bytes);
        let worker_partial = Arc::clone(&worker_partial);
        let remaining = Arc::clone(&remaining);
        let completed = Arc::clone(&completed);
        let max_conn = Arc::clone(&max_conn);
        let header_bar = header_bar.clone();
        let state_file = state_file.clone();
        let etag = etag.clone();
        let last_modified = last_modified.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(500));
            let mut last_bytes = baseline_bytes;
            let mut last_tick = Instant::now();

            loop {
                ticker.tick().await;

                // current = completed pieces + in-flight partials. O(connections).
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

                // Snapshot the piece bitmap and persist it asynchronously.
                let snapshot: Vec<bool> = completed.iter().map(|b| b.load(Ordering::Relaxed)).collect();
                let resume = ResumeState {
                    piece_size,
                    total_size,
                    etag: etag.clone(),
                    last_modified: last_modified.clone(),
                    completed: snapshot,
                };
                if let Ok(json_str) = serde_json::to_string(&resume) {
                    let _ = tokio::fs::write(&state_file, json_str).await;
                }

                println!("{}", json!({
                    "type":         "progress",
                    "downloaded":   current,
                    "total":        total_size,
                    "speed_bps":    speed_bps,
                    "elapsed_secs": elapsed,
                    "eta_secs":     eta_secs,
                    "connections":  max_conn.load(Ordering::Relaxed),
                    "threads":      []
                }));

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

    println!("{}", json!({"type":"progress","downloaded":final_dl,"total":total_size,"speed_bps":0,"elapsed_secs":elapsed,"eta_secs":0,"threads":[]}));

    if had_failure.load(Ordering::SeqCst) || final_dl < total_size {
        eprintln!("✗ Incomplete: {}/{} bytes ({:.1}%) — state kept for resume.",
            final_dl, total_size,
            (final_dl as f64 / total_size as f64) * 100.0);
        std::process::exit(1);
    }

    // Mark complete and clean up resume state.
    std::fs::write(&sidecar, "done")?;
    let _ = std::fs::remove_file(&state_file);

    println!("{}", json!({"type":"done","total":total_size,"elapsed_secs":elapsed,"avg_speed_mbps":avg_mbps}));
    Ok(())
}

/// Download one piece [start, end] (inclusive) and write it at `start`.
/// Resets `worker_partial` to 0 and tracks live bytes there + on the bar.
/// Aborts only on a per-read idle stall, never on total duration.
async fn download_piece(
    client: &reqwest::Client,
    url: &str,
    save_path: &str,
    start: u64,
    end: u64,
    worker_partial: &AtomicU64,
    bar: &ProgressBar,
    idle_timeout: Duration,
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

    if !res.status().is_success() {
        anyhow::bail!("bad status {}", res.status());
    }

    let file = tokio::fs::OpenOptions::new().write(true).open(save_path).await?;
    let mut writer = BufWriter::with_capacity(2 * 1024 * 1024, file);
    writer.seek(SeekFrom::Start(start)).await?;

    use futures::StreamExt;
    let mut stream = res.bytes_stream();

    loop {
        match tokio::time::timeout(idle_timeout, stream.next()).await {
            Err(_) => {
                let _ = writer.flush().await;
                anyhow::bail!("stalled: no data for {:?}", idle_timeout);
            }
            Ok(None) => break,
            Ok(Some(Ok(bytes))) => {
                writer.write_all(&bytes).await?;
                let n = bytes.len() as u64;
                worker_partial.fetch_add(n, Ordering::Relaxed);
                bar.inc(n);
            }
            Ok(Some(Err(e))) => {
                let _ = writer.flush().await;
                return Err(e.into());
            }
        }
    }

    writer.flush().await?;
    Ok(())
}
