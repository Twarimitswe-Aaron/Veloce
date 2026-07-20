#!/usr/bin/env bash
# Veloce one-command setup: installs all prerequisites, builds the Rust engine,
# installs JS deps, and builds the browser extension.
# Run from anywhere: ./scripts/setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info()  { printf '\033[1;36m[veloce]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[veloce]\033[0m %s\n' "$*"; }
error() { printf '\033[1;31m[veloce]\033[0m %s\n' "$*" >&2; }

# ── Prerequisite checks & auto-install ────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1; }

# ---- Rust / cargo -----------------------------------------------------------
if ! need cargo; then
	info "cargo not found – installing Rust via rustup..."
	if [ "$(id -u)" -eq 0 ]; then
		# Running as root (e.g. sudo): install into /usr/local so all users see it
		export CARGO_HOME=/usr/local/cargo
		export RUSTUP_HOME=/usr/local/rustup
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
			| sh -s -- -y --no-modify-path --default-toolchain stable
		# Make cargo available in this shell immediately
		export PATH="$CARGO_HOME/bin:$PATH"
	else
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
			| sh -s -- -y --default-toolchain stable
		# shellcheck source=/dev/null
		source "$HOME/.cargo/env"
	fi
	if ! need cargo; then
		error "rustup install failed – please install Rust manually: https://rustup.rs"
		exit 1
	fi
	info "Rust installed: $(cargo --version)"
else
	info "cargo found: $(cargo --version)"
fi

# ---- Node.js ----------------------------------------------------------------
if ! need node; then
	info "node not found – attempting to install Node.js..."
	if need apt-get; then
		apt-get update -qq
		apt-get install -y -qq nodejs npm
	elif need dnf; then
		dnf install -y nodejs npm
	elif need pacman; then
		pacman -Sy --noconfirm nodejs npm
	elif need brew; then
		brew install node
	else
		error "Cannot auto-install Node.js on this system."
		error "Please install Node.js (https://nodejs.org) and re-run."
		exit 1
	fi
	if ! need node; then
		error "Node.js install failed – please install it manually: https://nodejs.org"
		exit 1
	fi
	info "Node.js installed: $(node --version)"
else
	info "node found: $(node --version)"
fi

# ---- pnpm (required – backend uses workspace: protocol) ---------------------
if ! need pnpm; then
	if need npm; then
		info "pnpm not found – installing via npm..."
		npm install -g pnpm
		# Refresh PATH so the newly installed pnpm binary is found immediately
		PNPM_BIN="$(npm -g bin 2>/dev/null || true)"
		[ -n "$PNPM_BIN" ] && export PATH="$PNPM_BIN:$PATH"
		hash -r 2>/dev/null || true   # rehash command cache (bash)
	fi
fi

if ! need pnpm; then
	error "pnpm could not be installed. The backend uses workspace: protocol deps which npm does not support."
	error "Install pnpm manually: https://pnpm.io/installation"
	exit 1
fi

PM="pnpm"
info "Using package manager: $PM ($(pnpm --version))"

# ---- yt-dlp -----------------------------------------------------------------
# yt-dlp is needed by BOTH the Node backend (backend/bin/yt-dlp) and the
# Tauri desktop app (desktop/bin/yt-dlp → candidate 2 in find_ytdlp).  We
# install the binary once into backend/bin and symlink it into desktop/bin.
install_ytdlp() {
	info "yt-dlp not found – downloading latest binary..."
	mkdir -p "$ROOT/backend/bin"
	YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
	if need curl; then
		curl -fsSL "$YTDLP_URL" -o "$ROOT/backend/bin/yt-dlp"
	elif need wget; then
		wget -qO "$ROOT/backend/bin/yt-dlp" "$YTDLP_URL"
	else
		warn "Neither curl nor wget available – cannot download yt-dlp."
		return 1
	fi
	chmod +x "$ROOT/backend/bin/yt-dlp"
	info "yt-dlp installed: $($ROOT/backend/bin/yt-dlp --version 2>/dev/null || echo 'ok')"
}

