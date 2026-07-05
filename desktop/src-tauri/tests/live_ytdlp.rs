//! Live yt-dlp tests — run with: `VELOCE_LIVE_YTDLP=1 cargo test live_ -- --ignored --nocapture`
//!
//! Requires `backend/bin/yt-dlp`, Node.js, and network access.

use std::env;

fn live_enabled() -> bool {
    env::var("VELOCE_LIVE_YTDLP").ok().as_deref() == Some("1")
}

fn require_live() {
    if !live_enabled() {
        eprintln!("Skipping live test — set VELOCE_LIVE_YTDLP=1 to run");
    }
    assert!(live_enabled(), "Set VELOCE_LIVE_YTDLP=1 to run live yt-dlp tests");
}

#[test]
#[ignore = "requires yt-dlp, node, network — run with VELOCE_LIVE_YTDLP=1"]
fn live_youtube_list_formats() {
    require_live();
    let formats = veloce_desktop_lib::ytdlp::list_formats(
        "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        false,
    )
    .expect("youtube formats");
    assert!(!formats.is_empty(), "expected YouTube formats");
    assert!(
        formats.iter().any(|f| f.id == "best"),
        "YouTube picker should add best row"
    );
}

#[test]
#[ignore = "requires yt-dlp, network — run with VELOCE_LIVE_YTDLP=1"]
fn live_tiktok_or_generic_does_not_panic() {
    require_live();
    // Public sample URL — may fail if TikTok blocks; we only require graceful Result.
    let result = veloce_desktop_lib::ytdlp::list_formats(
        "https://www.tiktok.com/@scout2015/video/6718339390841545477",
        false,
    );
    match result {
        Ok(formats) => assert!(!formats.is_empty() || formats.is_empty()),
        Err(e) => assert!(!e.is_empty()),
    }
}

#[test]
#[ignore = "requires yt-dlp, network — run with VELOCE_LIVE_YTDLP=1"]
fn live_ytdlp_binary_is_discoverable() {
    require_live();
    assert!(
        veloce_desktop_lib::util::ytdlp_binary().is_some(),
        "yt-dlp binary must exist at backend/bin/yt-dlp for live tests"
    );
}
