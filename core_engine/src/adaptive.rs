//! AIMD-style adaptive concurrency controller.

use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Debug)]
pub struct AdaptiveController {
    ceiling: usize,
    current: AtomicUsize,
    active: AtomicUsize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Transient,
    Permanent,
}

impl AdaptiveController {
    pub fn new(ceiling: usize) -> Self {
        let c = ceiling.max(1);
        Self {
            ceiling: c,
            current: AtomicUsize::new(c),
            active: AtomicUsize::new(0),
        }
    }

    pub fn ceiling(&self) -> usize {
        self.ceiling
    }

    pub fn current_limit(&self) -> usize {
        self.current.load(Ordering::Relaxed)
    }

    pub fn set_limit(&self, new_limit: usize) {
        let limit = new_limit.clamp(1, self.ceiling);
        self.current.store(limit, Ordering::SeqCst);
    }

    pub fn try_acquire_slot(&self) -> bool {
        loop {
            let a = self.active.load(Ordering::Relaxed);
            let m = self.current.load(Ordering::Relaxed);
            if a >= m {
                return false;
            }
            if self
                .active
                .compare_exchange(a, a + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return true;
            }
        }
    }

    pub fn release_slot(&self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }

    pub fn on_success(&self) {
        let m = self.current.load(Ordering::Relaxed);
        if m < self.ceiling {
            let _ = self.current.compare_exchange(m, m + 1, Ordering::SeqCst, Ordering::SeqCst);
        }
    }

    pub fn on_failure(&self, kind: FailureKind) {
        match kind {
            FailureKind::Permanent => {
                self.current.store(1, Ordering::SeqCst);
            }
            FailureKind::Transient => {
                let m = self.current.load(Ordering::SeqCst);
                if m > 1 {
                    let nm = std::cmp::max(1, m.saturating_sub(m / 2));
                    let _ = self.current.compare_exchange(m, nm, Ordering::SeqCst, Ordering::SeqCst);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ramps_up_on_success() {
        let c = AdaptiveController::new(4);
        c.current.store(2, Ordering::Relaxed);
        c.on_success();
        assert_eq!(c.current_limit(), 3);
    }

    #[test]
    fn multiplicative_decrease_on_transient() {
        let c = AdaptiveController::new(8);
        c.current.store(8, Ordering::Relaxed);
        c.on_failure(FailureKind::Transient);
        assert_eq!(c.current_limit(), 4);
    }

    #[test]
    fn permanent_failure_drops_to_one() {
        let c = AdaptiveController::new(8);
        c.on_failure(FailureKind::Permanent);
        assert_eq!(c.current_limit(), 1);
    }

    #[test]
    fn slot_acquire_respects_limit() {
        let c = AdaptiveController::new(2);
        c.current.store(1, Ordering::Relaxed);
        assert!(c.try_acquire_slot());
        assert!(!c.try_acquire_slot());
        c.release_slot();
        assert!(c.try_acquire_slot());
    }
}
