# ⚡ Veloce: Advanced Multi-Threaded Download Manager

Veloce is a **local-first download manager** for people who want IDM-style speed with modern web capture. A Chrome extension finds downloadable media on the page you are viewing, a Node coordinator on your machine resolves formats (via yt-dlp and site-specific logic), and a Rust engine downloads files with multi-connection segmentation, resume, and corruption guards.

Everything runs on **your PC** — no cloud queue, no account, no subscription.

---

## Overview

| Piece | What it does |
|-------|----------------|
| **Browser extension** | Badges links and videos on the **active tab**, opens a format picker, intercepts browser downloads when the coordinator is online |
| **Local coordinator** (`backend/` or **`desktop/`**) | WebSocket on `localhost:14921`, SQLite queue, yt-dlp, engine spawn. Use **one** at a time — not both. |
| **Rust engine** (`core_engine/`) | Segmented HTTP download with work-stealing pieces, adaptive threads, crash-safe resume |

**Typical flow:** browse → click Veloce badge → pick quality → file lands in `~/Downloads/Veloce` (or your chosen folder) with live speed/ETA in the popup or dashboard.

## Getting Started

1. **Install:** Run `./scripts/setup.sh` to install dependencies, build the core engine, and set up the systemd services.
2. **Manage Processes:** Use the installed `veloce` CLI to control the background services:

```bash
veloce start            # Start backend coordinator (auto-starts on login)
veloce start --desktop  # Start Tauri desktop app
veloce status           # Check what's running
veloce stop --all       # Stop everything
```

3. **Load the Extension:** Go to `chrome://extensions`, enable Developer Mode, click "Load unpacked", and select `extension/build`.

---

## Why Veloce vs other download managers

| Advantage | What it means for you |
|-----------|----------------------|
| **Work-stealing segmentation** | Fast connections keep working while slow ones catch up — no fixed “slow last chunk” like classic IDM splits |
| **Adaptive concurrency** | Thread count goes **down** on errors and **back up** when the server recovers |
| **Corruption-aware engine** | Rejects servers that ignore HTTP Range (`200` instead of `206`), validates ETag on resume |
| **Modern web capture** | Per-site handlers for YouTube SPA, Instagram Reels, MediaFire delays, API-driven sites (MovieBox/OmniSave) |
| **yt-dlp integration** | One-click quality pick for social video without manual copy-paste |
| **Local + open stack** | Rust engine + SvelteKit coordinator you can inspect, patch, and extend |
| **Security defaults** | WebSocket origin allowlist, SSRF blocking for private IPs, safe filename paths |
| **No vendor lock-in** | Not tied to a proprietary protocol or paid capture layer |

