//! Linux io_uring backend for zero-syscall positioned writes.
//!
//! Uses `IORING_SETUP_SQPOLL` so the kernel polls the submission queue,
//! eliminating the `io_uring_enter` syscall for submission.
//! Each `write_at` submits a single `IORING_OP_WRITE` SQE and waits for
//! completion on the CQ — one wait syscall replaces one `pwrite` syscall.
//!
//! Each worker gets its **own** `IoUringEngine` (no Mutex, no sharing).
//! This avoids serialising writes — workers write to different file offsets
//! concurrently through independent io_uring instances, just as `pwrite`
//! would through independent kernel threads.
//!
//! Falls back gracefully to `None` if the kernel or permissions don't
//! support io_uring.

#![cfg(target_os = "linux")]

use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;

use io_uring::{opcode, types, IoUring};

/// Per-worker io_uring writer.
///
/// Not `Sync` — must not be shared across threads. Each worker creates its
/// own instance and moves it into its async task. `IoUring` is `Send` so
/// this is `Send` by default (no unsafe needed).
pub struct IoUringEngine {
    ring: IoUring,
    fd: i32,
}

impl IoUringEngine {
    /// Try to create an io_uring engine backed by `file`.
    ///
    /// Returns `None` if the kernel does not support io_uring or SQPOLL,
    /// or if the user lacks `CAP_SYS_ADMIN` / sufficient `memlock` rlimit.
    /// The caller should fall back to `pwrite` in that case.
    pub fn try_new(file: &File, entries: u32) -> io::Result<Option<Self>> {
        // Try with SQPOLL first (zero-syscall submission).
        // Idle timeout 2000ms before sqthread sleeps.
        let ring = match IoUring::builder().setup_sqpoll(2000).build(entries) {
            Ok(ring) => ring,
            Err(_) => {
                // SQPOLL may fail due to permissions; try a plain ring.
                match IoUring::new(entries) {
                    Ok(ring) => ring,
                    Err(_) => return Ok(None), // Kernel too old or no io_uring
                }
            }
        };

        let fd = file.as_raw_fd();
        Ok(Some(Self { ring, fd }))
    }

    /// Positioned write at `offset` using `IORING_OP_WRITE`.
    ///
    /// Blocks the calling thread until the write completes. The `data`
    /// buffer must remain valid until this function returns (it does —
    /// `submit_and_wait` guarantees completion before returning).
    pub fn write_at(&mut self, offset: u64, data: &[u8]) -> io::Result<()> {
        let write_e = opcode::Write::new(types::Fd(self.fd), data.as_ptr(), data.len() as u32)
            .offset(offset)
            .build()
            .user_data(1);

        unsafe {
            self.ring
                .submission()
                .push(&write_e)
                .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "submission queue full"))?;
        }

        // Submit pending SQEs and wait for at least one completion.
        // With SQPOLL the kernel thread would consume SQEs automatically,
        // but we still need `submit_and_wait` to block until the CQE lands.
        self.ring.submit_and_wait(1)?;

        let cqe = self
            .ring
            .completion()
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "completion queue empty"))?;

        let result = cqe.result();
        if result < 0 {
            Err(io::Error::from_raw_os_error(-result))
        } else if result as usize != data.len() {
            Err(io::Error::new(
                io::ErrorKind::WriteZero,
                format!("short write: {} of {} bytes", result, data.len()),
            ))
        } else {
            Ok(())
        }
    }
}
