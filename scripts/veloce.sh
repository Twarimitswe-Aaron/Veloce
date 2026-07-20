#!/usr/bin/env bash
# veloce — Veloce process manager
#
# Usage:
#   veloce start             Start the backend coordinator (extension-only mode)
#   veloce start desktop     Start the Tauri desktop app
#   veloce stop              Stop the backend coordinator
#   veloce stop desktop      Stop the Tauri desktop app
#   veloce stop all          Stop everything
#   veloce restart           Restart the backend coordinator
#   veloce restart desktop   Restart the Tauri desktop app
#   veloce status            Show status of both services
#   veloce logs              Follow backend coordinator logs
#   veloce logs desktop      Follow desktop app logs
#   veloce kill              Kill everything immediately (no systemd)
#
# The script is installed by setup.sh as ~/.local/bin/veloce
# Re-run setup.sh if you move the repo.

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
CYAN='\033[1;36m'; YELLOW='\033[1;33m'; GREEN='\033[1;32m'
RED='\033[1;31m'; RESET='\033[0m'; BOLD='\033[1m'

info()    { printf "${CYAN}[veloce]${RESET} %s\n" "$*"; }
ok()      { printf "${GREEN}[veloce]${RESET} %s\n" "$*"; }
warn()    { printf "${YELLOW}[veloce]${RESET} %s\n" "$*"; }
err()     { printf "${RED}[veloce]${RESET} %s\n" "$*" >&2; }
die()     { err "$*"; exit 1; }

# ── Helpers ───────────────────────────────────────────────────────────────────
have_systemd() { command -v systemctl >/dev/null 2>&1; }

svc_active() {
    # $1 = service unit name (without .service)
    systemctl --user is-active --quiet "${1}.service" 2>/dev/null
}

svc_action() {
    # $1 = action (start|stop|restart|status|enable|disable)
    # $2 = service unit name
    systemctl --user "$1" "${2}.service"
}

print_status() {
    local name="$1" unit="$2" label="$3"
    printf "  ${BOLD}%-12s${RESET} " "$name"
    if svc_active "$unit"; then
        printf "${GREEN}● running${RESET}"
        local pid
        pid="$(systemctl --user show -p MainPID --value "${unit}.service" 2>/dev/null || true)"
        [ -n "$pid" ] && [ "$pid" != "0" ] && printf "  (PID %s)" "$pid"
    else
        local sub
        sub="$(systemctl --user show -p SubState --value "${unit}.service" 2>/dev/null || echo 'inactive')"
        if [ "$sub" = "failed" ]; then
            printf "${RED}✗ failed${RESET}"
        else
            printf "${YELLOW}○ stopped${RESET}"
        fi
    fi
    printf "\n"
}

check_port() {
    local starting="$1"
    
    # 1. Check if the other managed service is active
    if [ "$starting" = "backend" ] && svc_active "veloce-desktop"; then
        if [ -t 1 ] || [ -t 0 ]; then
            printf "${YELLOW}⚠ Desktop app is already running on port 14921.${RESET}\n"
            printf "  Stop it and start the backend coordinator instead? [y/N] "
            read -r reply </dev/tty || reply="N"
            if [[ "$reply" =~ ^[Yy]$ ]]; then
                cmd_stop "veloce-desktop" "Desktop app"
                sleep 1
            else
                err "Aborted."
                exit 1
            fi
        else
            err "Desktop app is already running and using port 14921."
            err "Stop it first: veloce stop --desktop"
            exit 1
        fi
    elif [ "$starting" = "desktop" ] && svc_active "veloce"; then
        if [ -t 1 ] || [ -t 0 ]; then
            printf "${YELLOW}⚠ Backend coordinator is already running on port 14921.${RESET}\n"
            printf "  Stop it and start the desktop app instead? [y/N] "
            read -r reply </dev/tty || reply="N"
            if [[ "$reply" =~ ^[Yy]$ ]]; then
                cmd_stop "veloce" "Backend coordinator"
                sleep 1
            else
                err "Aborted."
                exit 1
            fi
        else
            err "Backend coordinator is already running and using port 14921."
            err "Stop it first: veloce stop"
            exit 1
        fi
    fi
    
    # 2. Check for unknown processes on 14921
    local port_in_use=0
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 'sport = :14921' 2>/dev/null | grep -q '14921' && port_in_use=1
    elif command -v lsof >/dev/null 2>&1; then
        lsof -iTCP:14921 -sTCP:LISTEN >/dev/null 2>&1 && port_in_use=1
    fi
    
    if [ $port_in_use -eq 1 ]; then
        err "Port 14921 is occupied by an unknown process (or manually run Veloce instance)."
        if command -v fuser >/dev/null 2>&1 && { [ -t 1 ] || [ -t 0 ]; }; then
            printf "  Would you like to forcefully kill the process on port 14921? [y/N] "
            read -r reply </dev/tty || reply="N"
            if [[ "$reply" =~ ^[Yy]$ ]]; then
                info "Killing process on port 14921..."
                fuser -k -9 14921/tcp >/dev/null 2>&1 || true
                sleep 1
            else
                err "Aborted. Please stop the process and try again."
                exit 1
            fi
        else
            err "Please stop it before starting the managed service."
            exit 1
        fi
    fi
}