link_ytdlp_desktop() {
	# Symlink backend/bin/yt-dlp → desktop/bin/yt-dlp so the Tauri app finds
	# it at candidate path 2 (desktop/bin) even when packaged.
	mkdir -p "$ROOT/desktop/bin"
	if [ ! -e "$ROOT/desktop/bin/yt-dlp" ]; then
		ln -sf "$ROOT/backend/bin/yt-dlp" "$ROOT/desktop/bin/yt-dlp"
		info "yt-dlp symlinked → desktop/bin/yt-dlp"
	fi
}

if need yt-dlp; then
	info "yt-dlp found on PATH: $(yt-dlp --version 2>/dev/null || true)"
elif [ -x "$ROOT/backend/bin/yt-dlp" ]; then
	info "yt-dlp found at backend/bin/yt-dlp."
else
	install_ytdlp || warn "yt-dlp install skipped – video extraction will not work until it is installed."
fi
# Always ensure the desktop symlink exists (even if the binary was pre-existing)
[ -x "$ROOT/backend/bin/yt-dlp" ] && link_ytdlp_desktop

# ---- Desktop dialog tools (folder picker / open-in-folder) ------------------
install_pkg() {
	# $1 = package name; tries the system package manager
	if need apt-get;  then apt-get install -y -qq "$1"
	elif need dnf;    then dnf install -y "$1"
	elif need pacman; then pacman -Sy --noconfirm "$1"
	elif need brew;   then brew install "$1"
	else return 1
	fi
}

# zenity and kdialog are interchangeable folder-picker dialogs — only one is needed.
if need zenity; then
	info "Dialog tool 'zenity' found (folder picker: OK)."
elif need kdialog; then
	info "Dialog tool 'kdialog' found (folder picker: OK)."
else
	info "No dialog tool found – attempting to install zenity (preferred)..."
	if ! install_pkg zenity 2>/dev/null; then
		info "zenity unavailable – trying kdialog..."
		install_pkg kdialog 2>/dev/null \
			|| warn "Could not install zenity or kdialog – folder picker will not work."
	else
		info "'zenity' installed (folder picker: OK)."
	fi
fi

# xdg-open is needed independently for 'open containing folder'
if need xdg-open; then
	info "Optional tool 'xdg-open' found."
else
	info "xdg-open not found – attempting to install xdg-utils..."
	install_pkg xdg-utils 2>/dev/null && info "'xdg-open' installed." \
		|| warn "Could not install xdg-utils – 'open in folder' may not work."
fi

# ── Build the Rust core engine ────────────────────────────────────────────────
info "Building the Rust core engine (release)..."
(
	cd core_engine

	# If a previous `sudo` run left target/ owned by root, fix it so the
	# current user can write — otherwise cargo will fail with EACCES.
	if [ -d target ]; then
		owner="$(stat -c '%U' target 2>/dev/null || true)"
		current_user="$(id -un)"
		if [ "$owner" != "$current_user" ] && [ "$owner" = "root" ]; then
			warn "core_engine/target/ is owned by root – fixing permissions..."
			sudo chown -R "$current_user:$(id -gn)" target
		fi
	fi

	cargo build --release

	# exFAT/VFAT mounts sometimes leave a stale cargo fingerprint without linking the binary.
	if [ ! -x target/release/core_engine ]; then
		warn "Release binary missing after cargo build — retrying with a temp target dir..."
		TMP_TARGET="/tmp/veloce-core-engine-target-$$"
		CARGO_TARGET_DIR="$TMP_TARGET" cargo build --release
		mkdir -p target/release
		cp "$TMP_TARGET/release/core_engine" target/release/core_engine
		chmod +x target/release/core_engine
		rm -rf "$TMP_TARGET"
	fi
)
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

# ── Auto-install systemd user services and CLI manager ────────────────────────
SVC_SRC="$ROOT/scripts/veloce.service"
SVC_DEST="$HOME/.config/systemd/user/veloce.service"
SVC_DESKTOP_SRC="$ROOT/scripts/veloce-desktop.service"
SVC_DESKTOP_DEST="$HOME/.config/systemd/user/veloce-desktop.service"
PM_BIN="$(command -v "$PM")"   # absolute path to pnpm/npm

install_cli_manager() {
	mkdir -p "$HOME/.local/bin"
	cp "$ROOT/scripts/veloce.sh" "$HOME/.local/bin/veloce"
	chmod +x "$HOME/.local/bin/veloce"
	info "Installed 'veloce' CLI tool to $HOME/.local/bin/veloce"
}

