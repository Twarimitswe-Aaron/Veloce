//! Cross-platform disk helpers: preallocate, free space, positioned writes.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;
use std::sync::Arc;

/// Shared output file for all workers — positioned writes avoid per-piece open/seek.
#[derive(Clone)]
pub struct SharedOutput {
    inner: Arc<File>,
}

impl SharedOutput {
    pub fn create_or_open(path: &Path, truncate: bool) -> io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(truncate)
            .open(path)?;
        Ok(Self {
            inner: Arc::new(file),
        })
    }

    pub fn open_existing(path: &Path) -> io::Result<Self> {
        let file = OpenOptions::new().read(true).write(true).open(path)?;
        Ok(Self {
            inner: Arc::new(file),
        })
    }

    pub fn write_at(&self, offset: u64, data: &[u8]) -> io::Result<()> {
        write_at_platform(&self.inner, offset, data)
    }

    pub fn preallocate(&self, len: u64) -> io::Result<()> {
        preallocate_file(&self.inner, len)
    }
}

/// Platform-specific positioned write (Unix `pwrite`, Windows `seek_write`).
pub fn write_at_platform(file: &File, offset: u64, data: &[u8]) -> io::Result<()> {
    let mut written = 0usize;
    while written < data.len() {
        let n = write_at_once(file, offset + written as u64, &data[written..])?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::WriteZero, "short write"));
        }
        written += n;
    }
    Ok(())
}

#[cfg(unix)]
fn write_at_once(file: &File, offset: u64, data: &[u8]) -> io::Result<usize> {
    use std::os::unix::fs::FileExt;
    file.write_at(data, offset)
}

#[cfg(windows)]
fn write_at_once(file: &File, offset: u64, data: &[u8]) -> io::Result<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_write(data, offset)
}

#[cfg(not(any(unix, windows)))]
fn write_at_once(file: &File, offset: u64, data: &[u8]) -> io::Result<usize> {
    use std::io::{Seek, SeekFrom};
    let mut f = file;
    f.seek(SeekFrom::Start(offset))?;
    f.write(data)
}

pub fn preallocate_file(file: &File, len: u64) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::io::AsRawFd;
        let ret = unsafe { libc::posix_fallocate(file.as_raw_fd(), 0, len as libc::off_t) };
        if ret == 0 {
            return Ok(());
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::os::unix::io::AsRawFd;
        let fd = file.as_raw_fd();
        let mut store = libc::fstore_t {
            fst_flags: libc::F_ALLOCATECONTIG,
            fst_posmode: libc::F_PEOFPOSMODE,
            fst_offset: 0,
            fst_length: len as i64,
            fst_bytesalloc: 0,
        };
        let ret = unsafe { libc::fcntl(fd, libc::F_PREALLOCATE, &store) };
        if ret != -1 {
            return file.set_len(len);
        }
    }

    file.set_len(len)
}

pub fn available_space(path: &Path) -> Option<u64> {
    let mut dir = path.parent().unwrap_or_else(|| Path::new("."));
    loop {
        if dir.exists() {
            return fs2::available_space(dir).ok();
        }
        dir = dir.parent()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn positioned_write_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.bin");
        let out = SharedOutput::create_or_open(&path, true).unwrap();
        out.preallocate(100).unwrap();
        out.write_at(10, b"hello").unwrap();
        out.write_at(0, b"ab").unwrap();

        let mut f = File::open(&path).unwrap();
        let mut buf = vec![0u8; 20];
        f.read_exact(&mut buf[..15]).unwrap();
        assert_eq!(&buf[0..2], b"ab");
        assert_eq!(&buf[10..15], b"hello");
    }

    #[test]
    fn preallocate_sets_length() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        let out = SharedOutput::create_or_open(&path, true).unwrap();
        out.preallocate(4096).unwrap();
        assert_eq!(path.metadata().unwrap().len(), 4096);
    }

    #[test]
    fn available_space_returns_some_on_real_fs() {
        let dir = tempfile::tempdir().unwrap();
        let free = available_space(dir.path());
        assert!(free.is_some());
        assert!(free.unwrap() > 0);
    }
}
