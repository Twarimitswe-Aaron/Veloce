import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

const dbPath = config.dbPath;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const client = createClient({ url: `file:${dbPath}` });

console.log(`[Veloce] Database: ${dbPath}`);

/** Add columns introduced after first release (SQLite has no IF NOT EXISTS for columns). */
export async function migrateSchema() {
	for (const sql of [
		`CREATE TABLE IF NOT EXISTS devices (
			id TEXT PRIMARY KEY,
			created_at INTEGER NOT NULL,
			last_active INTEGER NOT NULL,
			settings TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS downloads (
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
		)`,
		'ALTER TABLE downloads ADD COLUMN direct_url TEXT',
		'ALTER TABLE downloads ADD COLUMN referer TEXT',
		'ALTER TABLE playlist_jobs ADD COLUMN failed_indices TEXT',
		`CREATE TABLE IF NOT EXISTS playlist_jobs (
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
		)`
	]) {
		try {
			await client.execute(sql);
		} catch {
			/* column already exists */
		}
	}
}

export const dbInit = migrateSchema();

export const db = drizzle(client, { schema });
