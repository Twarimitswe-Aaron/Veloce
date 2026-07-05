# Veloce Session Documentation

**Date:** July 5, 2026
**Session Goal:** Build Tauri Native Desktop App (Phase 3) + Pipeline Optimizations

---

## Overview

This session involved two major work streams:

### Stream 1: Pipeline Performance Optimizations

Applied to the existing Node.js backend + Rust core_engine:

| Change | File | Impact |
|--------|------|--------|
| **HTTP/2 multiplexing** | `core_engine/src/discover.rs` | Removed `.http1_only()`. reqwest now negotiates HTTP/2 via ALPN. Multiple range-request workers share one TLS connection instead of each opening a separate TCP+TLS connection. |
| **HTTP/2 keepalive** | `core_engine/src/discover.rs` | Added `http2_keep_alive_interval(30s)` + `http2_keep_alive_timeout(5s)`. Detects dead connections during long downloads instead of hanging indefinitely. |
| **bestUrlCache** | `backend/src/lib/server/extractor.ts` | Caches direct URLs from yt-dlp `-f b -g` with 10min TTL (5min for Instagram). Eliminates duplicate yt-dlp invocations when pause/resume or playlist tracks share a host. |
| **Instagram eager prefetch** | `extension/static/sites/instagram.js` | `processPostPage()`, `processReelsViewer()`, `processStoryViewer()` now call `ctx.eagerPrefetch(url)` immediately on page load. Previously, Instagram only prefetched on badge click. |
| **Badge initial state** | `extension/static/content.js` | Badges no longer start as `badge-ready` (falsely showing "formats ready" dot). Now `badge-ready` is added only after `markBadgeReady()` fires. |
| **Instagram prefetch in shouldPrefetchUrl** | `extension/static/sites/instagram.js` | Added Stories support to `shouldPrefetchUrl()` so `prefetchPageUrls` doesn't block it. |

### Stream 2: Tauri Native Desktop App (Phase 3)

Complete Rust coordinator rewrite inside a Tauri 2 shell with Svelte 5 frontend.

#### Architecture

```
desktop/
├── package.json              # Svelte 5 + Vite 6 + @tauri-apps/api
├── vite.config.ts            # Vite config for Svelte
├── svelte.config.js          # Svelte 5 config
├── index.html                # Entry HTML
├── tsconfig.json             # TypeScript config
├── src/
│   ├── main.ts               # Frontend entry
│   ├── app.css               # Global styles (Veloce design tokens)
│   └── App.svelte            # Main UI: Dashboard, History, Settings tabs
└── src-tauri/
    ├── Cargo.toml            # Rust deps (tauri 2, tokio, rusqlite, reqwest)
    ├── build.rs              # Tauri build script
    ├── tauri.conf.json       # Window config, bundle settings, icons
    ├── capabilities/
    │   └── default.json      # Permissions
    ├── icons/
    │   ├── 32x32.png
    │   ├── 128x128.png
    │   └── 128x128@2x.png
    └── src/
        ├── main.rs           # Binary entry
        ├── lib.rs            # Tauri commands + app builder
        ├── config.rs         # Environment-based configuration
        ├── db.rs             # SQLite schema + CRUD (rusqlite bundled)
        ├── engine.rs         # Core engine process management
        ├── formats.rs        # Media source detection, MediaFire resolver, FormatCache
        ├── scheduler.rs      # Download FIFO queue with concurrency cap
        ├── state.rs          # Shared app state: engines, progress, cancellation flags
        ├── util.rs           # Binary discovery, path helpers, filename sanitization
        └── ytdlp.rs          # yt-dlp format listing and best URL extraction
```

#### Tauri Commands (Rust → Frontend IPC)

| Command | Input | Output | Description |
|---------|-------|--------|-------------|
| `list_formats` | url, force? | Vec<MediaFormat> | List available formats for a URL |
| `start_download` | url, direct_url?, file_name, referer? | download_id | Start engine download, return ID |
| `cancel_download` | id | () | Set cancellation flag + kill engine |
| `pause_download` | id | () | Kill engine (state file preserved) |
| `get_statuses` | — | Vec<DownloadStatus> | Active downloads snapshot |
| `get_history` | — | Vec<DownloadRow> | Last 50 completed/failed downloads |
| `get_settings` | — | JSON | Device settings |
| `update_settings` | settings | () | Persist settings |
| `get_config` | — | JSON | Runtime configuration |

