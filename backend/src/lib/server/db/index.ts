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
		'ALTER TABLE downloads ADD COLUMN referer TEXT'
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
