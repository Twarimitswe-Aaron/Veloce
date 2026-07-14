# Veloce `core_engine`

High-performance multi-connection HTTP range downloader used by both the **desktop** (Tauri) and **Node backend** coordinators.

## Architecture

```
CLI args → safety checks (URL / threads / base-dir)
        → discover size (HEAD / Range GET)
        → optional auto-tune (sequential, early-exit)
        → N workers fetch Range pieces
        → positioned writes (io_uring on Linux)
        → JSON progress on stdout
```

## Security (engine-side)

| Guard | Behavior |
|-------|----------|
| **Redirect SSRF** | Custom redirect policy blocks private/loopback/link-local/metadata IPs and non-http(s) schemes; max 5 hops |
| **Initial URL** | Same host rules as coordinator `isSafeDownloadUrl` |
| **Local override** | `VELOCE_ALLOW_LOCAL_URLS=1` for integration tests only |
| **Threads** | Clamped to **1..=64** (CLI + spawn sites) |
| **File size** | Reject discoveries > 512 GiB or > 1M pieces |
| **Piece overrun** | Stream writes stop at piece end (no neighbour corruption) |
| **`--base-dir`** | `save_path` must resolve under this root (path traversal guard) |
| **Sidecar** | `.veloce_done` only counted complete if file exists and size matches |
| **Resume validators** | If server sends ETag/Last-Modified, state must match |

Coordinators must still re-validate **post-extract** URLs (yt-dlp / MediaFire) before spawn — desktop and backend do this.

## Performance

| Feature | Notes |
|---------|--------|
| Multi-range workers | Host profiles cap threads / piece size |
| Auto-tune | Sequential probe with early exit (better TTFB than all-at-once) |
| `--quiet` | Suppresses diagnostic `eprintln`; JSON progress stays on stdout |
| `--origin` | Set from referer by desktop + backend (CDN parity) |
| Linux io_uring | Batched positioned writes; `write_at_owned` avoids extra buffer copy |

## CLI (selected)

```
core_engine \
  --id <id> \
  --url <https://...> \
  --save-path </path/file.mp4> \
  --threads 8 \
  [--base-dir </downloads>] \
  [--referer <page>] \
  [--origin <origin>] \
  [--quiet] \
  [--no-auto-tune]
```

## Build

```bash
cd core_engine && cargo build --release
```

Binary: `core_engine/target/release/core_engine`

## Tests

```bash
cd core_engine && cargo test
```
