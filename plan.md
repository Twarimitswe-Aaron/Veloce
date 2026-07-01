# Veloce — Native Desktop Application Plan

> Goal: one-click Veloce that runs on **Kali Linux, Windows, and macOS** without the user installing Rust, Node, or running `pnpm dev`. The browser extension keeps intercepting downloads; progress and history live in a **native window** while the app runs (optionally staying in the system tray).

---

## Current state (what we already have)

| Layer | Tech | Role today |
|---|---|---|
| **Extension** | Svelte 5, MV3 | Capture links/media, intercept browser downloads, format picker |
| **Coordinator** | SvelteKit + Node + SQLite | WebSocket hub, yt-dlp, queue, spawns engine |
| **Engine** | Rust (`core_engine`) | Multi-threaded segmented HTTP downloads |
| **Dashboard** | Svelte page @ `localhost:14921` | Queue, settings, open/reveal (browser tab) |

**Protocol:** extension ↔ `ws://localhost:14921/ws` (already stable).

**Gap:** user must manually start the coordinator, build Rust, load unpacked extension, install yt-dlp.

---

## Target experience

1. User installs Veloce once (`.deb` / AppImage / `.exe` / `.dmg`).
2. Clicks the **Veloce icon** → native app opens + **system tray** icon appears.
3. Coordinator starts automatically (bundled, no terminal).
4. Extension sees coordinator **online** → badges + intercept work.
5. Downloads appear in the **native window** (queue, speed, ETA, pause, open folder).
6. User closes the window → app can **stay in tray** (extension still works).
7. Quit from tray → engines stop cleanly.

User never installs Rust or runs `pnpm dev`.

---

## Recommended stack: **Tauri 2**

| Why Tauri | Detail |
|---|---|
| Rust shell | Matches `core_engine`; small binary vs Electron |
| WebView UI | Reuse existing Svelte dashboard |
| Sidecar binaries | Ship prebuilt `core_engine` + `yt-dlp` per OS/arch |
| Cross-platform | Linux (incl. Kali), Windows, macOS from one codebase |
| Tray + single-instance | Built-in patterns for “click icon → focus window” |

**Alternative considered:** Electron — faster to wrap Node coordinator, but ~150 MB+ installs. Tauri is the better long-term fit.

---

## Architecture (v1 — minimal rewrite)

```
┌─────────────────────────────────────────────────────────────┐
│  Native Veloce (Tauri)                                       │
│  ┌──────────────┐  ┌─────────────────────────────────────┐  │
│  │ System tray  │  │ WebView: embedded dashboard UI       │  │
│  │ + main window│  │ (same WS client as browser dashboard)│  │
│  └──────┬───────┘  └──────────────────┬──────────────────┘  │
│         │                              │                     │
│         └──────────┬───────────────────┘                     │
│                    ▼                                         │
│         ┌──────────────────────┐                             │
│         │ Local Coordinator    │  ← bundled Node dist OR     │
│         │ ws://127.0.0.1:14921 │    Rust rewrite (phase 3)   │
│         └──────────┬───────────┘                             │
│                    │ spawn                                   │
│         ┌──────────▼───────────┐  ┌─────────────┐            │
│         │ core_engine (sidecar)│  │ yt-dlp bin  │            │
│         └──────────────────────┘  └─────────────┘            │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ WebSocket (unchanged protocol)
┌─────────────────────────────┴───────────────────────────────┐
│  Chrome / Firefox extension (capture + intercept only)       │
└─────────────────────────────────────────────────────────────┘
```

**Key decision:** keep the WebSocket API unchanged so the extension needs **zero** protocol changes in v1.

---

## Phased rollout

### Phase 1 — Native shell (MVP)

**Deliverables**

- [ ] New `desktop/` crate (Tauri 2 + Svelte frontend)
- [ ] On app start: spawn bundled coordinator (Node `vite preview` or standalone server bundle)
- [ ] Bundle `core_engine` per target triple in `src-tauri/binaries/`
- [ ] Main window loads dashboard (embedded WebView → `http://127.0.0.1:14921` or inline assets + WS)
- [ ] System tray: Open / Pause all / Quit
- [ ] Single-instance: second launch focuses existing window
- [ ] Graceful shutdown: SIGTERM running engines, flush SQLite

