//! Diagnostic logging gated by `--quiet`, plus always-on auto-tune traces.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static QUIET: AtomicBool = AtomicBool::new(false);

pub fn set_quiet(quiet: bool) {
    QUIET.store(quiet, Ordering::Relaxed);
}

pub fn is_quiet() -> bool {
    QUIET.load(Ordering::Relaxed)
}

/// UTC wall clock `HH:MM:SS.mmmZ` (no chrono dependency).
pub fn wall_clock() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let tod = dur.as_secs() % 86_400;
    let h = tod / 3600;
    let m = (tod % 3600) / 60;
    let s = tod % 60;
    format!("{:02}:{:02}:{:02}.{:03}Z", h, m, s, dur.subsec_millis())
}

/// Format bytes/sec for auto-tune traces (KB/s + MB/s + Mbps).
pub fn fmt_speed(bps: f64) -> String {
    if bps <= 0.0 {
        return "0 B/s".into();
    }
    format!(
        "{:.1} KB/s ({:.3} MB/s / {:.2} Mbps)",
        bps / 1024.0,
        bps / 1_048_576.0,
        bps * 8.0 / 1_000_000.0
    )
}

/// eprintln! that no-ops when `--quiet` is set (JSON progress still goes to stdout).
#[macro_export]
macro_rules! elog {
    ($($arg:tt)*) => {{
        if !$crate::logutil::is_quiet() {
            eprintln!($($arg)*);
        }
    }};
}

/// Always-on auto-tune / concurrency diagnostics (bypass `--quiet`).
/// Prefixed with wall clock + elapsed since download start.
#[macro_export]
macro_rules! atune_log {
    ($elapsed:expr, $($arg:tt)*) => {{
        eprintln!(
            "[atune {} +{:.2}s] {}",
            $crate::logutil::wall_clock(),
            ($elapsed).as_secs_f64(),
            format!($($arg)*)
        );
    }};
}
