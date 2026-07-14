use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use crate::config::Config;
use crate::formats::{detect_source, MediaSource};

/// State of a single download job.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct JobState {
    pub id: String,
    pub url: String,
    pub direct_url: Option<String>,
    pub file_name: String,
    pub save_path: String,
    pub status: String,
    pub downloaded: u64,
    pub total: u64,
    pub speed_bps: u64,
    pub eta_secs: u64,
    pub is_playlist: bool,
    pub error: Option<String>,
    /// Engine worker threads for this job (from payload or runtime settings).
    #[serde(default)]
    pub threads: Option<u32>,
}

/// CDNs that collapse when several multi-connection jobs share the uplink.
fn is_exclusive_cdn_job(job: &JobState) -> bool {
    let probe = job
        .direct_url
        .as_deref()
        .filter(|u| !u.is_empty())
        .unwrap_or(job.url.as_str());
    is_exclusive_cdn_url(probe) || is_exclusive_cdn_url(&job.url)
}

fn is_exclusive_cdn_url(url: &str) -> bool {
    if detect_source(url) == MediaSource::MediaFire {
        return true;
    }
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    host.contains("mediafire.com")
        || host.contains("hakunaymatata.com")
        || host.contains("aoneroom.com")
        || host.ends_with("googlevideo.com")
}

/// The download scheduler with a FIFO queue and concurrency cap.
#[allow(dead_code)]
pub struct Scheduler {
    config: Config,
    /// Live concurrency cap (updated from Settings UI / extension SET_SETTINGS).
    max_concurrent: AtomicU32,
    queue: Mutex<VecDeque<JobState>>,
    /// Active jobs: (id, exclusive_cdn). Exclusive CDNs run one-at-a-time so
    /// MediaFire + OmniSave don't starve each other to ~KB/s.
    active: Mutex<Vec<(String, bool)>>,
}

#[allow(dead_code)]
impl Scheduler {
    pub fn new(config: Config) -> Self {
        let max = config.max_concurrent_downloads.max(1);
        Self {
            config,
            max_concurrent: AtomicU32::new(max),
            queue: Mutex::new(VecDeque::new()),
            active: Mutex::new(Vec::new()),
        }
    }

    pub fn max_concurrent(&self) -> u32 {
        self.max_concurrent.load(Ordering::Relaxed).max(1)
    }

    pub fn set_max_concurrent(&self, n: u32) {
        self.max_concurrent
            .store(n.clamp(1, 64), Ordering::Relaxed);
    }

    /// Enqueue a new download job. Returns the job ID.
    pub fn enqueue(&self, job: JobState) {
        let id = job.id.clone();
        let len = {
            let mut queue = self.queue.lock().unwrap();
            queue.push_back(job);
            queue.len()
        };
        log::info!("Enqueued download {} (queue depth: {})", id, len);
    }

    /// Dequeue and mark as active. Returns None if queue is empty or cap reached.
    /// Skips exclusive-CDN jobs while another exclusive CDN download is active
    /// (other jobs may still start if slots remain).
    pub fn dequeue(&self) -> Option<JobState> {
        let mut active = self.active.lock().unwrap();
        if active.len() >= self.max_concurrent() as usize {
            return None;
        }
        let exclusive_busy = active.iter().any(|(_, ex)| *ex);
        let mut queue = self.queue.lock().unwrap();
        let idx = queue.iter().position(|j| {
            if exclusive_busy && is_exclusive_cdn_job(j) {
                false
            } else {
                true
            }
        })?;
        let job = queue.remove(idx).expect("index from position");
        let exclusive = is_exclusive_cdn_job(&job);
        if exclusive {
            log::info!(
                "Dequeued exclusive-CDN job {} (serialized: one CDN-heavy download at a time)",
                job.id
            );
        }
        active.push((job.id.clone(), exclusive));
        Some(job)
    }

    /// Mark a download as completed/removed from active.
    pub fn finish(&self, id: &str) {
        let mut active = self.active.lock().unwrap();
        active.retain(|(a, _)| a != id);
    }

    /// Remove a queued job by ID. Returns true if it was in the queue.
    pub fn remove_queued(&self, id: &str) -> bool {
        let mut queue = self.queue.lock().unwrap();
        let len_before = queue.len();
        queue.retain(|j| j.id != id);
        queue.len() < len_before
    }

    /// Get the current queue depth.
    pub fn queue_depth(&self) -> usize {
        self.queue.lock().unwrap().len()
    }

    /// Get active download count.
    pub fn active_count(&self) -> usize {
        self.active.lock().unwrap().len()
    }

