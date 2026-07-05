# Veloce — Next Session Plan

> Updated: 2026-07-05
> Status: **Desktop ↔ extension wiring complete (P0)**

---

## Completed this session

### P0 — Shared download pipeline (`download.rs`)
- `list_formats_for_url()` — MediaFire scrape, GitHub blob→raw, direct files, yt-dlp (same routing as Tauri IPC)
- `start_download_job()` — shared by Tauri `start_download` **and** WebSocket `NEW_DOWNLOAD`
- `save_blob_download()` — `SAVE_BLOB` for blob:/data: intercepts
- `cancel_download_job()` / `pause_download_job()` / `resume_download_job()`

### P0 — WebSocket progress + status fan-out
- `AppState::emit_progress()` / `emit_status()` broadcast to **Tauri UI + all WS clients**
- Engine reader thread calls `emit_progress`; completion calls `emit_status` → `PROGRESS`, `DOWNLOAD_COMPLETED`, `DOWNLOAD_ERROR`, `DOWNLOAD_PAUSED`, `DOWNLOAD_REMOVED`

### P1 — Protocol parity (partial)
- Origin allowlist on WS upgrade (extension + localhost)
- `DOWNLOAD_SNAPSHOT` on connect
- YouTube `--js-runtimes node` in `ytdlp.rs`
- GitHub blob URLs in `formats.rs`

### Tests
- `cargo test` — **67 passed**

---

## How to verify end-to-end

1. **Stop** Node coordinator if running (`backend npm run dev`)
2. Start desktop: `cd desktop/src-tauri && RUST_LOG=info cargo run`
3. Reload extension in `chrome://extensions`
4. Browse → Veloce badge → pick format → download should appear in desktop UI **and** extension popup with live progress

---

## Remaining work (P2+)

| Item | Notes |
|------|-------|
| Playlist WS messages | `PLAYLIST_QUEUED`, `PLAYLIST_UPDATE`, … not ported yet |
| `SET_SETTINGS` / directory picker | Extension settings panel partial |
| `OPEN_FILE` / `REVEAL_FILE` | xdg-open / file manager integration |
| Bundle `core_engine` + `yt-dlp` as Tauri sidecars | `externalBin` in `tauri.conf.json` |
| System tray + single-instance | `plan.md` Phase 2 |
| Scheduler concurrency cap | `Scheduler` exists but downloads spawn immediately |
| Port Node `extractor.ts` races fully | Instagram 5min fail cache, manifest re-extract on download |

---

## Commands

```bash
cd desktop/src-tauri && cargo build
cd desktop/src-tauri && RUST_LOG=info cargo run
cd desktop/src-tauri && cargo test
cd desktop && pnpm tauri build
```
