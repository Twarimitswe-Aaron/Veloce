//! Integration test: local HTTP server + full engine download (cross-platform).

use core_engine::args::EngineArgs;
use core_engine::run_download;
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::convert::Infallible;
use std::fs;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const BODY: &[u8] = b"0123456789abcdef0123456789abcdef";

fn allow_loopback_for_tests() {
    // Engine blocks private/loopback by default; local fixture servers need an opt-in.
    std::env::set_var("VELOCE_ALLOW_LOCAL_URLS", "1");
}

async fn range_handler(req: Request<hyper::body::Incoming>) -> Result<Response<Full<Bytes>>, Infallible> {
    let path = req.uri().path();
    if path != "/file.bin" {
        return Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Full::new(Bytes::new()))
            .unwrap());
    }

    if req.method() == hyper::Method::HEAD {
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("Content-Length", BODY.len())
            .header("Accept-Ranges", "bytes")
            .body(Full::new(Bytes::new()))
            .unwrap());
    }

    let range = req
        .headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if let Some(spec) = range.strip_prefix("bytes=") {
        let parts: Vec<&str> = spec.split('-').collect();
        if parts.len() == 2 {
            let start: usize = parts[0].parse().unwrap_or(0);
            let end: usize = if parts[1].is_empty() {
                BODY.len() - 1
            } else {
                parts[1].parse().unwrap_or(BODY.len() - 1)
            };
            let slice = &BODY[start..=end.min(BODY.len() - 1)];
            return Ok(Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header("Content-Range", format!("bytes {}-{}/{}", start, end, BODY.len()))
                .header("Content-Length", slice.len())
                .body(Full::new(Bytes::copy_from_slice(slice)))
                .unwrap());
        }
    }

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("Content-Length", BODY.len())
        .body(Full::new(Bytes::copy_from_slice(BODY)))
        .unwrap())
}

#[tokio::test]
async fn integration_download_with_ranges() {
    allow_loopback_for_tests();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        let mut shutdown_rx = shutdown_rx;
        loop {
            tokio::select! {
                accept = listener.accept() => {
                    let (stream, _) = accept.unwrap();
                    let io = TokioIo::new(stream);
                    tokio::spawn(async move {
                        let _ = http1::Builder::new()
                            .serve_connection(io, service_fn(range_handler))
                            .await;
                    });
                }
                _ = &mut shutdown_rx => break,
            }
        }
    });

    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out.bin");
    let url = format!("http://{addr}/file.bin");

    let args = EngineArgs {
        id: "test".into(),
        url,
        save_path: out.to_string_lossy().into(),
        threads: 4,
        max_rate: 0,
        quiet: true,
        referer: None,
        origin: None,
        piece_size_bytes: 8,
        read_buffer_bytes: 4096,
        auto_tune: false,
        no_auto_tune: false,
        no_stagger: true,
        profiles_path: None,
        base_dir: None,
    };

    run_download(args).await.unwrap();
    let data = fs::read(&out).unwrap();
    assert_eq!(data, BODY);

    let _ = shutdown_tx.send(());
    server.abort();
}

#[tokio::test]
async fn integration_auto_tune_and_stagger() {
    allow_loopback_for_tests();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let io = TokioIo::new(stream);
            tokio::spawn(async move {
                let _ = http1::Builder::new()
                    .serve_connection(io, service_fn(range_handler))
                    .await;
            });
        }
    });

    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out2.bin");
    let args = EngineArgs {
        id: "test2".into(),
        url: format!("http://{addr}/file.bin"),
        save_path: out.to_string_lossy().into(),
        threads: 4,
        max_rate: 0,
        quiet: true,
        referer: None,
        origin: None,
        piece_size_bytes: 0,
        read_buffer_bytes: 8192,
        auto_tune: true,
        no_auto_tune: false,
        no_stagger: false,
        profiles_path: None,
        base_dir: None,
    };

    run_download(args).await.unwrap();
    assert_eq!(fs::read(&out).unwrap(), BODY);
}