#### Tauri Events (Rust → Frontend)

| Event | Payload | Frequency |
|-------|---------|-----------|
| `download-progress` | ProgressEvent (id, downloaded, total, speed, eta, pct) | ~1/s during download |
| `download-status` | StatusEvent (id, status, error?) | On completion/failure/cancel |

#### Engine Lifecycle (Key Design)

1. `start_download` spawns the core_engine process, inserts into `active_engines`
2. Cancellation flag (`Arc<AtomicBool>`) stored in separate `cancellation_flags` map
3. Monitoring thread (`std::thread::spawn`) takes ownership, calls `engine.wait()`
4. After `wait()` returns, checks cancellation flag → "cancelled" vs "completed"/"failed"
5. `cancel_download` sets flag + kills child (if still in `active_engines`)
6. Engine removed from `active_engines` only after `wait()` returns or in `remove_active()`

#### Platform Independence

- All Rust code uses standard library + cross-platform crates
- Binary path resolution: `std::env::current_exe()` → sibling dirs → PATH
- SQLite via `rusqlite` with `bundled` feature (no system SQLite needed)
- Frontend uses Tauri IPC (`invoke` + `listen`), no WebSocket dependency
- Tauri 2 handles GTK/WebKitGTK on Linux, WebView2 on Windows, WKWebView on macOS
- Icons: PNG format (cross-platform), SVG source available for custom builds

---

## Critical Fixes Applied

| Issue | Fix |
|-------|-----|
| `env!("CARGO_MANIFEST_DIR")` compile-time path | Runtime resolution via `util::find_core_engine()` and `util::find_ytdlp()` using `current_exe()` first |
| `Box::leak` memory leak in playlist parser | Changed to return owned `String` directly |
| Duplicate `MediaFormat` types (ytdlp.rs + formats.rs) | ytdlp.rs re-exports `crate::formats::MediaFormat` via `pub use` |
| Regex recompilation on every call | `once_cell::sync::Lazy<Regex>` in formats.rs |
| Engine removed from map before `wait()` (race with cancel) | Cancellation flags map + AtomicBool check after wait |
| `Handle::current()` panic in `spawn_blocking` | Capture handle before spawn, pass to thread |
| `tokio::sync::Mutex` used in blocking thread | Changed `active_engines` to `std::sync::Mutex` |
| `blocking_lock()` called from async context | Changed `track_download` to `async fn` with `.lock().await` |
| Scheduler `job` moved before log | Clone `id` and `len` before push |
| Missing PNG icons for Tauri bundle | Generated valid 32x32, 128x128, 256x256 RGBA PNGs |

---

## Performance Optimizations Summary

| Optimization | Estimated Impact | Complexity |
|-------------|-----------------|------------|
| HTTP/2 multiplexing | **High**: N workers share 1 TLS connection | 1 line removed |
| HTTP/2 keepalive | **Medium**: Detect dead connections faster | 2 lines added |
| bestUrlCache | **Medium**: Skip yt-dlp on duplicate URLs | 30 lines, low risk |
| Instagram eager prefetch | **High**: Save 10-30s per Instagram page load | 6 lines per handler |
| Badge initial state fix | **Low**: Correct loading indicator UX | 2 characters |

---

## TODO / Future Work

- [ ] `pnpm approve-builds esbuild` in desktop/ to suppress warning
- [ ] Add unit tests for desktop Rust modules (especially engine lifecycle + cancellation)
- [ ] Add e2e test for Tauri commands via `tauri::test::mock_builder()`
- [ ] Clean up 26 compiler warnings (unused imports, dead code)
- [ ] Store `_reader_handle` JoinHandle in EngineProcess to join on shutdown
- [ ] Implement WebSocket server in desktop app for backward compat with browser extension
- [ ] Wire up progress reader thread to emit `download-progress` Tauri events
- [ ] Build Release mode: `cargo build --release` + bundle with `pnpm tauri build`
