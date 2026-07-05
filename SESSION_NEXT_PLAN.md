# Veloce — Next Session Plan

> Created: 2026-07-05
> Previous session: Tauri native desktop app (Phase 3 — Rust coordinator rewrite)

---

## What was accomplished this session

### Gitignore consolidation
- Merged `backend/.gitignore`, `extension/.gitignore`, `core_engine/.gitignore` into a single root `.gitignore`
- Deleted all per-workspace `.gitignore` files

### WebSocket server for extension compatibility
- New module: `desktop/src-tauri/src/ws.rs` — Axum WebSocket server on `ws://0.0.0.0:PORT/ws` (default 14921)
- **Message handlers:** `PING/PONG`, `LIST_FORMATS` (calls `ytdlp::list_formats`), `NEW_DOWNLOAD` (acknowledges + placeholder error), `GET_SETTINGS`
- **Helpers:** `progress_to_ws`, `download_completed_to_ws`, `download_error_to_ws` for broadcasting events to all connected clients
- **Client registry:** `WsClients` with `std::sync::Mutex<HashMap<u64, UnboundedSender>>` — sync-safe, dead-client cleanup via `retain`
- Spawned on its own tokio runtime in Tauri's `.setup()` hook (no runtime dependency issues)
- 5 unit tests covering add/remove, broadcast, helper correctness

### Build & run verified
- `cargo build` succeeds (27 warnings — all dead code from planned features)
- App starts with zero panics:
  ```
  Database opened at /home/user/.local/share/Veloce/veloce.db
  WebSocket server listening on ws://0.0.0.0:14921
  ```

### Release bundle created
- Debian package: `desktop/src-tauri/target/release/bundle/deb/Veloce_0.1.0_amd64.deb` (6.1 MB)
- RPM package: `desktop/src-tauri/target/release/bundle/rpm/Veloce-0.1.0-1.x86_64.rpm` (6.1 MB)
- Release binary: `desktop/src-tauri/target/release/veloce-desktop` (18 MB)
- AppImage directory: `desktop/src-tauri/target/release/bundle/appimage/Veloce.AppDir/`

---

## Current desktop architecture

```
desktop/
├── src/App.svelte               # Svelte 5 UI (invoke + events)
├── src-tauri/src/
│   ├── main.rs + lib.rs         # Tauri app builder + 9 commands + WS spawn
│   ├── config.rs                # Env-based Config (VELOCE_PORT, etc.)
│   ├── db.rs                    # SQLite (rusqlite bundled) — devices, downloads, playlist_jobs
│   ├── engine.rs                # core_engine process management + progress callback
│   ├── formats.rs               # Media source detection, MediaFire, FormatCache
│   ├── scheduler.rs             # Download queue with concurrency cap
│   ├── state.rs                 # AppState: engines, cancellation_flags, progress map
│   ├── util.rs                  # Binary discovery, sanitize_filename, is_safe_download_url
│   ├── ws.rs                    # WebSocket server for extension compatibility **← NEW**
│   └── ytdlp.rs                 # yt-dlp format listing + extraction
├── src-tauri/Cargo.toml         # Tauri 2 + tokio + axum + rusqlite + reqwest
├── src-tauri/tauri.conf.json    # Window + bundle + icons
└── SESSION_DOCUMENTATION.md     # Full session writeup
```

### Key design decisions
- **WebSocket runs on its own tokio runtime** — spawned via `std::thread` + `tokio::runtime::Runtime::new()` inside Tauri's `.setup()` hook. Avoids any Tauri runtime context issues.
- **`WsClients` uses `std::sync::Mutex`** — accessible from both async (axum handler) and sync (engine reader thread) contexts without needing tokio runtime handles.
- **Progress events flow via Tauri `Emitter`** — the engine reader thread calls `on_progress` which emits `download-progress` events. WS broadcasts are not yet wired into this path.

---

## Prioritized next steps

### P0 — Wire WS progress events into engine callback (1 session)
The `progress_to_ws`, `download_completed_to_ws`, and `download_error_to_ws` helpers exist but are **not called** anywhere. The engine progress callback in `lib.rs::start_download` only emits Tauri events — it should also call these helpers so the extension receives live progress over WebSocket.

**Files to modify:**
- `desktop/src-tauri/src/lib.rs` — in the `on_progress` closure, also call `ws::progress_to_ws(ws_clients, ...)` and `ws::download_completed_to_ws(...)` / `ws::download_error_to_ws(...)` on status changes
- The `WsClients` is already managed as Tauri state — access via `app.state::<Arc<ws::WsClients>>()` or capture in the closure

**Acceptance:** Extension connected to the desktop app receives PROGRESS events during active downloads.

