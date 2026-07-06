use rusqlite::{Connection, params};
use std::path::Path;
use std::sync::Mutex;

/// Wraps the SQLite connection behind a Mutex for thread-safe access.
pub struct Database {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DownloadRow {
    pub id: String,
    pub device_id: String,
    pub url: String,
    pub direct_url: Option<String>,
    pub referer: Option<String>,
    pub file_name: String,
    pub save_path: String,
    pub status: String,
    pub total_bytes: Option<i64>,
    pub downloaded_bytes: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[allow(dead_code)]
pub struct DeviceRow {
    pub id: String,
    pub created_at: i64,
    pub last_active: i64,
    pub settings: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[allow(dead_code)]
pub struct PlaylistJobRow {
    pub id: String,
    pub device_id: String,
    pub playlist_url: String,
    pub title: String,
    pub save_dir: String,
    pub status: String,
    pub current_index: i64,
    pub total_tracks: i64,
    pub completed_tracks: i64,
    pub failed_tracks: i64,
    pub entries: String,
    pub settings: Option<String>,
    pub referer: Option<String>,
    pub threads: i64,
    pub current_track_title: Option<String>,
    pub error: Option<String>,
    pub failed_indices: Option<String>,
    pub downloaded_bytes: Option<i64>,
    pub total_bytes: Option<i64>,
    pub created_at: i64,
}

impl Database {
    pub fn open(db_path: &Path) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(db_path)?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    /// In-memory database for unit/integration tests.
    pub fn open_in_memory() -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_in_memory()?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    /// Create tables if they don't exist, and add columns introduced after first release.
    fn migrate(&self) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                last_active INTEGER NOT NULL,
                settings TEXT
            );

            CREATE TABLE IF NOT EXISTS downloads (
                id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL REFERENCES devices(id),
                url TEXT NOT NULL,
                direct_url TEXT,
                referer TEXT,
                file_name TEXT NOT NULL,
                save_path TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                total_bytes INTEGER,
                downloaded_bytes INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS playlist_jobs (
                id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL REFERENCES devices(id),
                playlist_url TEXT NOT NULL,
                title TEXT NOT NULL,
                save_dir TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                current_index INTEGER NOT NULL DEFAULT 0,
                total_tracks INTEGER NOT NULL,
                completed_tracks INTEGER NOT NULL DEFAULT 0,
                failed_tracks INTEGER NOT NULL DEFAULT 0,
                entries TEXT NOT NULL,
                settings TEXT,
                referer TEXT,
                threads INTEGER NOT NULL DEFAULT 8,
                current_track_title TEXT,
                error TEXT,
                failed_indices TEXT,
                downloaded_bytes INTEGER DEFAULT 0,
                total_bytes INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL
            );"
        )?;

        // Attempt column additions (may already exist — ignore errors).
        for sql in &[
            "ALTER TABLE downloads ADD COLUMN direct_url TEXT",
            "ALTER TABLE downloads ADD COLUMN referer TEXT",
            "ALTER TABLE playlist_jobs ADD COLUMN failed_indices TEXT",
        ] {
            let _ = conn.execute(sql, []);
        }

        Ok(())
    }

    // ── Devices (wired in P2: settings / device tracking) ────────────────

    #[allow(dead_code)]
    pub fn upsert_device(&self, id: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO devices (id, created_at, last_active, settings)
             VALUES (?1, ?2, ?3, '{}')
             ON CONFLICT(id) DO UPDATE SET last_active = ?3",
            params![id, chrono::Utc::now().timestamp(), chrono::Utc::now().timestamp()],
        )?;
        Ok(())
    }

