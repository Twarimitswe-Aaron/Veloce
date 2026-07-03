//! Binary resume state (compact bitmap) with JSON legacy fallback.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

pub const MAGIC: &[u8; 4] = b"VELR";
pub const VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResumeState {
    pub piece_size: u64,
    pub total_size: u64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub completed: Vec<bool>,
}

impl ResumeState {
    pub fn completed_count(&self) -> usize {
        self.completed.iter().filter(|c| **c).count()
    }

    pub fn to_binary(&self) -> Vec<u8> {
        let etag = self.etag.as_deref().unwrap_or("").as_bytes();
        let lm = self.last_modified.as_deref().unwrap_or("").as_bytes();
        let n = self.completed.len();
        let bitmap_len = n.div_ceil(8);
        let mut out = Vec::with_capacity(32 + etag.len() + lm.len() + bitmap_len);
        out.extend_from_slice(MAGIC);
        out.push(VERSION);
        out.extend_from_slice(&self.piece_size.to_le_bytes());
        out.extend_from_slice(&self.total_size.to_le_bytes());
        out.extend_from_slice(&(etag.len() as u16).to_le_bytes());
        out.extend_from_slice(&(lm.len() as u16).to_le_bytes());
        out.extend_from_slice(etag);
        out.extend_from_slice(lm);
        out.extend_from_slice(&(n as u32).to_le_bytes());
        let mut bitmap = vec![0u8; bitmap_len];
        for (i, done) in self.completed.iter().enumerate() {
            if *done {
                bitmap[i / 8] |= 1 << (i % 8);
            }
        }
        out.extend_from_slice(&bitmap);
        out
    }

    pub fn from_binary(data: &[u8]) -> Option<Self> {
        if data.len() < 24 || &data[0..4] != MAGIC || data[4] != VERSION {
            return None;
        }
        let piece_size = u64::from_le_bytes(data[5..13].try_into().ok()?);
        let total_size = u64::from_le_bytes(data[13..21].try_into().ok()?);
        let etag_len = u16::from_le_bytes(data[21..23].try_into().ok()?) as usize;
        let lm_len = u16::from_le_bytes(data[23..25].try_into().ok()?) as usize;
        let mut off = 25;
        let etag_end = off + etag_len;
        let lm_end = etag_end + lm_len;
        if data.len() < lm_end + 4 {
            return None;
        }
        let etag = if etag_len > 0 {
            Some(String::from_utf8(data[off..etag_end].to_vec()).ok()?)
        } else {
            None
        };
        off = etag_end;
        let last_modified = if lm_len > 0 {
            Some(String::from_utf8(data[off..lm_end].to_vec()).ok()?)
        } else {
            None
        };
        off = lm_end;
        let n = u32::from_le_bytes(data[off..off + 4].try_into().ok()?) as usize;
        off += 4;
        let bitmap_len = n.div_ceil(8);
        if data.len() < off + bitmap_len {
            return None;
        }
        let bitmap = &data[off..off + bitmap_len];
        let mut completed = vec![false; n];
        for (i, slot) in completed.iter_mut().enumerate() {
            *slot = (bitmap[i / 8] & (1 << (i % 8))) != 0;
        }
        Some(Self {
            piece_size,
            total_size,
            etag,
            last_modified,
            completed,
        })
    }

    pub fn from_json(data: &str) -> Option<Self> {
        serde_json::from_str(data).ok()
    }

    pub fn load(path: &Path) -> Option<Self> {
        let raw = fs::read(path).ok()?;
        if raw.starts_with(MAGIC) {
            return Self::from_binary(&raw);
        }
        Self::from_json(std::str::from_utf8(&raw).ok()?)
    }

    pub fn save_atomic(path: &Path, state: &ResumeState) -> std::io::Result<()> {
        let tmp = format!("{}.tmp", path.display());
        let bin = state.to_binary();
        fs::write(&tmp, bin)?;
        fs::rename(tmp, path)
    }
}

pub fn validators_match(
    state: &ResumeState,
    etag: &Option<String>,
    last_modified: &Option<String>,
) -> bool {
    if let (Some(a), Some(b)) = (&state.etag, etag) {
        if a != b {
            return false;
        }
    }
    if let (Some(a), Some(b)) = (&state.last_modified, last_modified) {
        if a != b {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ResumeState {
        ResumeState {
            piece_size: 4 * 1024 * 1024,
            total_size: 100,
            etag: Some("\"abc\"".into()),
            last_modified: Some("Mon".into()),
            completed: vec![true, false, true, false, true],
        }
    }

    #[test]
    fn binary_roundtrip() {
        let s = sample();
        let bin = s.to_binary();
        let back = ResumeState::from_binary(&bin).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn json_legacy_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state");
        let json = serde_json::to_string(&sample()).unwrap();
        fs::write(&path, json).unwrap();
        let loaded = ResumeState::load(&path).unwrap();
        assert_eq!(loaded.completed.len(), 5);
    }

    #[test]
    fn save_atomic_binary() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state");
        ResumeState::save_atomic(&path, &sample()).unwrap();
        let loaded = ResumeState::load(&path).unwrap();
        assert_eq!(loaded.piece_size, 4 * 1024 * 1024);
        assert!(path.exists());
        let raw = fs::read(&path).unwrap();
        assert_eq!(&raw[0..4], MAGIC);
    }

    #[test]
    fn validators_mismatch_etag() {
        let s = sample();
        assert!(!validators_match(&s, &Some("other".into()), &None));
    }
}
