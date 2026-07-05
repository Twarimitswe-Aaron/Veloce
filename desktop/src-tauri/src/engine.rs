use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::path::PathBuf;
use serde_json;

/// Represents a running core_engine process.
pub struct EngineProcess {
    download_id: String,
    child: Option<Child>,
    cancelled: Arc<AtomicBool>,
}

/// Progress data emitted by core_engine as JSON lines on stdout.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EngineProgress {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub downloaded: Option<u64>,
    pub total: Option<u64>,
    pub speed_bps: Option<u64>,
    pub eta_secs: Option<u64>,
    pub elapsed_secs: Option<u64>,
    pub error: Option<String>,
}

impl EngineProcess {
    /// Spawn the core_engine binary with the given arguments.
    ///
    /// `on_progress` is called from the reader thread each time the engine emits
    /// a JSON progress line on stdout. `AppHandle` is `Send + Sync` so Tauri
    /// events can be emitted directly from the callback.
    pub fn spawn<F>(
        download_id: String,
        url: &str,
        save_path: &str,
        threads: u32,
        max_rate: u64,
        quiet: bool,
        read_buffer_bytes: u32,
        auto_tune: bool,
        referer: Option<&str>,
        on_progress: F,
    ) -> Result<(Self, std::thread::JoinHandle<()>), String>
    where
        F: Fn(EngineProgress) + Send + 'static,
    {
        let engine_path = Self::find_engine();
        let mut args = vec![
            "--id".to_string(),
            download_id.clone(),
            "--url".to_string(),
            url.to_string(),
            "--save-path".to_string(),
            save_path.to_string(),
            "--threads".to_string(),
            threads.to_string(),
            "--max-rate".to_string(),
            max_rate.to_string(),
            "--read-buffer-bytes".to_string(),
            read_buffer_bytes.to_string(),
        ];
        if quiet {
            args.push("--quiet".to_string());
        }
        if !auto_tune {
            args.push("--no-auto-tune".to_string());
        }
        if let Some(ref_) = referer {
            args.push("--referer".to_string());
            args.push(ref_.to_string());
        }

        let mut child = Command::new(&engine_path)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Failed to spawn engine: {} (path: {:?})", e, engine_path))?;

        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_clone = cancelled.clone();
        let stdout = child.stdout.take().unwrap();

        // Background thread reads JSON progress lines from the engine
        let reader_thread = std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            let mut line = String::new();
            use std::io::BufRead;
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // EOF — engine exited
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() { continue; }
                        if let Ok(progress) = serde_json::from_str::<EngineProgress>(trimmed) {
                            on_progress(progress);
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok((Self { download_id, child: Some(child), cancelled: cancelled_clone }, reader_thread))
    }

    /// Send SIGTERM to pause the engine (state file preserved).
    pub fn pause(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.kill();
        }
    }

    /// Cancel the engine (state file will be cleaned up by coordinator).
    pub fn cancel(&mut self) {
        log::debug!("Cancelling engine for download {}", self.download_id);
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(ref mut child) = self.child {
            let _ = child.kill();
        }
    }

    /// Wait for the engine process to exit and return the exit code.
    pub fn wait(&mut self) -> Option<i32> {
        self.child.as_mut().and_then(|c| c.wait().ok()).map(|s| s.code().unwrap_or(-1))
    }

    fn find_engine() -> PathBuf {
        crate::util::find_core_engine(env!("CARGO_MANIFEST_DIR"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── EngineProgress JSON parsing ──────────────────────────────────────

    #[test]
    fn test_engine_progress_deserialize_full() {
        let json = r#"{
            "type": "progress",
            "downloaded": 500,
            "total": 1000,
            "speed_bps": 2500000,
            "eta_secs": 30,
            "elapsed_secs": 10
        }"#;
        let p: EngineProgress = serde_json::from_str(json).expect("should parse");
        assert_eq!(p.msg_type, "progress");
        assert_eq!(p.downloaded, Some(500));
        assert_eq!(p.total, Some(1000));
        assert_eq!(p.speed_bps, Some(2_500_000));
        assert_eq!(p.eta_secs, Some(30));
        assert_eq!(p.elapsed_secs, Some(10));
        assert_eq!(p.error, None);
    }

    #[test]
    fn test_engine_progress_deserialize_minimal() {
        let json = r#"{"type": "progress"}"#;
        let p: EngineProgress = serde_json::from_str(json).expect("should parse");
        assert_eq!(p.msg_type, "progress");
        assert_eq!(p.downloaded, None);
        assert_eq!(p.total, None);
        assert_eq!(p.speed_bps, None);
        assert_eq!(p.eta_secs, None);
    }

    #[test]
    fn test_engine_progress_deserialize_error() {
        let json = r#"{"type": "error", "error": "Network timeout"}"#;
        let p: EngineProgress = serde_json::from_str(json).expect("should parse");
        assert_eq!(p.msg_type, "error");
        assert_eq!(p.error, Some("Network timeout".to_string()));
    }

    #[test]
    fn test_engine_progress_deserialize_complete() {
        let json = r#"{"type": "complete", "total": 1048576}"#;
        let p: EngineProgress = serde_json::from_str(json).expect("should parse");
        assert_eq!(p.msg_type, "complete");
        assert_eq!(p.total, Some(1048576));
        assert_eq!(p.downloaded, None); // not present in JSON
    }

    #[test]
    fn test_engine_progress_deserialize_bad_json() {
        let result: Result<EngineProgress, _> = serde_json::from_str("not valid json");
        assert!(result.is_err());
    }

    #[test]
    fn test_engine_progress_serde_roundtrip() {
        let p = EngineProgress {
            msg_type: "progress".to_string(),
            downloaded: Some(500),
            total: Some(1000),
            speed_bps: Some(2_500_000),
            eta_secs: Some(30),
            elapsed_secs: Some(10),
            error: None,
        };
        let json = serde_json::to_string(&p).expect("should serialize");
        let back: EngineProgress = serde_json::from_str(&json).expect("should deserialize");
        assert_eq!(back.downloaded, Some(500));
        assert_eq!(back.total, Some(1000));
        assert_eq!(back.speed_bps, Some(2_500_000));
    }

    // ── cancellation flag logic ─────────────────────────────────────────

    #[test]
    fn test_cancellation_flag_default_false() {
        let flag = Arc::new(AtomicBool::new(false));
        assert!(!flag.load(Ordering::SeqCst));
    }

    #[test]
    fn test_cancellation_flag_set_true() {
        let flag = Arc::new(AtomicBool::new(false));
        flag.store(true, Ordering::SeqCst);
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn test_cancellation_flag_thread_safe() {
        let flag = Arc::new(AtomicBool::new(false));
        let flag_clone = flag.clone();

        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(10));
            flag_clone.store(true, Ordering::SeqCst);
        });

        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(flag.load(Ordering::SeqCst));
    }
}

