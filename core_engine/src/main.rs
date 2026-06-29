use clap::Parser;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use reqwest::header::{CONTENT_LENGTH, RANGE};
use serde_json::json;
use std::io::SeekFrom;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;
use tokio::io::{AsyncSeekExt, AsyncWriteExt, BufWriter};
use tokio::time::Duration;

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

    /// Number of parallel download chunks.
    /// 8 is optimal for most servers — above that most CDNs start throttling per-IP.
    #[arg(long, default_value_t = 8)]
    threads: u64,
}

struct ChunkState {
    downloaded: AtomicU64,
    total:      u64,
    done:       AtomicBool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let start_time = Instant::now();

    let path = Path::new(&args.save_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // FIX #10 (adaptive): use a connection pool exactly sized to thread count.
    // No gzip — we want raw bytes. TCP no-delay prevents Nagle algorithm latency.
    let client = Arc::new(
        reqwest::Client::builder()
            .tcp_keepalive(Duration::from_secs(30))
            .tcp_nodelay(true)
            .no_gzip()
            .pool_max_idle_per_host(args.threads as usize)
            .timeout(Duration::from_secs(120))
            .build()?
    );

    // HEAD request to discover file size
    let head_res = client.head(&args.url).send().await?;
    if !head_res.status().is_success() {
        eprintln!("HEAD failed: {}", head_res.status());
        std::process::exit(1);
    }

    let total_size = match head_res.headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        Some(s) if s > 0 => s,
        _ => { eprintln!("No Content-Length."); std::process::exit(1); }
    };

    // ── FIX #7: Use a sidecar .veloce_done file instead of comparing file size.
    // Pre-allocated files always equal total_size even when empty — this is the
    // only reliable way to know a download truly completed.
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

    let threads = args.threads;
    let chunk_size = total_size / threads;

    let state_file = format!("{}.veloce_state", args.save_path);
    let mut initial_downloads = vec![0u64; threads as usize];
    
    // Resume if file and state exist
    if path.exists() && Path::new(&state_file).exists() {
        if let Ok(content) = std::fs::read_to_string(&state_file) {
            if let Ok(state) = serde_json::from_str::<Vec<u64>>(&content) {
                if state.len() == threads as usize {
                    initial_downloads = state;
                    eprintln!("🔄 Resuming from saved state...");
                }
            }
        }
    } else {
        // If file exists but no valid state, remove and restart
        if path.exists() {
            let existing = std::fs::metadata(&args.save_path)?.len();
            eprintln!("⚠️  Partial file without state ({} / {} bytes). Restarting...", existing, total_size);
            std::fs::remove_file(&args.save_path)?;
        }
        
        // Pre-allocate file to prevent fragmentation
        let file = std::fs::OpenOptions::new()
            .write(true).create(true).truncate(true)
            .open(&args.save_path)?;
        file.set_len(total_size)?;
    }

    println!("{}", json!({
        "type": "info",
        "threads": threads,
        "chunk_size_bytes": chunk_size,
        "total_size_bytes": total_size
    }));

    // ── indicatif multi-progress bars (writes to stderr — bypasses Node.js buffering) ──
    let mp = Arc::new(MultiProgress::new());

    let header_style = ProgressStyle::with_template(
        "{spinner:.cyan} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {bytes}/{total_bytes} | {binary_bytes_per_sec} | ETA {eta}"
    ).unwrap().progress_chars("█▇▆▅▄▃▂▁░");

    let chunk_style = ProgressStyle::with_template(
        " T{prefix:>2} [{bar:16.green/black}] {percent:>3}% {bytes:>8}/{total_bytes}"
    ).unwrap().progress_chars("█░░");

    let header_bar = mp.add(ProgressBar::new(total_size));
    header_bar.set_style(header_style);

    // Per-chunk state + bar
    let chunk_states: Arc<Vec<(Arc<ChunkState>, ProgressBar)>> = Arc::new(
        (0..threads).map(|i| {
            let start = i * chunk_size;
            let end   = if i == threads - 1 { total_size - 1 } else { (i + 1) * chunk_size - 1 };
            let initial = initial_downloads[i as usize];
            let chunk_total = end - start + 1;

            let bar = mp.add(ProgressBar::new(chunk_total));
            bar.set_style(chunk_style.clone());
            bar.set_prefix(format!("{}", i));
            bar.set_position(initial);

            (Arc::new(ChunkState {
                downloaded: AtomicU64::new(initial),
                total:      chunk_total,
                done:       AtomicBool::new(initial == chunk_total),
            }), bar)
        }).collect()
    );

    let global_sum: u64 = initial_downloads.iter().sum();
    let global_dl = Arc::new(AtomicU64::new(global_sum));
    header_bar.set_position(global_sum);
    let mut handles = vec![];

