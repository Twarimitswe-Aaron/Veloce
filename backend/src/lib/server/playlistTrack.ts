import path from 'path';
import { existsSync, readdirSync, statSync } from 'fs';
import type { PlaylistEntry } from './extractor';
import { sanitizeFileName } from './util';

export function trackStem(entry: PlaylistEntry, index: number): string {
	const num = String(entry.index ?? index + 1).padStart(2, '0');
	const trackTitle = entry.title || `Track ${index + 1}`;
	return sanitizeFileName(`${num} - ${trackTitle}`);
}

/** A playlist track is done when the engine wrote `.veloce_done`, or a plain file exists with no in-progress state. */
export function isTrackCompleteOnDisk(filePath: string): boolean {
	if (existsSync(`${filePath}.veloce_done`)) return true;
	if (existsSync(`${filePath}.veloce_state`)) return false;
	if (!existsSync(filePath)) return false;
	try {
		return statSync(filePath).size > 0;
	} catch {
		return false;
	}
}

/** Find a finished track file in the playlist folder (any common extension). */
export function findCompletedTrackFile(saveDir: string, stem: string): string | null {
	if (!existsSync(saveDir)) return null;
	const prefix = sanitizeFileName(stem);
	let names: string[];
	try {
		names = readdirSync(saveDir);
	} catch {
		return null;
	}
	for (const name of names) {
		if (name.endsWith('.veloce_done') || name.endsWith('.veloce_state')) continue;
		if (!name.startsWith(prefix)) continue;
		const full = path.join(saveDir, name);
		if (isTrackCompleteOnDisk(full)) return full;
	}
	return null;
}

export function parseFailedIndices(raw: unknown): number[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0);
}