# ── Commands ──────────────────────────────────────────────────────────────────
cmd_status() {
    if ! have_systemd; then
        warn "systemd not available. Use 'veloce start' to launch processes manually."
        return
    fi
    printf "\n${BOLD}Veloce services${RESET}\n"
    print_status "backend"  "veloce"         "Coordinator (extension mode)"
    print_status "desktop"  "veloce-desktop" "Tauri desktop app"
    printf "\n"
    printf "  Logs (backend):  journalctl --user -u veloce.service -f\n"
    printf "  Logs (desktop):  journalctl --user -u veloce-desktop.service -f\n"
}

cmd_start_backend() {
    have_systemd || die "systemd required for managed start. Install systemd or run manually: cd backend && pnpm run dev"
    if svc_active "veloce"; then
        ok "Backend coordinator is already running."
        ok "Dashboard: http://localhost:14921"
        return
    fi
    check_port "backend"
    info "Starting backend coordinator..."
    svc_action start veloce
    sleep 1
    if svc_active "veloce"; then
        ok "Backend coordinator started."
        ok "Dashboard: http://localhost:14921"
        ok "Load extension → chrome://extensions → Load unpacked"
    else
        err "Failed to start. Check logs:"
        err "  journalctl --user -u veloce.service -n 30"
        exit 1
    fi
}

cmd_start_desktop() {
    have_systemd || die "systemd required for managed start."
    # Check if the desktop service unit is installed
    if ! systemctl --user cat veloce-desktop.service >/dev/null 2>&1; then
        die "veloce-desktop.service is not installed. Re-run: ./scripts/setup.sh"
    fi
    if svc_active "veloce-desktop"; then
        ok "Desktop app is already running."
        return
    fi
    check_port "desktop"
    info "Starting Tauri desktop app..."
    svc_action start veloce-desktop
    sleep 2
    if svc_active "veloce-desktop"; then
        ok "Desktop app started."
    else
        err "Failed to start desktop app. Check logs:"
        err "  journalctl --user -u veloce-desktop.service -n 30"
        exit 1
    fi
}

cmd_stop() {
    local unit="$1" label="$2"
    have_systemd || die "systemd required."
    if ! svc_active "$unit"; then
        warn "$label is not running."
        return
    fi
    info "Stopping $label..."
    svc_action stop "$unit"
    ok "$label stopped."
}

cmd_restart() {
    local unit="$1" label="$2"
    have_systemd || die "systemd required."
    info "Restarting $label..."
    svc_action restart "$unit"
    sleep 1
    if svc_active "$unit"; then
        ok "$label restarted."
    else
        err "Restart failed. Check logs: journalctl --user -u ${unit}.service -n 30"
        exit 1
    fi
}

cmd_logs() {
    local unit="$1"
    have_systemd || die "systemd required."
    info "Following logs for ${unit}.service (Ctrl-C to stop)..."
    journalctl --user -u "${unit}.service" -f --output=cat
}