install_services() {
	mkdir -p "$HOME/.config/systemd/user"

	# Stamp the backend service file
	if [ -f "$SVC_SRC" ]; then
		sed \
			-e "s|__VELOCE_WORKDIR__|$ROOT/backend|g" \
			-e "s|__VELOCE_EXECSTART__|$PM_BIN run dev|g" \
			"$SVC_SRC" > "$SVC_DEST"
	fi

	# Stamp the desktop service file
	if [ -f "$SVC_DESKTOP_SRC" ]; then
		sed \
			-e "s|__VELOCE_DESKTOP_WORKDIR__|$ROOT/desktop|g" \
			-e "s|__VELOCE_DESKTOP_EXECSTART__|$PM_BIN run start|g" \
			"$SVC_DESKTOP_SRC" > "$SVC_DESKTOP_DEST"
	fi

	systemctl --user daemon-reload
	
	# Enable backend by default (desktop can be started manually or enabled if desired)
	systemctl --user enable --now veloce.service
}

install_cli_manager

if [ -f "$SVC_SRC" ] && command -v systemctl >/dev/null 2>&1; then
	if systemctl --user is-active --quiet veloce.service 2>/dev/null; then
		info "veloce.service is already running — reloading with updated config..."
		install_services
		systemctl --user restart veloce.service
		info "veloce.service restarted."
	else
		info "Installing systemd services..."
		install_services
		info "veloce.service enabled and started (coordinator runs on every login)."
	fi
else
	! command -v systemctl >/dev/null 2>&1 && warn "systemd not available — skipping service install (macOS/WSL?)."
fi

# ── Final verification & instructions ─────────────────────────────────────────
EXT_BUILD="$ROOT/extension/build"
CYAN='\033[1;36m'; YELLOW='\033[1;33m'; GREEN='\033[1;32m'; RESET='\033[0m'

printf "\n"
printf "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "${GREEN}  ✓ Veloce setup complete!${RESET}\n"
printf "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n\n"

if command -v systemctl >/dev/null 2>&1; then
	printf "${CYAN}Process Manager installed${RESET}\n"
	printf "  Use the new ${YELLOW}veloce${RESET} command to manage your background apps:\n\n"
	printf "  • ${YELLOW}veloce status${RESET}           → See what's running\n"
	printf "  • ${YELLOW}veloce start${RESET}            → Start backend coordinator (auto-starts on login)\n"
	printf "  • ${YELLOW}veloce start --desktop${RESET}  → Start Tauri desktop app\n"
	printf "  • ${YELLOW}veloce restart --all${RESET}    → Restart everything\n"
	printf "  • ${YELLOW}veloce stop --all${RESET}       → Stop everything\n\n"
	
	if systemctl --user is-active --quiet veloce.service 2>/dev/null; then
		printf "${GREEN}✓ Backend coordinator is running in the background.${RESET}\n"
		printf "  View logs: ${YELLOW}veloce logs${RESET}\n\n"
	fi
else
	printf "${CYAN}Step 1 — Start the coordinator${RESET}\n"
	printf "  cd backend && $PM run dev\n\n"
	printf "${CYAN}Start the desktop app${RESET}\n"
	printf "  cd desktop && $PM run start\n\n"
fi

printf "${CYAN}Dashboard URL${RESET}\n"
printf "  http://localhost:14921\n\n"

printf "${CYAN}Load the browser extension${RESET}\n"
if [ -d "$EXT_BUILD" ] && [ -f "$EXT_BUILD/manifest.json" ]; then
	printf "  ${GREEN}✓ Extension build verified.${RESET}\n\n"
	printf "  1. Paste this into your browser address bar and press Enter:\n"
	printf "     ${YELLOW}chrome://extensions${RESET}\n\n"
	printf "  2. Enable ${YELLOW}Developer mode${RESET} (toggle, top-right corner)\n"
	printf "  3. Click ${YELLOW}Load unpacked${RESET}\n"
	printf "  4. Select this folder and click Open:\n"
	printf "     ${CYAN}%s${RESET}\n\n" "$EXT_BUILD"
else
	printf "  ${YELLOW}⚠ Extension build not found — run: cd extension && $PM run build${RESET}\n\n"
fi