**Extension changes (small)**

- [ ] Popup: “Open Veloce” button when desktop app detected (optional ping `/health`)
- [ ] Keep intercept + badges as-is

**Acceptance**

- Fresh Kali user: install `.deb` or AppImage → click icon → download from browser → see progress in native window.
- No Rust/cargo/Node on user machine.

---

### Phase 2 — Packaging & polish

**Deliverables**

- [ ] **Linux:** AppImage + `.deb` (Kali/Debian), test on Wayland + X11
- [ ] **Windows:** NSIS/MSI installer
- [ ] **macOS:** `.dmg` (+ optional code signing)
- [ ] CI matrix: build `core_engine` for `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`, `aarch64-apple-darwin`, `x86_64-apple-darwin`
- [ ] Bundle or first-run download of `yt-dlp`
- [ ] Autostart on login (OS-specific; Tauri plugin or `.desktop` / Registry / LaunchAgent)
- [ ] Native OS notifications on complete/error (replace/supplement extension notifications)
- [ ] Extension popup slimmed: status + intercept toggle + “Open Veloce” (queue only in desktop app)

**Acceptance**

- Install size documented; cold start < 5 s on typical hardware.
- Reveal-in-folder works on Kali (Thunar/Nautilus) and Windows Explorer.

---

### Phase 3 — Optional coordinator rewrite (Rust)

**Why:** drop Node from bundle (~30–50 MB savings), single process tree, simpler lifecycle.

**Deliverables**

- [ ] Port WS handlers from `backend/src/lib/server/ws.ts` to Rust (`axum` + `tokio-tungstenite`)
- [ ] SQLite via `rusqlite` or `sqlx` (same schema)
- [ ] yt-dlp still spawned as sidecar
- [ ] Remove Node from Tauri bundle

**When:** only after Phase 1–2 are stable and shipped.

---

## What stays the same

- Extension WebSocket message types (`NEW_DOWNLOAD`, `PROGRESS`, `SAVE_BLOB`, settings, etc.)
- Rust download engine (work-stealing, resume, rate limit)
- Security: origin allowlist, SSRF guard, path confinement
- SQLite download history schema

---

## Blob / in-browser media (AI images, canvas exports)

Sites (ChatGPT, Midjourney, etc.) often trigger downloads with `blob:` or `data:` URLs. The HTTP engine cannot fetch these.

**Implemented (extension v1.2.1 + coordinator):**

- Intercept detects `blob:` / `data:` → page-context fetch materializes bytes → `SAVE_BLOB` writes the file directly (no Rust engine).
- Max size cap (~80 MB) for abuse safety.
- If materialization fails, Veloce **does not cancel** the native browser download (fallback).
- Instagram-style blobs still resolve to post URLs where possible.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Large install size | Tauri not Electron; optional yt-dlp on first run |
| Linux fragmentation (Wayland, file managers) | Test AppImage on Kali; keep `xdg-open` + D-Bus fallbacks |
| Two UIs (popup + desktop) | Phase 2: popup becomes control surface only |
| Coordinator port conflict | Configurable port; single-instance lock |
| Extension store review | Keep minimal permissions; document localhost WS |

---

## Success metrics

- Time from install to first successful download **< 2 minutes**
- User never runs a terminal command
- Extension intercept works whenever tray icon is present
- Queue visible in native window with pause/resume/open folder

---

## Next action (when starting implementation)

1. `pnpm create tauri-app desktop` (Svelte + TypeScript)
2. Copy/adapt `backend/src/routes/+page.svelte` into desktop frontend
3. Tauri `beforeBuild` hook: `cargo build --release` in `core_engine/`, copy binary to `src-tauri/binaries/`
4. Tauri startup command: spawn coordinator child process, wait for port 14921
5. Ship AppImage for Kali first (fastest validation loop)

---

*Last updated: 2026-07-02 — aligns with current Veloce extension v1.2.x and coordinator features (dashboard, settings, playlist, notifications, context menu).*