cmd_kill_all() {
    # Hard kill without systemd — useful if services are stuck
    info "Killing all Veloce processes..."
    # backend: pnpm run dev / node coordinator
    pkill -f "veloce.*backend" 2>/dev/null || true
    pkill -f "node.*backend" 2>/dev/null || true
    # desktop: tauri app binary
    pkill -f "com.veloce.desktop" 2>/dev/null || true
    pkill -f "veloce-desktop" 2>/dev/null || true
    pkill -f "Veloce" 2>/dev/null || true
    ok "Done."
}

usage() {
    printf "\n${BOLD}veloce${RESET} — Veloce process manager\n\n"
    printf "  ${CYAN}veloce start${RESET}             Start backend coordinator (extension-only mode)\n"
    printf "  ${CYAN}veloce start --desktop${RESET}   Start Tauri desktop app\n"
    printf "  ${CYAN}veloce stop${RESET}              Stop backend coordinator\n"
    printf "  ${CYAN}veloce stop --desktop${RESET}    Stop Tauri desktop app\n"
    printf "  ${CYAN}veloce stop --all${RESET}        Stop everything\n"
    printf "  ${CYAN}veloce restart${RESET}           Restart backend coordinator\n"
    printf "  ${CYAN}veloce restart --desktop${RESET} Restart Tauri desktop app\n"
    printf "  ${CYAN}veloce restart --all${RESET}     Restart everything\n"
    printf "  ${CYAN}veloce status${RESET}            Show status of all services\n"
    printf "  ${CYAN}veloce logs${RESET}              Follow backend coordinator logs\n"
    printf "  ${CYAN}veloce logs --desktop${RESET}    Follow desktop app logs\n"
    printf "  ${CYAN}veloce kill${RESET}              Hard-kill all Veloce processes\n\n"
    printf "Services survive terminal close — managed by systemd user session.\n\n"
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
CMD="${1:-status}"
shift || true
TARGET="${1:-}"

case "$CMD" in
    start)
        case "$TARGET" in
            --desktop|desktop) cmd_start_desktop ;;
            ""|--backend|backend) cmd_start_backend ;;
            *) err "Unknown target '$TARGET'. Use: veloce start [--desktop]"; usage; exit 1 ;;
        esac ;;
    stop)
        case "$TARGET" in
            --desktop|desktop)    cmd_stop "veloce-desktop" "Desktop app" ;;
            --all|all)            cmd_stop "veloce" "Backend coordinator"
                                  cmd_stop "veloce-desktop" "Desktop app" ;;
            ""|--backend|backend) cmd_stop "veloce" "Backend coordinator" ;;
            *) err "Unknown target '$TARGET'. Use: veloce stop [--desktop|--all]"; usage; exit 1 ;;
        esac ;;
    restart)
        case "$TARGET" in
            --desktop|desktop)    cmd_restart "veloce-desktop" "Desktop app" ;;
            --all|all)            cmd_restart "veloce" "Backend coordinator"
                                  cmd_restart "veloce-desktop" "Desktop app" ;;
            ""|--backend|backend) cmd_restart "veloce" "Backend coordinator" ;;
            *) err "Unknown target '$TARGET'. Use: veloce restart [--desktop|--all]"; usage; exit 1 ;;
        esac ;;
    logs)
        case "$TARGET" in
            --desktop|desktop)    cmd_logs "veloce-desktop" ;;
            ""|--backend|backend) cmd_logs "veloce" ;;
            *) err "Unknown target '$TARGET'. Use: veloce logs [--desktop]"; usage; exit 1 ;;
        esac ;;
    status)
        cmd_status
        if [ "$#" -eq 0 ] || [ -z "${2:-}" ]; then
            printf "\n  (Run '${BOLD}veloce --help${RESET}' to see all commands)\n\n"
        fi
        ;;
    kill)   cmd_kill_all ;;
    help|--help|-h) usage ;;
    *) err "Unknown command '$CMD'."; usage; exit 1 ;;
esac

