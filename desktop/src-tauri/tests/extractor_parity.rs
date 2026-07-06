mod common;

use veloce_desktop_lib::formats::{
    detect_source, instagram_url_variants, is_direct_file_url, is_extractor_domain,
    is_manifest_format_url, normalize_url, MediaFormat, MediaSource,
};
use veloce_desktop_lib::ytdlp;

/// Parity with backend/tests/extractor.test.ts and formatSources.test.ts.
#[test]
fn backend_parity_direct_file_detection() {
    assert!(is_direct_file_url("https://cdn.example.com/video.mp4"));
    assert!(is_direct_file_url("https://x.com/a/b/song.mp3?token=1"));
    assert!(is_direct_file_url(
        "https://download2393.mediafire.com/abc/key/movie.mp4"
    ));
    assert!(!is_direct_file_url("https://example.com/watch?v=abc"));
    assert!(!is_direct_file_url("https://www.mediafire.com/file/key/name"));
    assert!(!is_direct_file_url("https://github.com/o/r/blob/main/file.xml"));
}

#[test]
fn backend_parity_normalize_youtube_and_instagram() {
    assert_eq!(
        normalize_url("https://www.youtube.com/watch?v=abc123&list=PLx"),
        "https://www.youtube.com/watch?v=abc123"
    );
    assert_eq!(
        normalize_url("https://youtu.be/abc123"),
        "https://www.youtube.com/watch?v=abc123"
    );
    assert_eq!(
        normalize_url("https://www.instagram.com/reel/AbCd/?igsh=1"),
        "https://www.instagram.com/reel/AbCd"
    );
}

#[test]
fn backend_parity_detect_media_source() {
    assert_eq!(
        detect_source("https://www.youtube.com/watch?v=x"),
        MediaSource::YouTube
    );
    assert_eq!(
        detect_source("https://www.instagram.com/reel/AbCd/"),
        MediaSource::Instagram
    );
    assert_eq!(
        detect_source("https://www.tiktok.com/@u/video/1"),
        MediaSource::TikTok
    );
    assert_eq!(
        detect_source("https://cdn.example.com/v.mp4"),
        MediaSource::Direct
    );
}

#[test]
fn backend_parity_youtube_picker() {
    let raw = vec![
        MediaFormat {
            id: "137".into(),
            label: "Song — 1920x1080 webm · 200 MB".into(),
            url: "https://v.example/v".into(),
            ext: ".webm".into(),
            filesize: Some(200_000_000),
            source: None,
            kind: Some("progressive".into()),
        },
        MediaFormat {
            id: "18".into(),
            label: "Song — 640x360 video+audio mp4 · 11 MB".into(),
            url: "https://v.example/p".into(),
            ext: ".mp4".into(),
            filesize: Some(11_000_000),
            source: None,
            kind: Some("progressive".into()),
        },
        MediaFormat {
            id: "140".into(),
            label: "Song — audio only m4a".into(),
            url: "https://v.example/a".into(),
            ext: ".m4a".into(),
            filesize: None,
            source: None,
            kind: Some("progressive".into()),
        },
    ];
    let out = ytdlp::finalize_youtube_picker(raw);
    assert_eq!(out[0].id, "best");
    assert!(out.iter().any(|f| f.id == "18"));
    assert!(!out.iter().any(|f| f.id == "137"));
    assert!(!out.iter().any(|f| f.id == "140"));
}

#[test]
fn instagram_variants_cover_reel_and_post() {
    let v = instagram_url_variants("https://www.instagram.com/reel/XYZ789/");
    assert!(v.iter().any(|u| u.contains("/p/XYZ789")));
    assert!(v.iter().any(|u| u.contains("/reel/XYZ789")));
}

#[test]
fn extractor_domains_and_manifests() {
    assert!(is_extractor_domain("https://www.youtube.com/watch?v=x"));
    assert!(!is_extractor_domain("https://example.com/a.mp4"));
    assert!(is_manifest_format_url("https://cdn.example.com/stream.m3u8?sig=1"));
    assert!(!is_manifest_format_url("https://googlevideo.com/videoplayback?id=1"));
}

#[tokio::test]
async fn download_list_formats_direct_and_github_paths() {
    let state = common::test_app_state();
    let direct = veloce_desktop_lib::download::list_formats_for_url(
        &state,
        "https://files.example.org/archive.7z",
        false,
    )
    .await
    .expect("direct");
    assert_eq!(direct.len(), 1);
    assert_eq!(direct[0].ext, ".7z");

    let gh = veloce_desktop_lib::download::list_formats_for_url(
        &state,
        "https://github.com/veloce/veloce/blob/main/README.md",
        false,
    )
    .await
    .expect("github");
    assert!(gh[0].url.contains("raw.githubusercontent.com"));
}
