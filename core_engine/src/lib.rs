//! Veloce multi-connection download engine — library surface for tests and CLI.

pub mod adaptive;
pub mod args;
pub mod discover;
pub mod download;
pub mod engine;
pub mod file_io;
#[cfg(target_os = "linux")]
pub mod io_uring_writer;
pub mod piece;
pub mod profiles;
pub mod probe;
pub mod rate_limit;
pub mod resume;

pub use args::EngineArgs;
pub use engine::run_download;
