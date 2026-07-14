//! Diagnostic logging gated by `--quiet`.

use std::sync::atomic::{AtomicBool, Ordering};

static QUIET: AtomicBool = AtomicBool::new(false);

pub fn set_quiet(quiet: bool) {
    QUIET.store(quiet, Ordering::Relaxed);
}

pub fn is_quiet() -> bool {
    QUIET.load(Ordering::Relaxed)
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
