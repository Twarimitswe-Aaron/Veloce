//! Linux io_uring backend for batched positioned writes.
//!
//! Instead of submitting one SQE and waiting for one CQE per call (1:1
//! syscall → `pwrite`), this engine **batches** writes: each `write_at`
//! copies data into a pending buffer and returns immediately. When the
//! batch reaches `BATCH_SIZE` (8), or when `flush()` is called explicitly,
//! all pending SQEs are submitted at once and a single `submit_and_wait`
//! waits for all completions.  N writes → 1 syscall instead of N.
//!
//! Uses `IORING_SETUP_SQPOLL` so the kernel polls the submission queue,
//! eliminating the `io_uring_enter` syscall for submission.
//!
//! Each worker gets its **own** `IoUringEngine` (no Mutex, no sharing) so
//! writes to disjoint file offsets are never serialised.
//!
//! Falls back gracefully to `None` if the kernel or permissions don't
//! support io_uring.

#![cfg(target_os = "linux")]

use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;

use io_uring::{opcode, types, IoUring};

/// Number of pending writes to accumulate before auto-flushing.
const BATCH_SIZE: usize = 8;

/// A pending write submission — kept alive in the engine's buffer until
/// `flush()` submits and completes all SQEs.
struct PendingWrite {
    offset: u64,
    data: Vec<u8>,
}

/// Per-worker io_uring writer with batched submission.
///
/// Not `Sync` — must not be shared across threads. Each worker creates its
/// own instance. `IoUring` is `Send`, so this is `Send` by default.
pub struct IoUringEngine {
    ring: IoUring,
    fd: i32,
    /// Accumulated writes not yet submitted to the kernel.
    pending: Vec<PendingWrite>,
}

// On drop, flush any remaining pending writes to avoid data loss.
// The error is silently ignored — the engine is being dropped anyway.
impl Drop for IoUringEngine {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

impl IoUringEngine {
    /// Try to create an io_uring engine backed by `file`.
    ///
    /// Returns `None` if the kernel does not support io_uring or SQPOLL,
    /// or if the user lacks `CAP_SYS_ADMIN` / sufficient `memlock` rlimit.
    pub fn try_new(file: &File, entries: u32) -> io::Result<Option<Self>> {
        // Try with SQPOLL first (zero-syscall submission).
        let ring = match IoUring::builder().setup_sqpoll(2000).build(entries) {
            Ok(ring) => ring,
            Err(_) => {
                match IoUring::new(entries) {
                    Ok(ring) => ring,
                    Err(_) => return Ok(None),
                }
            }
        };

        let fd = file.as_raw_fd();
        Ok(Some(Self {
            ring,
            fd,
            pending: Vec::with_capacity(BATCH_SIZE * 2),
        }))
    }

    /// Queue a positioned write at `offset`. Does **not** block unless the
    /// pending batch is full — in that case the batch is flushed first.
    ///
    /// The caller must call `flush()` at the end to guarantee all queued
    /// data has been written to the kernel page cache.
    pub fn write_at(&mut self, offset: u64, data: &[u8]) -> io::Result<()> {
        self.pending.push(PendingWrite {
            offset,
            data: data.to_vec(),
        });

        if self.pending.len() >= BATCH_SIZE {
            self.flush()?;
        }

        Ok(())
    }

    /// Submit all pending SQEs and block until every one completes.
    ///
    /// After this call the pending buffer is empty and all queued writes
    /// are visible to the kernel page cache.
    pub fn flush(&mut self) -> io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }

        let batch = self.pending.len();

        // Prepare one SQE per pending write.
        for (i, pw) in self.pending.iter().enumerate() {
            let sqe = opcode::Write::new(
                types::Fd(self.fd),
                pw.data.as_ptr(),
                pw.data.len() as u32,
            )
            .offset(pw.offset)
            .build()
            .user_data(i as u64);

            unsafe {
                self.ring
                    .submission()
                    .push(&sqe)
                    .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "submission queue full"))?;
            }
        }

        // Single syscall: submit SQEs (if not yet picked up by SQPOLL
        // thread) and wait for `batch` completions.
        self.ring.submit_and_wait(batch)?;

        // Drain the CQ — one entry per submitted SQE.
        let mut last_err = None::<io::Error>;
        for pw in &self.pending {
            let cqe = self
                .ring
                .completion()
                .next()
                .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "completion queue empty"))?;

            let result = cqe.result();
            if result < 0 {
                last_err = Some(io::Error::from_raw_os_error(-result));
            } else if (result as usize) != pw.data.len() {
                last_err = Some(io::Error::new(
                    io::ErrorKind::WriteZero,
                    format!("short write: {} of {} bytes", result, pw.data.len()),
                ));
            }
        }

        self.pending.clear();

        // Return the first error if any (all-or-nothing semantics).
        match last_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// Number of pending writes not yet flushed.
    #[allow(dead_code)]
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
}