See the full feature comparison table in [How Veloce compares](#-how-veloce-compares-to-other-download-managers) below.

---

## Limitations & honest drawbacks

Veloce is young software. Know these trade-offs before you rely on it for everything.

| Limitation | Detail |
|------------|--------|
| **Local setup required** | You must run the background coordinator via `veloce start` or the desktop app via `veloce start --desktop`. (They share port 14921, do not run both at once). |
| **Chrome-first** | The extension targets Chromium Manifest V3. Firefox support is not a primary focus today. |
| **yt-dlp dependency** | YouTube, Instagram, TikTok, and many social sites need `yt-dlp` installed and occasionally updated when sites change. |
| **Login-gated content** | Private or age-gated media only works if yt-dlp can use your browser cookies (Chrome profile). |
| **Site breakage is normal** | SPAs change DOM constantly. A site update can hide badges or break format listing until a handler patch lands. |
| **Active tab only** | Badges and prefetch intentionally run on the **focused tab** — not every background tab (by design, for performance). |
| **No BitTorrent / Metalink** | HTTP(S) focus only; torrents are out of scope for now. |
| **No proxy / auth downloads yet** | HTTP proxy and authenticated origins are on the roadmap. |
| **No checksum verification yet** | SHA-256 / Metalink verification is planned but not shipped. |
| **Extension reload friction** | After updating the extension, open tabs may need a refresh (active tab auto re-injects on update in v1.8.1+). |

If you hit a site-specific problem, that is expected — **contributions fixing one site help everyone**. See [Contributing](#-contributing).

---

## Contributing

We need help when:

- A **page behaves differently** (new layout, SPA navigation, modal download UI)
- **Format listing fails** for a host yt-dlp used to support
- **Downloads are slow, corrupt, or 403** for a specific CDN
- **Documentation** or setup scripts could be clearer

**Quick start for contributors:**

1. Fork / clone, run `./scripts/setup.sh`
2. Read **[CONTRIBUTING.md](./CONTRIBUTING.md)** — reporting bugs, which file to edit, site handler patterns
3. For format/extraction deep dives, see **[AGENTS.md](./AGENTS.md)** — platform signatures, cache rules, DOM tables
4. Open a PR with a test URL, before/after notes, and tests if you touch `backend/` or `core_engine/`

**Most common fix:** add or update a file under `extension/static/sites/` when badges or navigation break on one website.

---

Veloce bypasses browser restrictions by splitting operations into three distinct, decoupled layers.

## 🏗️ System Architecture

### 1. `extension/` (Browser Extension)
*   **Tech Stack:** Svelte 5, Manifest V3
*   **Role:** Popup UI **and** in-page capture. A **content script** scans every page for downloadable links, videos, and audio — placing a floating **Veloce** badge on each. Clicking a badge opens a **format picker** (yt-dlp for video sites, direct link otherwise); choosing a format starts the download immediately. When the Local Coordinator is online, **native browser downloads are intercepted** and routed to Veloce instead.
*   **How it talks:** A persistent **background service worker** owns the WebSocket to `ws://localhost:14921/ws`. The popup and content script message the background; progress is broadcast to any open popup.

### 2. `backend/` (Local Coordinator)
*   **Tech Stack:** SvelteKit (Node.js full-stack), Drizzle ORM, libSQL/SQLite
*   **Role:** The native coordinator that runs on your PC. It receives download payloads from the extension, normalizes/categorizes them, resolves media URLs (yt-dlp / Mediafire), persists the queue and history in SQLite, and spawns the Rust engine.
*   **How it works:** A **global scheduler** caps how many engine processes run at once (default **10**, configurable via `.env`). Additional jobs queue FIFO — you can queue **100+ downloads**; they start as slots free up. Each engine is a **child process**; coordinator crash recovery re-queues interrupted jobs on restart.

### 3. `core_engine/` (Rust Core)
*   **Tech Stack:** Rust 0.2.0, Tokio, Reqwest, Crossbeam
*   **Role:** The heavy lifter. A standalone executable invoked by the coordinator. It performs segmented byte-range downloads with a **lock-free work-stealing** piece queue, adaptive concurrency, idle-stall detection, and crash-safe resume — writing directly to disk at maximum speed.
*   **Layout:** Modular library (`file_io`, `piece`, `profiles`, `probe`, `adaptive`, `resume`, `discover`, `download`, `engine`) plus a thin `main.rs` CLI. See `core_engine/src/lib.rs`.

## 📚 Learning Concepts Explained

### WebSockets vs Native Messaging
To let the browser extension talk to your computer's native file system, we use **WebSockets**. The Local Coordinator runs a tiny server on your PC at `ws://localhost:14921/ws`. The browser extension simply connects to this address. It's much easier to set up than "Native Messaging" (which requires hacking the OS registry).

### Child Process
Instead of compiling the complex Rust Engine into a JavaScript module (FFI), the SvelteKit backend runs the compiled Rust executable (`veloce_core.exe`) exactly like you would run a command in the terminal. This is called spawning a **Child Process**. If the Rust engine crashes due to a bad network request, your SvelteKit dashboard stays safely alive and can restart it.

### Multi-Threading (Tokio)
The Rust engine first probes whether the server honors HTTP range requests. If it does, the file is divided into **adaptive pieces** (typically 1–16 MiB, tuned per host and file size) placed on a shared queue. `Tokio` runs one async worker per connection; each worker repeatedly claims the next pending piece and writes it at the correct file offset. Because workers pull work dynamically, a slow connection never holds up the others — there is no fixed per-thread "tail". Every sub-range response is verified to be `206 Partial Content`; a `200` (server silently ignoring `Range`) is rejected so the full body can never be written over a piece offset and corrupt the file.

## 🚀 Performance & Reliability (implemented)

### Engine (`core_engine/`)
*   **Dynamic work-stealing segmentation** — 4 MiB pieces on a lock-free `crossbeam` queue. Claiming a piece, accounting bytes, and marking completion are all **O(1)**. Fast connections naturally download more pieces; slow ones download fewer.
*   **Adaptive concurrency** — starts at the requested connection count, **halves** on connection errors to ease server pressure, and **ramps back up** to the ceiling after sustained success (most managers only ratchet down).
*   **Range-support probe** — sends a `bytes=0-0` probe; if the server ignores ranges it transparently falls back to a single connection (prevents multi-connection file corruption).
*   **Robust size discovery** — tries `HEAD`, then falls back to a 1-byte ranged `GET` (reading `Content-Range`/`Content-Length`). This makes signed/CDN URLs that don't answer `HEAD` with a length — e.g. Instagram/fbcdn — downloadable.
*   **Browser User-Agent** — sends a realistic Chrome UA so CDNs that reject default library agents with `403` are handled.
*   **Idle-stall timeout** — a piece is aborted only if **no bytes arrive for 30 s**, never on a total-time deadline, so legitimately slow transfers are not killed.
*   **Crash-safe resume** — a `.veloce_state` sidecar stores a per-piece completion bitmap plus the server's `ETag`/`Last-Modified`. On restart only the missing pieces are fetched; if the file changed server-side the resume is rejected to avoid corruption. A `.veloce_done` sidecar marks true completion.
*   **Real preallocation** — `posix_fallocate` reserves disk blocks up front (falls back to `set_len`), so a full disk fails fast and fragmentation is reduced.
*   **Size-aware disk guard** — after discovering the content length, the engine checks free space via `statvfs` (walking up to the nearest existing dir) and emits a clean `fatal` message *before writing a byte* if the file won't fit.
*   **Anti-corruption range check** — a sub-range that returns `200` instead of `206` is treated as a failure (the server ignored `Range`), and `416 Range Not Satisfiable` aborts the piece (the file likely changed) — both prevent stitching mismatched bytes.
*   **Backpressure-aware backoff** — `429`/`503` responses honor the `Retry-After` header (capped at 10 s) before retrying, instead of hammering a rate-limited origin.
*   **Bandwidth cap** — an optional global **token-bucket rate limiter** (`--max-rate`, bytes/sec) throttles *aggregate* throughput across all connections, so Veloce can share a link politely (a classic IDM feature).
*   **Atomic resume state** — `.veloce_state` is written to a temp file and `rename`d into place, so a crash mid-write can never leave a truncated state that defeats resume.
*   **Tuned transport** — HTTP/1.1-only, no gzip, TCP nodelay, keep-alive, per-host pool sized to the connection count, configurable read buffer (default 256 KiB).
*   **Shared file + positioned writes** — one preallocated file; cross-platform `pwrite` / `seek_write` (Unix/Windows) instead of open+seek per piece.
*   **Adaptive piece size** — 1–16 MiB based on file size and host profile (MediaFire 8 MiB, googlevideo 4 MiB, etc.).
*   **Auto-tune connections** — short probe picks 2–16 threads before the main download (`--no-auto-tune` to disable).
*   **Per-host profiles** — built-in + optional JSON (`--profiles-path`); see `core_engine/host_profiles.example.json`.
*   **AIMD adaptive concurrency** — additive increase on success, multiplicative decrease on transient errors; permanent errors drop to 1 connection.
*   **Staggered worker start** — 75 ms between connections to avoid burst throttling (`--no-stagger`).
*   **Binary resume state** — compact bitmap in `.veloce_state` (legacy JSON still loads); persisted every 2 s or on piece completion.
*   **Release profile** — thin LTO + `codegen-units = 1` for faster binary.

### Coordinator (`backend/`)
*   **Global download scheduler** — caps concurrent engine processes (default **10**); extra jobs queue FIFO and start as slots free.
*   **Shared engine CLI builder** — `engineCli.ts` centralizes `core_engine` spawn arguments (`--read-buffer-bytes`, `--no-auto-tune`, referer/origin) for both single downloads and playlist jobs.
*   **Media resolution with cookie fallback** — resolves direct URLs via yt-dlp, trying Chrome → Firefox → no-cookies, so login-gated, extension-less links (e.g. Instagram reels) resolve to a single progressive `mp4`.
*   **Completion cleanup** — once a download is recorded `completed` in the DB, the engine's `.veloce_done`/`.veloce_state` markers are permanently removed (unlinked, not sent to trash) to keep the download folder clean.
*   **Fail-closed safety** — aborts (instead of downloading page HTML) when media-URL extraction fails, and aborts when free disk space can't be verified.
*   **No stuck rows** — handles spawn (`ENOENT`) and exit via a single-settle guard; every job ends as `completed` or `error`.
*   **Smart dedup** — dedup is keyed on the **source URL**; a `completed` download is only skipped if its bytes still exist on disk, and deleted files can be re-fetched.
*   **Filename collision auto-rename** — a new download that would overwrite an unrelated existing file/row is renamed `name (1).ext`, `name (2).ext`, … instead of clobbering it.
*   **Crash recovery / reconciliation** — on startup the coordinator re-queues any download left `downloading`/`queued` from a previous run; the engine resumes it from `.veloce_state`.
*   **Pause / Resume / Cancel / Remove** — live control of in-flight jobs. Pausing `SIGTERM`s the engine (state preserved); resuming re-launches and resumes; for video sites the direct URL is **re-extracted on resume** so expired CDN links are refreshed.
*   **Open file / Reveal in folder** — completed downloads can be opened (`xdg-open`) or highlighted in the file manager (`org.freedesktop.FileManager1`, falling back to opening the folder).
*   **Live runtime settings** — max concurrent downloads, default connections, global speed cap, base directory and quiet-engine mode are editable from the popup / dashboard, persisted per-device and applied without a restart.
*   **Playlist expansion** — a URL flagged as a playlist is expanded via `yt-dlp --flat-playlist` and each entry is queued as its own download.
*   **Quiet engine** — the coordinator launches the engine with `--quiet` so many concurrent downloads don't garble the terminal (machine-readable JSON progress is unaffected).
*   **Broadcast model** — progress is broadcast to all connected popups (and to a popup that connects *after* a download started, e.g. a reconciled one), not tied to one socket.
*   **Resilient folder picker** — tries `zenity`, then `kdialog`, and reports when neither is available.

### Extension (`extension/`)
*   **Site handler registry** — per-site modules under `extension/static/sites/` (`youtube.js`, `instagram.js`, `mediafire.js`, `omnisave.js`) register via `registry.js` and are loaded before `content.js`.
*   **YouTube watch / SPA** — badges on the main `#movie_player` video; `v=` URL changes (sidebar click, autoplay) reset badges and prefetch focus; radio/mix `list=RD…` stripped to `watch?v=ID`; sidebar prefetch disabled on watch pages.
*   **Instagram Reels** — prefetch starts when a reel begins playing; scroll switches focus to the new reel while keeping the previous reel cached (2-slot window); `/reels/ID` normalized to `/reel/ID`.
*   **MediaFire file pages** — badges on `mediafire.com/file/…/file` (polls for the download button after "Preparing Download").
*   **In-page capture** — content script badges every downloadable `<a>`, `<video>`, `<audio>`, and video/social page; format picker via `LIST_FORMATS` (yt-dlp JSON).
*   **Download interception** — `chrome.downloads.onCreated` cancels native downloads when coordinator is online (toggle in popup).
*   **Persistent background WS** — service worker keeps the connection alive when popup is closed.
*   **Live progress UI** — navy/white popup with queue, speed, ETA, pause/resume/cancel, and open/reveal for finished files.
*   **State rehydration** — snapshot on connect survives popup reload.
*   **Desktop notifications** — a system notification fires when a download completes, fails, or a playlist is queued.
*   **Context menu** — right-click a link, image, video or audio element → *Download with Veloce*; or *Download all media links on page* (scans anchors via `chrome.scripting`).
*   **Settings panel** — tune concurrency, connections, speed cap and quiet-engine mode from the popup; synced live to the coordinator.
*   **Playlist toggle** — check *Treat URL as a playlist* to queue every item in one action.
*   **Duplicate-safe link capture** — the in-page link interceptor caches the coordinator's online state so it can `preventDefault()` synchronously, preventing the browser from starting a parallel native download.

### Local Dashboard (`backend/`)
*   A **navy/white web dashboard** at `http://localhost:14921` (same origin as the coordinator) connects to the WebSocket directly and offers the full queue, live progress, pause/resume/cancel/open/reveal, a new-download form (with playlist support), and the runtime settings editor — no extension required.

## 📖 Issues resolved — problem, impact, and how we fixed it

Use this section as study material: each row is a real failure mode, why it matters, and the exact layer that handles it.

| # | Problem | Impact if ignored | How Veloce handles it | Where |
|---|---|---|---|---|
| 1 | Server returns `200` instead of `206` for a sub-range | **Silent file corruption** — full body written at wrong offset | Reject `200` on sub-ranges; only allow `200` for single-piece (whole-file) mode | `core_engine` `download_piece` |
| 2 | `HEAD` missing `Content-Length` (signed CDN URLs) | Download never starts or wrong size | Fallback 1-byte ranged `GET`, read `Content-Range` | `discover()` |
| 3 | No HTTP range support | Multi-connection corruption | Probe → single connection, one piece = whole file | `supports_ranges` + layout |
| 4 | Source file changed while resuming | Mixed old/new bytes | `ETag`/`Last-Modified` validation; `416` aborts piece | `ResumeState` + `validators_match` |
| 5 | `429`/`503` rate limits | Retry storm, IP ban | Honor `Retry-After` (cap 10s); halve concurrency | `download_piece` + adaptive cap |
| 6 | Slow but active transfer | Premature kill | **Idle** stall only (30s no bytes), no total timeout | `IDLE_TIMEOUT` per read |
| 7 | Crash mid state-file write | Resume broken, restart from 0 | Atomic write: `.tmp` + `rename` | reporter loop |
| 8 | Crash mid download | Lost job | Startup reconciliation re-queues `downloading`/`queued` rows | `reconcileInterrupted()` |
| 9 | Disk full mid-download | Partial mystery file | `statvfs` size check before write; `posix_fallocate` | `available_space` + `preallocate` |
| 10 | Path traversal in filename | Arbitrary file write | `sanitizeFileName` + `safeJoin` confinement | `ws.ts` |
| 11 | Malicious site opens `ws://localhost` | Drive downloader / SSRF | Origin allowlist; optional extension ID pin | `verifyClient` + `.env` |
| 12 | Download to private/metadata IP | SSRF from extension | Block localhost/private/link-local hosts | `isSafeDownloadUrl` |
| 13 | Instagram reel (no extension in URL) | Saves HTML page | yt-dlp with cookie fallback; format picker | `extractor.ts` |
| 14 | Expired CDN URL on resume | 403 mid-resume | Re-extract page URL on resume (unless user picked format) | `runDownloadJob` |
| 15 | Filename collision | Overwrites unrelated file | Auto-rename `name (1).ext` | `uniqueSavePath` |
| 16 | 100 simultaneous download requests | Socket/RAM exhaustion | FIFO queue + configurable active engine cap | scheduler + `.env` |
| 17 | Native browser download while Veloce online | Bypasses engine | `chrome.downloads` intercept → Veloce queue | `background.js` |
| 18 | User wants specific quality | Wrong default format | In-page badge → `LIST_FORMATS` → `directUrl` download | extension + `listFormats` |
| 19 | YouTube SPA changes `v=` without reload | Stale badge / wrong prefetch | `onWatchVideoChanged` + `hookNavigation`; reset capture, update prefetch focus | `sites/youtube.js` |
| 20 | Instagram Reels scroll | Format list hangs on wrong reel | Play-triggered prefetch + 2-slot focus window | `sites/instagram.js` + `VELOCE_PREFETCH_FOCUS` |
| 21 | MediaFire "Preparing Download" delay | No badge on file page | Poll DOM every 600ms until download button appears | `sites/mediafire.js` |
| 22 | Slow link underutilized | Fixed thread count wastes bandwidth | Auto-tune probe (2–16 connections) + AIMD adaptive concurrency | `probe.rs` + `adaptive.rs` |

## 🆕 Recent updates

Summary of notable changes in the latest development cycle. For agent/contributor details on format handling and site DOM layouts, see **`AGENTS.md`**.

### `core_engine` v0.2.0 — modular engine + throughput tuning

The monolithic `main.rs` was split into focused modules so each concern can be tested and tuned independently:

| Module | Responsibility |
|---|---|
| `file_io.rs` | Shared file handle, cross-platform `pwrite`/`seek_write`, free-space via `fs2` |
| `piece.rs` | Adaptive 1–16 MiB piece sizing |
| `profiles.rs` | Per-host defaults (MediaFire 8 MiB, googlevideo 4 MiB, …) + optional JSON overrides |
| `probe.rs` | Short pre-download connection probe (2–16 threads) |
| `adaptive.rs` | AIMD concurrency — ramp up on success, halve on transient errors |
| `resume.rs` | Binary `.veloce_state` bitmap (legacy JSON still loads) |
| `discover.rs` | Size discovery (`HEAD` → ranged `GET` fallback) |
| `download.rs` / `engine.rs` | Piece workers, reporter loop, orchestration |

**Coordinator integration:** `backend/src/lib/server/engineCli.ts` builds consistent CLI args for `ws.ts` and `playlistRunner.ts`, wiring `VELOCE_ENGINE_AUTO_TUNE`, `VELOCE_ENGINE_READ_BUFFER_BYTES`, referer/origin, and `--quiet`.

**Build:** release profile uses thin LTO (`Cargo.toml`). Rebuild after pulling:

```bash
cd core_engine && cargo build --release
```

### Extension v1.8.1 — active-tab capture & extension reload

*   **Foreground-only messaging** — only the active tab (and the tab that just lost focus) receive foreground state; no broadcast to every open tab.
*   **Auto re-inject on update** — reloading the extension re-injects the content script on the **current tab** automatically.
*   **Stale tab handling** — invalidated extension context stops timers and shows a refresh banner instead of console spam.
*   **Link intercept middleware** — closing the format menu without choosing a format resumes normal navigation.

### Extension v1.7.7 — site-specific capture

*   **Handler split** — YouTube, Instagram, MediaFire, and OmniSave/MovieBox logic moved out of `content.js` into `extension/static/sites/*.js`.
*   **YouTube** — watch-page badges, SPA navigation hooks, prefetch focus on the playing video only.
*   **Instagram** — reels prefetch on play + scroll focus; no feed prefetch spam.
*   **MediaFire** — file-page badges with delayed-button polling.
*   **XHR intercept fix** — `responseType: 'json'` responses no longer break the OmniSave cache hook.

### Backend fixes

*   Download jobs use `runtime.defaultThreads` (per-device setting) — the `downloads` table does not store a per-row thread count.
*   Engine spawn errors log the resolved binary path from `coreEngineBinaryPath()`.

## 🔒 Security

*   **WebSocket origin allowlist** — only `chrome-extension://` / `moz-extension://` (and `localhost` for dev) origins may connect; ordinary websites are rejected, so a malicious page cannot drive your local downloader. The Origin header is browser-enforced and cannot be forged by page JS. An optional `VELOCE_ALLOWED_EXTENSION_IDS` pins the exact extension ID(s).
*   **Path-traversal confinement** — filenames are reduced to a safe basename (control chars stripped) and every save path is resolved and verified to stay inside the chosen base directory.
*   **SSRF guard** — only `http`/`https` URLs are accepted, and (by default) downloads pointing at `localhost`/loopback/private/link-local hosts and the `169.254.169.254` cloud-metadata address are blocked.
*   **No shell / argv injection** — the engine and `yt-dlp` are spawned with explicit argument arrays (never a shell string), and `yt-dlp` URLs are passed after `--` so a URL starting with `-` can't be read as a flag.

## ⚙️ Configuration (`.env`)

The coordinator reads `backend/.env` at startup (real environment variables override it). Copy `backend/.env.example` to `backend/.env` and adjust:

| Variable | Default | Meaning |
|---|---|---|
| `VELOCE_PORT` | `14921` | WebSocket + dev-server port. |
| `VELOCE_MAX_CONCURRENT_DOWNLOADS` | `10` | Active engine processes; unlimited jobs queue FIFO. |
| `VELOCE_DEFAULT_THREADS` | `8` | Connections per download when unspecified. |
| `VELOCE_MAX_RATE_BYTES` | `0` | Global speed cap per download in bytes/sec (`0` = unlimited). |
| `VELOCE_MIN_FREE_DISK_MB` | `500` | Refuse to start if less free space than this. |
| `VELOCE_ENGINE_QUIET` | `true` | Suppress the engine's terminal progress bars (keeps the log clean). Tunable live. |
| `VELOCE_ENGINE_AUTO_TUNE` | `true` | Short probe to pick optimal connection count per download. |
| `VELOCE_ENGINE_READ_BUFFER_BYTES` | `262144` | HTTP read/coalesce buffer per connection. |
| `VELOCE_BASE_DIR` | *(empty)* | Override the default `~/Downloads/Veloce` base dir. |
| `VELOCE_ALLOWED_EXTENSION_IDS` | *(empty)* | Comma-separated extension IDs allowed to connect (empty = any extension). |
| `VELOCE_BLOCK_PRIVATE_HOSTS` | `true` | Block local/private/metadata hosts (SSRF guard). |

## 🧪 Edge cases & how Veloce handles them

These are the failure modes that bite naive downloaders. Each is handled so the *common* case stays simple and fast while the *worst* case stays correct.

| Edge case | What goes wrong elsewhere | How Veloce handles it |
|---|---|---|
| Server ignores `Range`, returns `200` | Full body written at a piece offset → silent corruption | Sub-range responses must be `206`; a `200` is rejected and the piece retried/aborted |
| Server has no `HEAD` length (signed CDN) | "Unknown size", multi-connection disabled or failure | Falls back to a 1-byte ranged `GET`, reads size from `Content-Range` |
| No range support at all | Corruption when assuming ranges | Probe detects it → single whole-file connection |
| Source file changes mid-life | Resume stitches old + new bytes | `ETag`/`Last-Modified` validated before resume; mismatch ⇒ clean restart; `416` ⇒ abort |
| Rate limiting (`429`/`503`) | Retry storm makes it worse | Honors `Retry-After` (capped) and backs off; halves concurrency |
| Slow-but-alive transfer | Killed by a total-time timeout | Only a **30 s idle** (no-bytes) stall aborts a piece |
| Process/power crash mid-write | Corrupt resume state, restart from 0 | Per-piece bitmap + **atomic** state writes; startup reconciliation re-queues it |
| Disk fills up | Partial file, confusing error | Size-aware `statvfs` check *before* writing + preallocation; clean `fatal` message |
| Filename already exists | Overwrites an unrelated file | Auto-rename `name (1).ext`, … |
| Malicious filename `../../etc/...` | Writes outside the target dir | Basename + base-dir confinement |
| Redirect to `169.254.169.254` / LAN | SSRF via open redirect | Engine redirect policy + coordinator URL re-check post-extract |
| Huge `--threads` / Content-Length | DoS / OOM | Threads clamped 1..=64; file ≤512 GiB; piece map ≤1M |
| Malicious website opens `ws://localhost` | Drives your downloader / scans LAN | Origin allowlist + SSRF host blocking |
| URL has no file extension (Instagram reel) | Saves HTML or fails | yt-dlp resolution (cookie fallback) → single progressive `mp4`; re-extracted on resume |
| CDN blocks library agents | `403 Forbidden` | Realistic Chrome `User-Agent` |
| Many concurrent downloads | Bandwidth/socket thrashing | Global scheduler caps concurrent engines; optional bandwidth cap |

## 📊 How Veloce compares to other download managers

| Capability | IDM | aria2 | JDownloader | FDM | **Veloce** |
|---|---|---|---|---|---|
| Multi-connection segmented download | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Work-stealing** pieces (no slow-chunk tail) | ❌ (fixed split) | ❌ | ❌ | ❌ | ✅ |
| Adaptive concurrency (down **and** back up) | partial | partial | ❌ | ❌ | ✅ |
| Crash-safe resume w/ validators | ✅ | ✅ | ✅ | ✅ | ✅ |
| Atomic resume-state writes | ? | ✅ | ? | ? | ✅ |
| Bandwidth cap | ✅ | ✅ | ✅ | ✅ | ✅ |
| `Retry-After`-aware backoff | ? | ✅ | partial | ? | ✅ |
| Video/social extraction (yt-dlp) | partial | ❌ | ✅ | partial | ✅ |
| Playlist expansion | ✅ | ✅ | ✅ | ✅ | ✅ |
| Desktop notifications | ✅ | ❌ | ✅ | ✅ | ✅ |
| Local web dashboard | ✅ | partial (RPC) | ✅ | ✅ | ✅ |
| Live-tunable settings (no restart) | ✅ | ✅ | ✅ | ✅ | ✅ |
| SSRF / origin hardening | n/a (native) | n/a | n/a | n/a | ✅ |
| Checksum / hash verification | partial | ✅ (Metalink) | ✅ | partial | ⏳ planned |
| Multi-source / mirror download | ❌ | ✅ (Metalink) | ✅ | ❌ | ⏳ planned |
| BitTorrent / Metalink | ❌ | ✅ | ✅ | ✅ | ⏳ not planned |
| Proxy / authenticated downloads | ✅ | ✅ | ✅ | ✅ | ⏳ planned |
| Scheduler (time-of-day) | ✅ | partial | ✅ | ✅ | ⏳ planned |
| Browser auto-capture / link grabber | ✅ | ❌ | ✅ | ✅ | ✅ |

> **Roadmap (next):** checksum verification (SHA-256/Metalink), multi-source/mirror fetch, HTTP proxy + Basic/Bearer auth, time-of-day scheduler.

## 🛠️ Setup

One command builds the engine, installs dependencies and builds the extension:

```bash
./scripts/setup.sh
```

It checks prerequisites (`cargo`, `node`, `pnpm`/`npm`, and warns if `yt-dlp` is missing), builds `core_engine`, installs the backend + extension deps, builds the extension into `extension/build`, and scaffolds `backend/.env`.

**Run the coordinator on login** (Linux, systemd user service):

```bash
mkdir -p ~/.config/systemd/user
cp scripts/veloce.service ~/.config/systemd/user/veloce.service
# edit WorkingDirectory / ExecStart paths inside, then:
systemctl --user daemon-reload
systemctl --user enable --now veloce.service
```

## 🧪 Testing

**Backend** — URL-safety/SSRF guard, filename sanitization, path confinement, category mapping, direct-URL/extractor detection, and `engineCli` argument building (Vitest):

```bash
cd backend && pnpm test
```

**Rust engine** — unit tests per module plus HTTP integration tests (`tests/integration_download.rs`):

```bash
cd core_engine && cargo test
```

Type-check the coordinator (SvelteKit + server TS):

```bash
cd backend && pnpm exec svelte-check --threshold error
```

## 🖱️ Using in-page capture

1. Start the backend: `cd backend && npm run dev`
2. Load the extension from `extension/build` (after `npm run build`)
3. Browse any page — **Veloce** badges appear on downloadable links and media
4. Click a badge → pick a format → download starts immediately
5. Or click any normal download link — if coordinator is online, Veloce intercepts instead of the browser
6. Toggle **Intercept** in the popup to fall back to native browser downloads

Pin your extension ID in `.env` for production:
`VELOCE_ALLOWED_EXTENSION_IDS=<your-chrome-extension-id>`
