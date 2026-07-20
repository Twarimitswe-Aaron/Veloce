# Veloce Desktop (Tauri)

Native desktop app with an embedded Rust coordinator and WebSocket server for the Chrome extension.

**Project docs:** [../README.md](../README.md) · [../SESSION_NEXT_PLAN.md](../SESSION_NEXT_PLAN.md)

## Run 

**Primary method (managed background service):**

The easiest way to run the desktop app is using the `veloce` process manager installed by `scripts/linux/setup.sh`:

```bash
veloce start --desktop
```

This launches the Tauri app and WebSocket on `:14921`. You can view logs via `veloce logs --desktop` and stop it via `veloce stop --desktop`.

Do **not** run the backend coordinator (`veloce start`) at the same time as the desktop app — both bind port **14921**. The desktop app **is** the coordinator; it does not start the Node backend.

### Development commands

**Frontend hot-reload** (when editing `src/App.svelte`):

```bash
cd desktop && pnpm dev
```
Uses Vite on `http://127.0.0.1:1420` via `tauri.dev.conf.json`.

**Manual split** (same as `pnpm start`):

```bash
cd desktop && pnpm build
cd desktop/src-tauri && RUST_LOG=info cargo run
```

Do **not** run only `cargo run` without `pnpm build` first — the window needs `desktop/dist/` (otherwise you may see “Could not connect to localhost: Connection refused” from the old Vite dev URL).

## Shared database

Backend and desktop use the **same SQLite file** by default:

```
~/.local/share/Veloce/veloce.db
```

Override with `VELOCE_DB_PATH` in the environment or `backend/.env`.

If you have history in `backend/veloce.db`, migrate once:

```bash
mkdir -p ~/.local/share/Veloce
cp backend/veloce.db ~/.local/share/Veloce/veloce.db
```

Only run **one** coordinator at a time (desktop **or** backend), not both — they share the DB and port.

## Extension integration

When `veloce-desktop` is running:

1. Extension connects to `ws://localhost:14921/ws` (same protocol as Node coordinator)
2. `LIST_FORMATS`, `NEW_DOWNLOAD`, `SAVE_BLOB`, pause/resume/cancel are handled in `src-tauri/src/ws.rs`
3. Progress/completion events broadcast to all connected extension popups

## Build release

```bash
cd desktop && pnpm tauri build
```

Requires `core_engine` and `yt-dlp` on PATH (or beside the binary — see `util::find_core_engine`).

## Key modules

| File | Role |
|------|------|
| `src-tauri/src/download.rs` | Shared download orchestration (IPC + WebSocket) |
| `src-tauri/src/ws.rs` | Extension WebSocket protocol |
| `src-tauri/src/state.rs` | App state + Tauri/WS event fan-out |
| `src/App.svelte` | Native queue UI |
