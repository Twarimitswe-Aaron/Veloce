//! Global token-bucket rate limiter (0 = disabled).

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub struct RateLimiter {
    rate: u64,
    /// Fast path when unlimited.
    state: Option<Mutex<(f64, Instant)>>,
    /// Lock-free counter for unlimited mode stats only.
    _bypass: AtomicU64,
}

impl RateLimiter {
    pub fn new(rate: u64) -> Self {
        Self {
            rate,
            state: if rate == 0 { None } else { Some(Mutex::new((0.0, Instant::now()))) },
            _bypass: AtomicU64::new(0),
        }
    }

    pub async fn acquire(&self, mut n: u64) {
        if self.rate == 0 {
            self._bypass.fetch_add(n, Ordering::Relaxed);
            return;
        }
        let cap = self.rate as f64;
        let state = self.state.as_ref().unwrap();
        while n > 0 {
            let mut g = state.lock().await;
            let now = Instant::now();
            let elapsed = now.duration_since(g.1).as_secs_f64();
            g.0 = (g.0 + elapsed * self.rate as f64).min(cap);
            g.1 = now;
            if g.0 >= 1.0 {
                let take = g.0.min(n as f64);
                g.0 -= take;
                n -= take as u64;
            } else {
                let wait = (1.0 - g.0) / self.rate as f64;
                drop(g);
                tokio::time::sleep(Duration::from_secs_f64(wait.clamp(0.005, 0.2))).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unlimited_is_instant() {
        let lim = RateLimiter::new(0);
        let start = Instant::now();
        lim.acquire(1_000_000).await;
        assert!(start.elapsed() < Duration::from_millis(50));
    }

    #[tokio::test]
    async fn capped_limits_throughput() {
        let lim = RateLimiter::new(100_000);
        let start = Instant::now();
        lim.acquire(50_000).await;
        lim.acquire(50_000).await;
        assert!(start.elapsed() >= Duration::from_millis(200));
    }
}
