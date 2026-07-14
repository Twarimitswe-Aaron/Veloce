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

/// Write binary resume state directly from an `AtomicBool` slice,
/// avoiding the intermediate `Vec<bool>` allocation and one full pass.
pub fn save_bitmap_atomic(
    path: &Path,
    piece_size: u64,
    total_size: u64,
    etag: &Option<String>,
    last_modified: &Option<String>,
    completed: &[std::sync::atomic::AtomicBool],
) -> std::io::Result<()> {
    let tmp = format!("{}.tmp", path.display());

    let etag_bytes = etag.as_deref().unwrap_or("").as_bytes();
    let lm_bytes = last_modified.as_deref().unwrap_or("").as_bytes();
    let n = completed.len();
    let bitmap_len = n.div_ceil(8);

    let mut out = Vec::with_capacity(32 + etag_bytes.len() + lm_bytes.len() + bitmap_len);
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&piece_size.to_le_bytes());
    out.extend_from_slice(&total_size.to_le_bytes());
    out.extend_from_slice(&(etag_bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(&(lm_bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(etag_bytes);
    out.extend_from_slice(lm_bytes);
    out.extend_from_slice(&(n as u32).to_le_bytes());

    // Build bitmap directly from AtomicBool — no intermediate Vec<bool>
    let mut bitmap = vec![0u8; bitmap_len];
    for (i, slot) in completed.iter().enumerate() {
        if slot.load(std::sync::atomic::Ordering::Relaxed) {
            bitmap[i / 8] |= 1 << (i % 8);
        }
    }
    out.extend_from_slice(&bitmap);

    fs::write(&tmp, out)?;
    fs::rename(tmp, path)
}

/// Soft CDN validators. Callers must already enforce `total_size` / `piece_size`.
///
/// Tokenized hosts (MediaFire, signed S3, etc.) rotate ETag / Last-Modified on
/// every re-resolve. Hard-matching those would wipe valid piece bitmaps and
/// restart from zero. We only reject when **both** validators are present on
/// both sides and **both** differ (strong signal the object was replaced).
pub fn validators_match(
    state: &ResumeState,
    etag: &Option<String>,
    last_modified: &Option<String>,
) -> bool {
    let etag_mismatch = matches!(
        (&state.etag, etag),
        (Some(a), Some(b)) if a != b
    );
    let lm_mismatch = matches!(
        (&state.last_modified, last_modified),
        (Some(a), Some(b)) if a != b
    );
    !(etag_mismatch && lm_mismatch)
}

/// Hidden resume dir next to the save file: `{parent}/.veloce/{filename}.state|.done`.
/// Migrates legacy `{save}.veloce_state` / `{save}.veloce_done` on first touch.
pub fn sidecar_paths(save_path: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let parent = save_path.parent().unwrap_or_else(|| Path::new("."));
    let name = save_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    let dir = parent.join(".veloce");
    let state = dir.join(format!("{name}.state"));
    let done = dir.join(format!("{name}.done"));
    (state, done)
}

pub fn ensure_sidecar_dir(save_path: &Path) -> std::io::Result<std::path::PathBuf> {
    let parent = save_path.parent().unwrap_or_else(|| Path::new("."));
    let dir = parent.join(".veloce");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Resolve state path, migrating legacy adjacent sidecar if present.
pub fn resolve_state_path(save_path: &Path) -> std::path::PathBuf {
    let (state, _) = sidecar_paths(save_path);
    if state.exists() {
        return state;
    }
    let legacy = Path::new(&format!("{}.veloce_state", save_path.display())).to_path_buf();
    if legacy.exists() {
        let _ = ensure_sidecar_dir(save_path);
        if fs::rename(&legacy, &state).is_err() {
            if let Ok(bytes) = fs::read(&legacy) {
                let _ = fs::write(&state, bytes);
                let _ = fs::remove_file(&legacy);
            }
        }
    }
    state
}

/// Resolve done sidecar, migrating legacy if present.
pub fn resolve_done_path(save_path: &Path) -> std::path::PathBuf {
    let (_, done) = sidecar_paths(save_path);
    if done.exists() {
        return done;
    }
    let legacy = Path::new(&format!("{}.veloce_done", save_path.display())).to_path_buf();
    if legacy.exists() {
        let _ = ensure_sidecar_dir(save_path);
        if fs::rename(&legacy, &done).is_err() {
            if let Ok(bytes) = fs::read(&legacy) {
                let _ = fs::write(&done, bytes);
                let _ = fs::remove_file(&legacy);
            }
        }
    }
    done
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
    fn save_bitmap_atomic_roundtrip() {
        use std::sync::atomic::AtomicBool;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state");

        let completed: Vec<AtomicBool> = vec![true, false, true, false, true]
            .into_iter()
            .map(AtomicBool::new)
            .collect();

        save_bitmap_atomic(
            &path,
            4 * 1024 * 1024,
            100,
            &Some("\"abc\"".into()),
            &Some("Mon".into()),
            &completed,
        )
        .unwrap();

        let loaded = ResumeState::load(&path).unwrap();
        assert_eq!(loaded.piece_size, 4 * 1024 * 1024);
        assert_eq!(loaded.total_size, 100);
        assert_eq!(loaded.completed, vec![true, false, true, false, true]);
        assert_eq!(loaded.etag, Some("\"abc\"".into()));
        assert_eq!(loaded.last_modified, Some("Mon".into()));

        // Verify binary format matches to_binary()
        let s = sample();
        let bin_from_state = s.to_binary();
        let raw = std::fs::read(&path).unwrap();
        assert_eq!(raw, bin_from_state, "save_bitmap_atomic must produce identical binary to to_binary()");
    }

    #[test]
    fn validators_soft_etag_rotation() {
        let s = sample();
        // ETag alone rotating (MediaFire CDN) must still resume.
        assert!(validators_match(&s, &Some("other".into()), &None));
        assert!(validators_match(&s, &Some("\"abc\"".into()), &None));
    }

    #[test]
    fn validators_reject_when_both_etag_and_lm_mismatch() {
        let s = sample();
        assert!(!validators_match(
            &s,
            &Some("other-etag".into()),
            &Some("other-lm".into()),
        ));
        // Matching etags OK even if LM differs
        assert!(validators_match(&s, &Some("\"abc\"".into()), &Some("Tue".into())));
    }

    #[test]
    fn validators_allow_missing_state_etag() {
        let mut s = sample();
        s.etag = None;
        s.last_modified = None;
        assert!(validators_match(&s, &Some("\"new\"".into()), &Some("Mon".into())));
    }
}
