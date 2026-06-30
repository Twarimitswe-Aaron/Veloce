# ⚡ Veloce: Advanced Multi-Threaded Download Manager

Veloce is a high-performance, segmented Internet Download Manager (IDM) designed to aggressively capture, segment, and assemble web resources. It bypasses browser restrictions by splitting operations into three distinct, decoupled layers.

## 🏗️ System Architecture

### 1. `extension/` (Browser Extension)
*   **Tech Stack:** Svelte 5, Manifest V3, Tailwind
*   **Role:** The popup UI inside the browser. You paste a URL (or it derives a filename), pick a save directory, choose the connection count, and send the job. It shows a **live download list** with per-file progress, speed, ETA, and errors.
*   **How it talks:** It connects to the `backend` via a local **WebSocket** and rehydrates its download list on (re)connect, so closing/reopening the popup never loses progress.

### 2. `backend/` (Local Coordinator)
*   **Tech Stack:** SvelteKit (Node.js full-stack), Drizzle ORM, libSQL/SQLite
*   **Role:** The native coordinator that runs on your PC. It receives download payloads from the extension, normalizes/categorizes them, resolves media URLs (yt-dlp / Mediafire), persists the queue and history in SQLite, and spawns the Rust engine.
*   **How it works:** A **global scheduler** caps how many engine processes run at once (default 3) so concurrent downloads don't fight over bandwidth, sockets, and disk. Each engine runs as a **child process**; if it crashes, the coordinator stays alive and records the failure.

### 3. `core_engine/` (Rust Core)
*   **Tech Stack:** Rust, Tokio, Reqwest, Crossbeam
*   **Role:** The heavy lifter. A standalone executable invoked by the coordinator. It performs segmented byte-range downloads with a **lock-free work-stealing** piece queue, adaptive concurrency, idle-stall detection, and crash-safe resume — writing directly to disk at maximum speed.

## 📚 Learning Concepts Explained

### WebSockets vs Native Messaging
To let the browser extension talk to your computer's native file system, we use **WebSockets**. The Local Coordinator runs a tiny server on your PC at `ws://localhost:14921/ws`. The browser extension simply connects to this address. It's much easier to set up than "Native Messaging" (which requires hacking the OS registry).

### Child Process
Instead of compiling the complex Rust Engine into a JavaScript module (FFI), the SvelteKit backend runs the compiled Rust executable (`veloce_core.exe`) exactly like you would run a command in the terminal. This is called spawning a **Child Process**. If the Rust engine crashes due to a bad network request, your SvelteKit dashboard stays safely alive and can restart it.

### Multi-Threading (Tokio)
The Rust engine first probes whether the server honors HTTP range requests. If it does, the file is divided into fixed **4 MiB pieces** placed on a shared queue. `Tokio` runs one async worker per connection; each worker repeatedly claims the next pending piece and writes it at the correct file offset. Because workers pull work dynamically, a slow connection never holds up the others — there is no fixed per-thread "tail".

## 🚀 Performance & Reliability (implemented)

### Engine (`core_engine/`)
*   **Dynamic work-stealing segmentation** — 4 MiB pieces on a lock-free `crossbeam` queue. Claiming a piece, accounting bytes, and marking completion are all **O(1)**. Fast connections naturally download more pieces; slow ones download fewer.
*   **Adaptive concurrency** — starts at the requested connection count, **halves** on connection errors to ease server pressure, and **ramps back up** to the ceiling after sustained success (most managers only ratchet down).
*   **Range-support probe** — sends a `bytes=0-0` probe; if the server ignores ranges it transparently falls back to a single connection (prevents multi-connection file corruption).
*   **Idle-stall timeout** — a piece is aborted only if **no bytes arrive for 30 s**, never on a total-time deadline, so legitimately slow transfers are not killed.
*   **Crash-safe resume** — a `.veloce_state` sidecar stores a per-piece completion bitmap plus the server's `ETag`/`Last-Modified`. On restart only the missing pieces are fetched; if the file changed server-side the resume is rejected to avoid corruption. A `.veloce_done` sidecar marks true completion.
*   **Real preallocation** — `posix_fallocate` reserves disk blocks up front (falls back to `set_len`), so a full disk fails fast and fragmentation is reduced.
*   **Tuned transport** — HTTP/1.1-only, no gzip, TCP nodelay, keep-alive, per-host pool sized to the connection count, 2 MiB write buffering.

### Coordinator (`backend/`)
*   **Global download scheduler** — caps concurrent engine processes (default 3); extra jobs queue FIFO and start as slots free.
*   **Fail-closed safety** — aborts (instead of downloading page HTML) when media-URL extraction fails, and aborts when free disk space can't be verified.
*   **No stuck rows** — handles spawn (`ENOENT`) and exit via a single-settle guard; every job ends as `completed` or `error`.
*   **Smart dedup** — a `completed` download is only skipped if its bytes still exist on disk; deleted files can be re-fetched.
*   **Resilient folder picker** — tries `zenity`, then `kdialog`, and reports when neither is available.

### Extension (`extension/`)
*   **Live progress UI** — consumes `PROGRESS`/`COMPLETED`/`ERROR` and renders per-file bars, speed, and ETA.
*   **State rehydration** — on connect the backend sends a snapshot of recent/active downloads, so the popup can be closed and reopened without losing visibility.

> **Note on scope:** the extension is currently a manual popup. Automatic page scraping / network interception and a floating in-page UI are *not* implemented yet.
