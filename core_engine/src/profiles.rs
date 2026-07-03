//! Per-host download profiles (threads, piece size).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct HostProfile {
    #[serde(default)]
    pub threads: Option<u32>,
    #[serde(default)]
    pub piece_mb: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProfileStore {
    #[serde(default)]
    pub hosts: HashMap<String, HostProfile>,
    #[serde(default)]
    pub default: HostProfile,
}

impl ProfileStore {
    pub fn builtin() -> Self {
        let mut hosts = HashMap::new();
        hosts.insert(
            "mediafire.com".into(),
            HostProfile {
                threads: Some(4),
                piece_mb: Some(8),
            },
        );
        hosts.insert(
            "googlevideo.com".into(),
            HostProfile {
                threads: Some(6),
                piece_mb: Some(4),
            },
        );
        Self {
            hosts,
            default: HostProfile {
                threads: Some(8),
                piece_mb: Some(4),
            },
        }
    }

    pub fn load(path: Option<&Path>) -> Self {
        if let Some(p) = path {
            if let Ok(raw) = fs::read_to_string(p) {
                if let Ok(store) = serde_json::from_str::<ProfileStore>(&raw) {
                    return store;
                }
            }
        }
        Self::builtin()
    }

    pub fn match_host(&self, url: &str) -> HostProfile {
        let host = url::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
            .unwrap_or_default();

        for (pattern, profile) in &self.hosts {
            if host == pattern.to_lowercase() || host.ends_with(&format!(".{}", pattern.to_lowercase())) {
                return profile.clone();
            }
        }
        self.default.clone()
    }

    pub fn piece_bytes(&self, url: &str) -> Option<u64> {
        self.match_host(url)
            .piece_mb
            .map(|mb| (mb as u64) * 1024 * 1024)
    }

    pub fn thread_ceiling(&self, url: &str, cli_threads: u64) -> u64 {
        let p = self.match_host(url);
        p.threads
            .map(|t| t as u64)
            .unwrap_or(cli_threads)
            .min(cli_threads.max(1))
            .max(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_subdomain() {
        let store = ProfileStore::builtin();
        let p = store.match_host("https://download123.mediafire.com/x/y");
        assert_eq!(p.threads, Some(4));
    }

    #[test]
    fn googlevideo_profile() {
        let store = ProfileStore::builtin();
        let p = store.match_host("https://rr3---sn-abc.googlevideo.com/videoplayback?id=1");
        assert_eq!(p.threads, Some(6));
    }

    #[test]
    fn load_from_json_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        fs::write(
            &path,
            r#"{"hosts":{"example.com":{"threads":2,"piece_mb":1}},"default":{"threads":8,"piece_mb":4}}"#,
        )
        .unwrap();
        let store = ProfileStore::load(Some(&path));
        assert_eq!(store.match_host("https://cdn.example.com/f").threads, Some(2));
    }

    #[test]
    fn thread_ceiling_respects_cli_cap() {
        let store = ProfileStore::builtin();
        assert_eq!(store.thread_ceiling("https://x.com/a", 2), 2);
    }
}