    // Spawn ALL chunks simultaneously as async tasks.
    // tokio multiplexes these over CPU-count OS threads — no OS thread per chunk.
    for i in 0..threads {
        let range_start = i * chunk_size;
        let range_end   = if i == threads - 1 { total_size - 1 } else { (i + 1) * chunk_size - 1 };

        let client    = Arc::clone(&client);
        let url       = args.url.clone();
        let save_path = args.save_path.clone();
        let global_dl = Arc::clone(&global_dl);
        let (state, bar) = {
            let e = &chunk_states[i as usize];
            (Arc::clone(&e.0), e.1.clone())
        };

        handles.push(tokio::spawn(async move {
            let mut retry = 0u8;
            loop {
                let attempt_start = state.downloaded.load(Ordering::Relaxed);
                
                let result = download_chunk(
                    &client, &url, &save_path,
                    range_start, range_end,
                    &global_dl, &state.downloaded, &bar,
                ).await;

                match result {
                    Ok(()) => {
                        state.done.store(true, Ordering::Relaxed);
                        bar.finish_with_message("✓");
                        break;
                    }
                    Err(e) => {
                        retry += 1;
                        if retry >= 5 {
                            bar.abandon_with_message(format!("FAILED: {e}"));
                            break;
                        }
                        
                        let current = state.downloaded.load(Ordering::Relaxed);
                        let failed_bytes = current - attempt_start;
                        state.downloaded.fetch_sub(failed_bytes, Ordering::Relaxed);
                        global_dl.fetch_sub(failed_bytes, Ordering::Relaxed);
                        bar.set_position(attempt_start);

                        eprintln!("[T{i}] retry {retry}/5: {e}");
                        tokio::time::sleep(Duration::from_millis(400 * retry as u64)).await;
                    }
                }
            }
        }));
    }

    // Progress reporter: emits JSON to stdout for Node.js (DB + WebSocket)
    let dl_clone    = Arc::clone(&global_dl);
    let hbar_clone  = header_bar.clone();
    let states_json = Arc::clone(&chunk_states);
    let reporter = tokio::spawn(async move {
        let mut ticker     = tokio::time::interval(Duration::from_millis(500));
        let mut last_bytes = 0u64;
        let mut last_tick  = Instant::now();

        loop {
            ticker.tick().await;

            let current   = dl_clone.load(Ordering::Relaxed);
            let tick_secs = last_tick.elapsed().as_secs_f64();
            // FIX #12: saturating_sub prevents u64 underflow on Relaxed reordering
            let speed_bps = (current.saturating_sub(last_bytes) as f64 / tick_secs) as u64;
            let elapsed   = start_time.elapsed().as_secs_f64();
            let eta_secs  = if speed_bps > 0 {
                ((total_size.saturating_sub(current)) as f64 / speed_bps as f64) as u64
            } else { 0 };

            last_bytes = current;
            last_tick  = Instant::now();

            hbar_clone.set_position(current);

            // Collect per-thread snapshot
            let mut state_arr = vec![0u64; threads as usize];
            let thread_data: Vec<serde_json::Value> = states_json.iter().enumerate().map(|(i, (s, _))| {
                let dl = s.downloaded.load(Ordering::Relaxed);
                state_arr[i] = dl;
                json!({
                    "id": i,
                    "downloaded": dl,
                    "total": s.total,
                    "done": s.done.load(Ordering::Relaxed)
                })
            }).collect();

            // Persist state to disk
            if let Ok(json_str) = serde_json::to_string(&state_arr) {
                let _ = std::fs::write(&state_file, json_str);
            }

            println!("{}", json!({
                "type":         "progress",
                "downloaded":   current,
                "total":        total_size,
                "speed_bps":    speed_bps,
                "elapsed_secs": elapsed,
                "eta_secs":     eta_secs,
                "threads":      thread_data
            }));

            if current >= total_size { break; }
        }
    });

    for handle in handles { let _ = handle.await; }
    let _ = reporter.await;

    header_bar.finish_with_message("✅ Done!");

    let final_dl = global_dl.load(Ordering::SeqCst);
    let elapsed  = start_time.elapsed().as_secs_f64();
    let avg_mbps = (final_dl as f64 / 1_048_576.0) / elapsed;

    println!("{}", json!({"type":"progress","downloaded":final_dl,"total":total_size,"speed_bps":0,"elapsed_secs":elapsed,"eta_secs":0,"threads":[]}));

    if final_dl < total_size {
        eprintln!("✗ Incomplete: {}/{} bytes ({:.1}%)",
            final_dl, total_size,
            (final_dl as f64 / total_size as f64) * 100.0
        );
        std::process::exit(1);
    }

    // On completion, clean up state file
    std::fs::write(&sidecar, "done")?;
    let state_file = format!("{}.veloce_state", args.save_path);
    let _ = std::fs::remove_file(&state_file);

    println!("{}", json!({"type":"done","total":total_size,"elapsed_secs":elapsed,"avg_speed_mbps":avg_mbps}));
    Ok(())
}

async fn download_chunk(
    client: &reqwest::Client,
    url: &str,
    save_path: &str,
    chunk_start: u64,
    chunk_end: u64,
    global_downloaded: &AtomicU64,
    thread_downloaded: &AtomicU64,
    bar: &ProgressBar,
) -> anyhow::Result<()> {
    let already = thread_downloaded.load(Ordering::Relaxed);
    let start = chunk_start + already;
    
    if start > chunk_end {
        return Ok(());
    }

    let res = client
        .get(url)
        .header(RANGE, format!("bytes={}-{}", start, chunk_end))
        .send().await?;

    let status = res.status();
    if !status.is_success() && status.as_u16() != 206 {
        anyhow::bail!("bad status {}", status);
    }

    let file = tokio::fs::OpenOptions::new()
        .write(true).open(save_path).await?;

    // 2MB buffer — batches small writes into large OS syscalls
    let mut writer = BufWriter::with_capacity(2 * 1024 * 1024, file);
    writer.seek(SeekFrom::Start(start)).await?;

    use futures::StreamExt;
    let mut stream = res.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        writer.write_all(&bytes).await?;
        let n = bytes.len() as u64;
        global_downloaded.fetch_add(n, Ordering::Relaxed);
        thread_downloaded.fetch_add(n, Ordering::Relaxed);
        bar.inc(n);
    }

    writer.flush().await?;
    Ok(())
}
