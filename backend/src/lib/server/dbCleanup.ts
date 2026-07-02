import { sql, inArray, or, like } from 'drizzle-orm';
import { db } from './db';
import { downloads, chunks, playlistJobs } from './db/schema';

/**
 * Remove legacy per-track playlist rows from downloads (files on disk are kept).
 * Returns number of download rows deleted.
 */
export async function purgeOrphanPlaylistDownloads(): Promise<number> {
	const rows = await db.select({ id: downloads.id }).from(downloads).where(
		or(
			like(downloads.savePath, '%/playlists/%'),
			like(downloads.savePath, '%\\playlists\\%')
		)
	);
	if (!rows.length) return 0;

	const ids = rows.map((r) => r.id);
	const batch = 200;
	let deleted = 0;
	for (let i = 0; i < ids.length; i += batch) {
		const slice = ids.slice(i, i + batch);
		await db.delete(chunks).where(inArray(chunks.downloadId, slice));
		await db.delete(downloads).where(inArray(downloads.id, slice));
		deleted += slice.length;
	}
	if (deleted > 0) {
		console.log(`[Veloce] Purged ${deleted} orphan per-track playlist download row(s) from DB.`);
	}
	return deleted;
}

/** Drop finished playlist job rows left over from older builds. */
export async function purgeStalePlaylistJobs(): Promise<number> {
	const rows = await db.select({ id: playlistJobs.id }).from(playlistJobs).where(
		sql`status IN ('completed', 'cancelled', 'error')`
	);
	if (!rows.length) return 0;
	const ids = rows.map((r) => r.id);
	await db.delete(playlistJobs).where(inArray(playlistJobs.id, ids));
	console.log(`[Veloce] Purged ${ids.length} stale playlist job row(s).`);
	return ids.length;
}

export async function runDatabaseCleanup(): Promise<void> {
	await purgeOrphanPlaylistDownloads();
	await purgeStalePlaylistJobs();
}

/** True for legacy per-track playlist download rows (should not appear in the single-file queue). */
export function isOrphanPlaylistDownloadRow(row: {
	savePath?: string | null;
	fileName?: string | null;
}): boolean {
	const path = row.savePath ?? '';
	const name = row.fileName ?? '';
	if (path.includes('/playlists/') || path.includes('\\playlists\\')) return true;
	return /^\d+\s*-\s/.test(name);
}