    pub fn get_device_settings(&self, id: &str) -> Result<Option<String>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT settings FROM devices WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(row.get::<_, Option<String>>(0)?),
            None => Ok(None),
        }
    }

    pub fn update_device_settings(&self, id: &str, settings: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE devices SET settings = ?1, last_active = ?2 WHERE id = ?3",
            params![settings, chrono::Utc::now().timestamp(), id],
        )?;
        Ok(())
    }

    // ── Downloads ─────────────────────────────────────────────────────────

    pub fn insert_download(&self, row: &DownloadRow) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO downloads (id, device_id, url, direct_url, referer, file_name, save_path, status, total_bytes, downloaded_bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                row.id, row.device_id, row.url, row.direct_url, row.referer,
                row.file_name, row.save_path, row.status, row.total_bytes, row.downloaded_bytes
            ],
        )?;
        Ok(())
    }

    pub fn update_download_status(&self, id: &str, status: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE downloads SET status = ?1 WHERE id = ?2",
            params![status, id],
        )?;
        Ok(())
    }

    pub fn update_download_progress(&self, id: &str, downloaded: i64, total: i64) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE downloads SET downloaded_bytes = ?1, total_bytes = ?2 WHERE id = ?3",
            params![downloaded, total, id],
        )?;
        Ok(())
    }

    pub fn get_download(&self, id: &str) -> Result<Option<DownloadRow>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, device_id, url, direct_url, referer, file_name, save_path, status, total_bytes, downloaded_bytes
             FROM downloads WHERE id = ?1"
        )?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(DownloadRow {
                id: row.get(0)?,
                device_id: row.get(1)?,
                url: row.get(2)?,
                direct_url: row.get(3)?,
                referer: row.get(4)?,
                file_name: row.get(5)?,
                save_path: row.get(6)?,
                status: row.get(7)?,
                total_bytes: row.get(8)?,
                downloaded_bytes: row.get(9)?,
            })),
            None => Ok(None),
        }
    }

    pub fn list_recent_downloads(&self, device_id: &str, limit: i64) -> Result<Vec<DownloadRow>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, device_id, url, direct_url, referer, file_name, save_path, status, total_bytes, downloaded_bytes
             FROM downloads WHERE device_id = ?1 ORDER BY rowid DESC LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![device_id, limit], |row| {
            Ok(DownloadRow {
                id: row.get(0)?,
                device_id: row.get(1)?,
                url: row.get(2)?,
                direct_url: row.get(3)?,
                referer: row.get(4)?,
                file_name: row.get(5)?,
                save_path: row.get(6)?,
                status: row.get(7)?,
                total_bytes: row.get(8)?,
                downloaded_bytes: row.get(9)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    #[allow(dead_code)]
    pub fn list_interrupted_downloads(&self) -> Result<Vec<DownloadRow>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, device_id, url, direct_url, referer, file_name, save_path, status, total_bytes, downloaded_bytes
             FROM downloads WHERE status IN ('downloading', 'queued')"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(DownloadRow {
                id: row.get(0)?,
                device_id: row.get(1)?,
                url: row.get(2)?,
                direct_url: row.get(3)?,
                referer: row.get(4)?,
                file_name: row.get(5)?,
                save_path: row.get(6)?,
                status: row.get(7)?,
                total_bytes: row.get(8)?,
                downloaded_bytes: row.get(9)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    #[allow(dead_code)]
    pub fn delete_download(&self, id: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM downloads WHERE id = ?1", params![id])?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn has_download_with_url(&self, url: &str) -> Result<bool, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT COUNT(*) FROM downloads WHERE url = ?1 AND status IN ('queued', 'downloading', 'completed')")?;
        let count: i64 = stmt.query_row(params![url], |row| row.get(0))?;
        Ok(count > 0)
    }

    // ── Playlist Jobs ─────────────────────────────────────────────────────

    pub fn insert_playlist_job(&self, row: &PlaylistJobRow) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO playlist_jobs (id, device_id, playlist_url, title, save_dir, status, current_index, total_tracks, completed_tracks, failed_tracks, entries, settings, referer, threads, current_track_title, error, failed_indices, downloaded_bytes, total_bytes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                row.id, row.device_id, row.playlist_url, row.title, row.save_dir,
                row.status, row.current_index, row.total_tracks, row.completed_tracks,
                row.failed_tracks, row.entries, row.settings, row.referer, row.threads,
                row.current_track_title, row.error, row.failed_indices,
                row.downloaded_bytes, row.total_bytes, row.created_at
            ],
        )?;
        Ok(())
    }

    pub fn update_playlist_job(&self, id: &str, patch: &serde_json::Value) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut sets = Vec::new();
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(obj) = patch.as_object() {
            for (key, value) in obj {
                match key.as_str() {
                    "status" | "current_track_title" | "error" | "failed_indices" => {
                        if let Some(s) = value.as_str() {
                            sets.push(format!("{} = ?{}", key, sets.len() + 1));
                            params_vec.push(Box::new(s.to_string()));
                        } else {
                            sets.push(format!("{} = NULL", key));
                        }
                    }
                    "current_index" | "completed_tracks" | "failed_tracks" | "downloaded_bytes" | "total_bytes" => {
                        if let Some(n) = value.as_i64() {
                            sets.push(format!("{} = ?{}", key, sets.len() + 1));
                            params_vec.push(Box::new(n));
                        }
                    }
                    _ => {}
                }
            }
        }

        if sets.is_empty() {
            return Ok(());
        }

        let sql = format!(
            "UPDATE playlist_jobs SET {} WHERE id = ?{}",
            sets.join(", "),
            sets.len() + 1
        );
        params_vec.push(Box::new(id.to_string()));

        let params_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        conn.execute(&sql, params_refs.as_slice())?;
        Ok(())
    }

    pub fn get_playlist_job(&self, id: &str) -> Result<Option<PlaylistJobRow>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, device_id, playlist_url, title, save_dir, status, current_index, total_tracks, completed_tracks, failed_tracks, entries, settings, referer, threads, current_track_title, error, failed_indices, downloaded_bytes, total_bytes, created_at
             FROM playlist_jobs WHERE id = ?1"
        )?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(playlist_row_from_stmt(row)?)),
            None => Ok(None),
        }
    }

    pub fn list_active_playlist_jobs(&self, device_id: &str) -> Result<Vec<PlaylistJobRow>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, device_id, playlist_url, title, save_dir, status, current_index, total_tracks, completed_tracks, failed_tracks, entries, settings, referer, threads, current_track_title, error, failed_indices, downloaded_bytes, total_bytes, created_at
             FROM playlist_jobs WHERE device_id = ?1 AND status NOT IN ('completed', 'cancelled')
             ORDER BY created_at DESC LIMIT 20"
        )?;
        let rows = stmt.query_map(params![device_id], |row| playlist_row_from_stmt(row))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn delete_playlist_job(&self, id: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM playlist_jobs WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn has_active_playlist_for_url(&self, device_id: &str, playlist_url: &str) -> Result<Option<String>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id FROM playlist_jobs WHERE device_id = ?1 AND playlist_url = ?2 AND status IN ('queued', 'downloading', 'paused') LIMIT 1"
        )?;
        let mut rows = stmt.query(params![device_id, playlist_url])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }
}

fn playlist_row_from_stmt(row: &rusqlite::Row) -> rusqlite::Result<PlaylistJobRow> {
    Ok(PlaylistJobRow {
        id: row.get(0)?,
        device_id: row.get(1)?,
        playlist_url: row.get(2)?,
        title: row.get(3)?,
        save_dir: row.get(4)?,
        status: row.get(5)?,
        current_index: row.get(6)?,
        total_tracks: row.get(7)?,
        completed_tracks: row.get(8)?,
        failed_tracks: row.get(9)?,
        entries: row.get(10)?,
        settings: row.get(11)?,
        referer: row.get(12)?,
        threads: row.get(13)?,
        current_track_title: row.get(14)?,
        error: row.get(15)?,
        failed_indices: row.get(16)?,
        downloaded_bytes: row.get(17)?,
        total_bytes: row.get(18)?,
        created_at: row.get(19)?,
    })
}