    /// Get all jobs (queued + active) for snapshot.
    pub fn all_jobs(&self) -> Vec<JobState> {
        let queue = self.queue.lock().unwrap();
        let _active = self.active.lock().unwrap();
        let out: Vec<JobState> = queue.iter().cloned().collect();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    fn make_job(id: &str) -> JobState {
        JobState {
            id: id.to_string(),
            url: format!("https://example.com/{}", id),
            direct_url: None,
            file_name: format!("{}.mp4", id),
            save_path: format!("/tmp/{}.mp4", id),
            status: "queued".to_string(),
            downloaded: 0,
            total: 1000,
            speed_bps: 0,
            eta_secs: 0,
            is_playlist: false,
            error: None,
            threads: None,
        }
    }

    fn new_scheduler(max_concurrent: u32) -> Scheduler {
        // Construct Config directly to avoid env var pollution across parallel tests
        Scheduler::new(Config {
            max_concurrent_downloads: max_concurrent,
            port: 14921,
            default_threads: 8,
            max_rate_bytes: 0,
            min_free_disk_mb: 500,
            engine_quiet: true,
            engine_auto_tune: true,
            engine_read_buffer_bytes: 262144,
            base_dir: None,
            allowed_extension_ids: vec![],
            block_private_hosts: false,
            db_path: None,
        })
    }

    #[test]
    fn test_enqueue_dequeue() {
        let sched = new_scheduler(10);
        sched.enqueue(make_job("job1"));
        sched.enqueue(make_job("job2"));

        let j1 = sched.dequeue().expect("should dequeue job1");
        assert_eq!(j1.id, "job1");

        let j2 = sched.dequeue().expect("should dequeue job2");
        assert_eq!(j2.id, "job2");
    }

    #[test]
    fn test_dequeue_respects_concurrency_cap() {
        let sched = new_scheduler(2);
        sched.enqueue(make_job("job1"));
        sched.enqueue(make_job("job2"));
        sched.enqueue(make_job("job3"));

        // First two should dequeue
        assert!(sched.dequeue().is_some());
        assert!(sched.dequeue().is_some());
        // Third should be blocked by cap
        assert!(sched.dequeue().is_none());
    }

    #[test]
    fn test_finish_removes_from_active() {
        let sched = new_scheduler(10);
        sched.enqueue(make_job("job1"));
        sched.enqueue(make_job("job2"));

        let _j1 = sched.dequeue();
        let _j2 = sched.dequeue();

        assert_eq!(sched.active_count(), 2);
        sched.finish("job1");
        assert_eq!(sched.active_count(), 1);
    }

    #[test]
    fn test_finish_allows_more_dequeues() {
        let sched = new_scheduler(1);
        sched.enqueue(make_job("job1"));
        sched.enqueue(make_job("job2"));

        let _j1 = sched.dequeue();
        // queue blocked at cap=1
        assert!(sched.dequeue().is_none());

        sched.finish("job1");
        // Now job2 should be dequeued
        let j2 = sched.dequeue().expect("should dequeue after finish");
        assert_eq!(j2.id, "job2");
    }

    #[test]
    fn test_remove_queued() {
        let sched = new_scheduler(10);
        sched.enqueue(make_job("job1"));
        sched.enqueue(make_job("job2"));

        assert!(sched.remove_queued("job1"));
        assert_eq!(sched.queue_depth(), 1);
        // Second removal should fail
        assert!(!sched.remove_queued("job1"));
    }

    #[test]
    fn test_queue_depth() {
        let sched = new_scheduler(10);
        assert_eq!(sched.queue_depth(), 0);
        sched.enqueue(make_job("job1"));
        assert_eq!(sched.queue_depth(), 1);
        sched.enqueue(make_job("job2"));
        assert_eq!(sched.queue_depth(), 2);
    }

    #[test]
    fn test_active_count() {
        let sched = new_scheduler(10);
        assert_eq!(sched.active_count(), 0);
        sched.enqueue(make_job("job1"));
        sched.dequeue();
        assert_eq!(sched.active_count(), 1);
    }

    #[test]
    fn test_mediafire_serialized() {
        let sched = new_scheduler(4);
        {
            let mut q = sched.queue.lock().unwrap();
            q.push_back(JobState {
                id: "mf1".into(),
                url: "https://www.mediafire.com/file/aaa/a.mp4/file".into(),
                direct_url: None,
                file_name: "a.mp4".into(),
                save_path: "/tmp/a.mp4".into(),
                status: "queued".into(),
                downloaded: 0,
                total: 0,
                speed_bps: 0,
                eta_secs: 0,
                is_playlist: false,
                error: None,
                threads: None,
            });
            q.push_back(JobState {
                id: "mf2".into(),
                url: "https://www.mediafire.com/file/bbb/b.mp4/file".into(),
                direct_url: None,
                file_name: "b.mp4".into(),
                save_path: "/tmp/b.mp4".into(),
                status: "queued".into(),
                downloaded: 0,
                total: 0,
                speed_bps: 0,
                eta_secs: 0,
                is_playlist: false,
                error: None,
                threads: None,
            });
            q.push_back(JobState {
                id: "yt".into(),
                url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ".into(),
                direct_url: None,
                file_name: "yt.mp4".into(),
                save_path: "/tmp/yt.mp4".into(),
                status: "queued".into(),
                downloaded: 0,
                total: 0,
                speed_bps: 0,
                eta_secs: 0,
                is_playlist: false,
                error: None,
                threads: None,
            });
        }

        let j1 = sched.dequeue().expect("mf1");
        assert_eq!(j1.id, "mf1");
        // Second MediaFire blocked while mf1 active, but YouTube can start
        let j2 = sched.dequeue().expect("yt while mf busy");
        assert_eq!(j2.id, "yt");
        assert!(sched.dequeue().is_none(), "mf2 must wait");
        sched.finish("mf1");
        let j3 = sched.dequeue().expect("mf2 after mf1 done");
        assert_eq!(j3.id, "mf2");
    }

    #[test]
    fn test_dequeue_empty_returns_none() {
        let sched = new_scheduler(10);
        assert!(sched.dequeue().is_none());
    }

    #[test]
    fn test_all_jobs_returns_queued_only() {
        let sched = new_scheduler(10);
        sched.enqueue(make_job("job1"));
        sched.enqueue(make_job("job2"));
        sched.dequeue(); // job1 becomes active

        let jobs = sched.all_jobs();
        assert_eq!(jobs.len(), 1); // only job2 is still queued
        assert_eq!(jobs[0].id, "job2");
    }
}

