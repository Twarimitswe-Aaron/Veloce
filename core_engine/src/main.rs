use clap::Parser;
use reqwest::header::{ACCEPT_RANGES, CONTENT_LENGTH, RANGE};
use serde_json::json;
use std::io::SeekFrom;
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;
use std::time::Duration;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(long)]
    id: String,

    #[arg(long)]
    url: String,

    #[arg(long)]
    save_path: String,

    #[arg(long, default_value_t = 4)]
    threads: u8,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    
    // Ensure parent directory exists
    let path = Path::new(&args.save_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let client = reqwest::Client::new();
    
    // HEAD request to get file size
    let head_res = client.head(&args.url).send().await?;
    if !head_res.status().is_success() {
        eprintln!("Failed to fetch URL headers: {}", head_res.status());
        std::process::exit(1);
    }
    
    let content_length = head_res
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|val| val.to_str().ok())
        .and_then(|val| val.parse::<u64>().ok());

    let total_size = match content_length {
        Some(size) => size,
        None => {
            eprintln!("Unknown content length, falling back to single thread.");
            // For unknown size, just download normally (stubbed for now)
            std::process::exit(1);
        }
    };

    // Pre-allocate file
    let file = std::fs::File::create(&args.save_path)?;
    file.set_len(total_size)?;

    // Start download tasks
    let chunk_size = total_size / (args.threads as u64);
    let mut handles = vec![];
    
    let downloaded_bytes = Arc::new(Mutex::new(0u64));
    
    for i in 0..args.threads {
        let start = i as u64 * chunk_size;
        let end = if i == args.threads - 1 {
            total_size - 1
        } else {
            (i as u64 + 1) * chunk_size - 1
        };

        let client = client.clone();
        let url = args.url.clone();
        let save_path = args.save_path.clone();
        let downloaded_bytes = Arc::clone(&downloaded_bytes);

        handles.push(tokio::spawn(async move {
            let res = client
                .get(&url)
                .header(RANGE, format!("bytes={}-{}", start, end))
                .send()
                .await
                .unwrap();

            let mut stream = res.bytes_stream();
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .open(&save_path)
                .await
                .unwrap();

            file.seek(SeekFrom::Start(start)).await.unwrap();

            use futures::StreamExt;
            while let Some(chunk) = stream.next().await {
                if let Ok(bytes) = chunk {
                    file.write_all(&bytes).await.unwrap();
                    let mut dl = downloaded_bytes.lock().await;
                    *dl += bytes.len() as u64;
                }
            }
        }));
    }

    // Progress reporter task
    let dl_bytes_clone = Arc::clone(&downloaded_bytes);
    let reporter = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let current = *dl_bytes_clone.lock().await;
            println!("{}", json!({
                "type": "progress",
                "downloaded": current,
                "total": total_size
            }));
            
            if current >= total_size {
                break;
            }
        }
    });

    for handle in handles {
        let _ = handle.await;
    }
    
    let _ = reporter.await;

    // Final emit
    println!("{}", json!({
        "type": "progress",
        "downloaded": total_size,
        "total": total_size
    }));

    Ok(())
}