### P0 — Implement NEW_DOWNLOAD via WebSocket (1 session)
Currently the `NEW_DOWNLOAD` WS handler just acknowledges and returns an error placeholder. It should spawn the engine via the same infrastructure as the Tauri `start_download` command.

**Challenge:** The Tauri command owns the engine lifecycle (monitoring thread, cancellation flags, progress map updates). The WS handler needs to use the same infrastructure.

**Approach:** Extract the download logic into a shared async function that both the Tauri command and WS handler can call:
1. Create a shared `async fn start_download_inner(url, direct_url, file_name, referer, state: Arc<AppState>, app: Option<AppHandle>, ws_clients: Option<Arc<WsClients>>)` 
2. Tauri command passes `Some(app)` and `None` for WS clients
3. WS handler passes `None` for app and `Some(ws_clients)`

**Acceptance:** Extension's `VELOCE_NEW_DOWNLOAD` message via WebSocket triggers a real download through the engine, visible in the desktop UI.

### P1 — Add integration tests for WebSocket server (0.5 session)
Spin up the WS server in a test, connect as a WebSocket client, send `LIST_FORMATS` for a test URL pattern, and verify the response JSON shape matches what the extension's `background.js` expects.

**Files:**
- `desktop/src-tauri/tests/` (new directory) or inline in `ws.rs`

### P1 — Fix 27 compiler warnings (0.5 session)
Most are `dead_code` warnings for struct fields and functions not yet wired up. Adding `#[allow(dead_code)]` on planned-but-unused items is acceptable, or suppress with `#![allow(dead_code)]` in `lib.rs` during active development.

### P2 — Build and test full release pipeline (1 session)
- `cargo build --release` + verify bundle artifacts
- Install `.deb` on a clean Kali/test VM
- Verify extension connects to the desktop app's WS server
- Test basic download flow end-to-end

### P2 — Wire WS broadcasts into `update_status` and `update_progress` in `state.rs`
The `AppState::update_progress` and `AppState::update_status` methods already emit Tauri events. They should also broadcast via `WsClients` so extension-connected clients see updates without the engine callback having to do it.

**Files:**
- `desktop/src-tauri/src/state.rs` — add `ws_clients: Option<Arc<WsClients>>` parameter to `update_progress` and `update_status`

### P3 — Svelte UI integration
The Svelte frontend at `desktop/src/App.svelte` currently exists but likely needs updating to properly display downloads, show progress bars, pause/resume buttons, settings, etc.

**Check:**
- Does the Svelte UI listen for `download-progress` and `download-status` Tauri events?
- Does it have an invoke handler for each of the 9 commands?
- Does it match the existing dashboard at `localhost:14921`?

---

## Session start checklist

When starting the next session:

1. **Read this plan** (`SESSION_NEXT_PLAN.md`)
2. **Read the key files** you'll be modifying:
   - `desktop/src-tauri/src/lib.rs` (commands + run setup)
   - `desktop/src-tauri/src/ws.rs` (WebSocket handlers)
   - `desktop/src-tauri/src/engine.rs` (progress callback)
   - `desktop/src-tauri/src/state.rs` (state management)
3. **Run tests first:** `cd desktop/src-tauri && cargo test`
4. **Build:** `cd desktop/src-tauri && cargo build`
5. **Run:** `RUST_LOG=info cargo run`

---

## Useful commands

```bash
# Build
cd desktop/src-tauri && cargo build

# Run with logging
cd desktop/src-tauri && RUST_LOG=info cargo run

# Run tests
cd desktop/src-tauri && cargo test

# Build release
cd desktop/src-tauri && cargo build --release

# Create installable bundle (Svelte build + Tauri bundle)
cd desktop && pnpm tauri build

# Install deb package
sudo dpkg -i desktop/src-tauri/target/release/bundle/deb/Veloce_0.1.0_amd64.deb

# Clean up lingering processes
pkill -f veloce-desktop
```

---

## Protocol reference (extension ↔ WS server)

| Direction | Message type | Purpose |
|-----------|-------------|---------|
| Client → | `PING` | Keepalive |
| Server → | `PONG` | Keepalive response |
| Client → | `LIST_FORMATS` | Request available formats for a URL |
| Server → | `FORMATS_LIST` | Available formats response |
| Server → | `FORMATS_ERROR` | Format listing failed |
| Client → | `NEW_DOWNLOAD` | Start a download |
| Server → | `DOWNLOAD_ACK` | Download queued acknowledgment |
| Server → | `PROGRESS` | Download progress update |
| Server → | `DOWNLOAD_COMPLETED` | Download finished |
| Server → | `DOWNLOAD_ERROR` | Download failed |
| Server → | `SETTINGS` | Current coordinator settings |
| Server → | `DIRECTORY_SELECTED` | Current save directory |
