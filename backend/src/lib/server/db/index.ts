import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'veloce.db');
const client = createClient({ url: `file:${dbPath}` });

/** Add columns introduced after first release (SQLite has no IF NOT EXISTS for columns). */
async function migrateSchema() {
	for (const sql of [
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

void migrateSchema();

export const db = drizzle(client, { schema });
