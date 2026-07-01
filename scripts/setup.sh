#!/usr/bin/env bash
# Veloce one-command setup: builds the Rust engine, installs JS deps, and builds
# the browser extension. Run from anywhere: ./scripts/setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info()  { printf '\033[1;36m[veloce]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[veloce]\033[0m %s\n' "$*"; }
error() { printf '\033[1;31m[veloce]\033[0m %s\n' "$*" >&2; }

# ── Prerequisite checks ───────────────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1; }

info "Checking prerequisites..."
MISSING=0
for cmd in cargo node; do
	if ! need "$cmd"; then error "Missing required tool: $cmd"; MISSING=1; fi
done
if ! need pnpm && ! need npm; then error "Need pnpm or npm"; MISSING=1; fi
[ "$MISSING" -eq 1 ] && { error "Install the missing tools and re-run."; exit 1; }

PM="pnpm"; need pnpm || PM="npm"
info "Using package manager: $PM"

if need yt-dlp; then
	info "yt-dlp found on PATH."
elif [ -x "$ROOT/backend/bin/yt-dlp" ]; then
	info "yt-dlp found at backend/bin/yt-dlp."
else
	warn "yt-dlp not found. Video/social extraction (YouTube/Instagram/…) will not work."
	warn "Install it, or drop a static binary at backend/bin/yt-dlp (chmod +x)."
fi

for tool in zenity kdialog xdg-open; do
	need "$tool" || warn "Optional tool '$tool' not found (used for folder picker / open-in-folder)."
done

# ── Build the Rust core engine ────────────────────────────────────────────────
info "Building the Rust core engine (release)..."
( cd core_engine && cargo build --release )
info "Engine built: core_engine/target/release/core_engine"

# ── Install deps + build the extension ────────────────────────────────────────
info "Installing backend dependencies..."
( cd backend && $PM install )

info "Installing extension dependencies..."
( cd extension && $PM install )

info "Building the extension..."
( cd extension && $PM run build )
info "Extension built: extension/build (load this as an unpacked extension)"

# ── .env scaffold ─────────────────────────────────────────────────────────────
if [ ! -f backend/.env ] && [ -f backend/.env.example ]; then
	cp backend/.env.example backend/.env
	info "Created backend/.env from the example (edit to taste)."
fi

cat <<EOF

$(info 'Setup complete.')
Next steps:
  1. Start the coordinator:   cd backend && $PM run dev
  2. Open the dashboard:      http://localhost:14921
  3. Load the extension:      chrome://extensions → Load unpacked → $ROOT/extension/build

To run the coordinator on login, see scripts/veloce.service.
EOF
