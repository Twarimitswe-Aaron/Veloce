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
pub struct DeviceRow {
    pub id: String,
    pub created_at: i64,
    pub last_active: i64,
    pub settings: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
        let db = Self { conn: Mutex::new(conn) };
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

    // ── Devices ──────────────────────────────────────────────────────────

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

    pub fn delete_download(&self, id: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM downloads WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn has_download_with_url(&self, url: &str) -> Result<bool, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT COUNT(*) FROM downloads WHERE url = ?1 AND status IN ('queued', 'downloading', 'completed')")?;
        let count: i64 = stmt.query_row(params![url], |row| row.get(0))?;
        Ok(count > 0)
    }
}
