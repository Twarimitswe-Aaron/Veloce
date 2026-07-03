//! Adaptive piece sizing and range layout.

pub const MIN_PIECE_SIZE: u64 = 1 * 1024 * 1024;
pub const DEFAULT_PIECE_SIZE: u64 = 4 * 1024 * 1024;
pub const MAX_PIECE_SIZE: u64 = 16 * 1024 * 1024;

/// Pick piece size from file length and optional profile override (bytes).
pub fn adaptive_piece_size(total_size: u64, profile_piece: Option<u64>) -> u64 {
    if let Some(p) = profile_piece.filter(|&x| x > 0) {
        return p.clamp(MIN_PIECE_SIZE, MAX_PIECE_SIZE);
    }
    if total_size <= 32 * 1024 * 1024 {
        MIN_PIECE_SIZE
    } else if total_size <= 512 * 1024 * 1024 {
        DEFAULT_PIECE_SIZE
    } else {
        MAX_PIECE_SIZE
    }
}

/// BDP-inspired piece size: bandwidth (bytes/s) * RTT (seconds) * 2, clamped.
pub fn piece_size_from_bdp(bandwidth_bps: u64, rtt_ms: u64) -> u64 {
    if bandwidth_bps == 0 || rtt_ms == 0 {
        return DEFAULT_PIECE_SIZE;
    }
    let bdp = (bandwidth_bps as f64) * (rtt_ms as f64 / 1000.0) * 2.0;
    (bdp as u64).clamp(MIN_PIECE_SIZE, MAX_PIECE_SIZE)
}

pub fn piece_ranges(total_size: u64, piece_size: u64) -> Vec<(u64, u64)> {
    let piece_size = piece_size.max(1);
    let n = total_size.div_ceil(piece_size) as usize;
    (0..n)
        .map(|i| {
            let start = i as u64 * piece_size;
            let end = std::cmp::min(start + piece_size, total_size).saturating_sub(1);
            (start, end)
        })
        .collect()
}

pub fn num_pieces(total_size: u64, piece_size: u64) -> usize {
    total_size.div_ceil(piece_size.max(1)) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_file_uses_min_piece() {
        assert_eq!(adaptive_piece_size(10 * 1024 * 1024, None), MIN_PIECE_SIZE);
    }

    #[test]
    fn large_file_uses_max_piece() {
        assert_eq!(adaptive_piece_size(2 * 1024 * 1024 * 1024, None), MAX_PIECE_SIZE);
    }

    #[test]
    fn profile_override_respected() {
        assert_eq!(adaptive_piece_size(1000, Some(8 * 1024 * 1024)), 8 * 1024 * 1024);
    }

    #[test]
    fn piece_ranges_cover_file() {
        let ranges = piece_ranges(10_000_001, 4 * 1024 * 1024);
        let last = ranges.last().unwrap();
        assert_eq!(last.1 + 1, 10_000_001);
        let total: u64 = ranges.iter().map(|(s, e)| e - s + 1).sum();
        assert_eq!(total, 10_000_001);
    }

    #[test]
    fn bdp_clamps() {
        assert_eq!(piece_size_from_bdp(0, 50), DEFAULT_PIECE_SIZE);
        let p = piece_size_from_bdp(10_000_000, 100);
        assert!(p >= MIN_PIECE_SIZE && p <= MAX_PIECE_SIZE);
    }
}
