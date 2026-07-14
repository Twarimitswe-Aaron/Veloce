use std::env;
use std::path::PathBuf;

/// Veloce coordinator configuration loaded from environment variables.
pub struct Config {
    pub port: u16,
    pub max_concurrent_downloads: u32,
    pub default_threads: u32,
    pub max_rate_bytes: u64,
    pub min_free_disk_mb: u64,
    pub engine_quiet: bool,
    pub engine_auto_tune: bool,
    pub engine_read_buffer_bytes: u32,
    pub base_dir: Option<String>,
    pub allowed_extension_ids: Vec<String>,
    pub block_private_hosts: bool,
    pub db_path: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            port: env_var("VELOCE_PORT", 14921),
            max_concurrent_downloads: env_var("VELOCE_MAX_CONCURRENT_DOWNLOADS", 10),
            default_threads: env_var("VELOCE_DEFAULT_THREADS", 8),
            max_rate_bytes: env_var("VELOCE_MAX_RATE_BYTES", 0),
            min_free_disk_mb: env_var("VELOCE_MIN_FREE_DISK_MB", 500),
            engine_quiet: env_bool("VELOCE_ENGINE_QUIET", false),
            engine_auto_tune: env_bool("VELOCE_ENGINE_AUTO_TUNE", true),
            engine_read_buffer_bytes: env_var("VELOCE_ENGINE_READ_BUFFER_BYTES", 262144),
            base_dir: env::var("VELOCE_BASE_DIR").ok().filter(|s| !s.is_empty()),
            allowed_extension_ids: env::var("VELOCE_ALLOWED_EXTENSION_IDS")
                .ok()
                .map(|s| s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect())
                .unwrap_or_default(),
            block_private_hosts: env_bool("VELOCE_BLOCK_PRIVATE_HOSTS", true),
            db_path: env::var("VELOCE_DB_PATH").ok().filter(|s| !s.is_empty()),
        }
    }

    /// Shared SQLite path — same default as the Node backend when VELOCE_DB_PATH is unset.
    pub fn database_path(&self) -> PathBuf {
        if let Some(path) = &self.db_path {
            return PathBuf::from(path);
        }
        dirs::data_dir()
            .unwrap_or(PathBuf::from("."))
            .join("Veloce")
            .join("veloce.db")
    }

    pub fn base_directory(&self) -> PathBuf {
        if let Some(dir) = &self.base_dir {
            return ensure_media_download_dir(PathBuf::from(dir));
        }
        ensure_media_download_dir(
            dirs::home_dir()
                .unwrap_or(PathBuf::from("."))
                .join("Downloads")
                .join("Veloce"),
        )
    }
}

/// If `dir` looks like the Veloce source tree (AGENTS.md + core_engine / .git),
/// store downloads under `dir/media` so videos never mix with source.
pub fn ensure_media_download_dir(dir: PathBuf) -> PathBuf {
    if looks_like_veloce_source_tree(&dir) {
        let media = dir.join("media");
        let _ = std::fs::create_dir_all(&media);
        log::warn!(
            "[Config] Download folder looks like the Veloce source tree ({}); using {} instead",
            dir.display(),
            media.display()
        );
        return media;
    }
    dir
}

fn looks_like_veloce_source_tree(dir: &std::path::Path) -> bool {
    let agents = dir.join("AGENTS.md").is_file();
    let engine = dir.join("core_engine").is_dir();
    let desktop = dir.join("desktop").is_dir();
    let git = dir.join(".git").exists();
    (agents && (engine || desktop)) || (git && engine && desktop)
}

fn env_var<T: std::str::FromStr>(key: &str, default: T) -> T {
    env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn env_bool(key: &str, default: bool) -> bool {
    match env::var(key) {
        Ok(v) => matches!(v.to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        Err(_) => default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn source_tree_redirects_to_media() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("AGENTS.md"), "x").unwrap();
        fs::create_dir(dir.path().join("core_engine")).unwrap();
        fs::create_dir(dir.path().join("desktop")).unwrap();
        let out = ensure_media_download_dir(dir.path().to_path_buf());
        assert_eq!(out, dir.path().join("media"));
        assert!(out.is_dir());
    }

    #[test]
    fn plain_folder_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let out = ensure_media_download_dir(dir.path().to_path_buf());
        assert_eq!(out, dir.path());
    }
}
