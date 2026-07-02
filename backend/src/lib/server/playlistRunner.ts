import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { mkdir } from 'fs/promises';
import crypto from 'crypto';
import { and, desc, eq, inArray, not } from 'drizzle-orm';
import { db } from './db';
import { playlistJobs } from './db/schema';
import { resolvePlaylist, extractMediaWithFormat, type PlaylistEntry } from './extractor';
import {
	type PlaylistFormatSettings,
	defaultPlaylistFormatSettings,
	formatAttemptsForTrack,
	parsePlaylistFormatSettings
} from './playlistSettings';
import { findCompletedTrackFile, isTrackCompleteOnDisk, parseFailedIndices, prepareResumePosition, trackStem } from './playlistTrack';
import { sanitizeFileName, sanitizeFolderName } from './util';

export type PlaylistRuntime = {
	baseDirectory: string;
	defaultThreads: number;
	maxRateBytes: number;
	engineQuiet: boolean;
	playlistFormats: PlaylistFormatSettings;
};

type PlaylistIntent = 'normal' | 'paused' | 'cancelled';

type RunningPlaylist = {
	intent: PlaylistIntent;
	engineProc: ChildProcess | null;
	runtime: PlaylistRuntime;
	broadcast: BroadcastFn;
};

const runningPlaylists = new Map<string, RunningPlaylist>();
const playlistQueue: string[] = [];
let playlistWorkerActive = false;

type BroadcastFn = (obj: unknown) => void;

function playlistDir(baseDir: string, folderName: string): string | null {
	const root = path.resolve(baseDir);
	const target = path.resolve(root, 'playlists', sanitizeFolderName(folderName));
	const rel = path.relative(root, target);
	if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
	return target;
}

function coreEngineBinaryPath(): string {
	return path.resolve(process.cwd(), '../core_engine/target/release/core_engine');
}

function broadcastPlaylist(
	broadcast: BroadcastFn,
	row: typeof playlistJobs.$inferSelect,
	extra: Record<string, unknown> = {}
) {
	const current = (extra.currentIndex as number | undefined) ?? row.currentIndex;
	const total = row.totalTracks;
	const title = row.title || 'Playlist';
	broadcast({
		type: 'PLAYLIST_UPDATE',
		playlistId: row.id,
		fileName: `${title} (${current}/${total} tracks)`,
		status: (extra.status as string) ?? row.status,
		current,
		total,
		completed: (extra.completedTracks as number | undefined) ?? row.completedTracks,
		failed: (extra.failedTracks as number | undefined) ?? row.failedTracks,
		downloaded: (extra.downloadedBytes as number | undefined) ?? row.downloadedBytes ?? 0,
		totalBytes: (extra.totalBytes as number | undefined) ?? row.totalBytes ?? 0,
		speedBps: (extra.speedBps as number | undefined) ?? 0,
		etaSecs: (extra.etaSecs as number | undefined) ?? 0,
		trackTitle: (extra.currentTrackTitle as string | undefined) ?? row.currentTrackTitle ?? '',
		saveDir: row.saveDir,
		error: (extra.error as string | undefined) ?? row.error ?? undefined,
		isPlaylist: true
	});
}

async function patchJob(id: string, patch: Partial<typeof playlistJobs.$inferInsert>) {
	await db.update(playlistJobs).set(patch).where(eq(playlistJobs.id, id));
}

async function finishPlaylistJob(
	playlistId: string,
	ctx: RunningPlaylist,
	row: typeof playlistJobs.$inferSelect,
	patch: Partial<typeof playlistJobs.$inferInsert>
) {
	await patchJob(playlistId, patch);
	if (patch.status === 'completed') {
		ctx.broadcast({
			type: 'PLAYLIST_FINISHED',
			playlistId,
			title: row.title,
			saveDir: row.saveDir,
			completed: (patch.completedTracks as number | undefined) ?? row.completedTracks,
			failed: (patch.failedTracks as number | undefined) ?? row.failedTracks,
			total: row.totalTracks
		});
	} else {
		ctx.broadcast({ type: 'PLAYLIST_REMOVED', playlistId });
	}
	await db.delete(playlistJobs).where(eq(playlistJobs.id, playlistId));
	runningPlaylists.delete(playlistId);
}

function markTrackFailed(failedIndices: number[], index: number): number[] {
	if (failedIndices.includes(index)) return failedIndices;
	return [...failedIndices, index];
}

function runEngine(
	playlistId: string,
	trackKey: string,
	url: string,
	savePath: string,
	referer: string | undefined,
	runtime: PlaylistRuntime,
	onProgress: (downloaded: number, total: number, speedBps: number, etaSecs: number) => void
): Promise<'completed' | 'paused' | 'cancelled' | 'error'> {
	return new Promise((resolve) => {
		const proc = spawn(coreEngineBinaryPath(), [
			'--id', trackKey,
			'--url', url,
			'--save-path', savePath,
			'--threads', String(runtime.defaultThreads),
			'--max-rate', String(runtime.maxRateBytes),
			...(runtime.engineQuiet ? ['--quiet'] : []),
			...(referer ? ['--referer', referer, '--origin', safeOrigin(referer)] : []),
		], { stdio: ['ignore', 'pipe', 'inherit'] });

		const run = runningPlaylists.get(playlistId);
		if (run) run.engineProc = proc;

		let lineBuffer = '';
		let settled = false;
		const finish = (v: 'completed' | 'paused' | 'cancelled' | 'error') => {
			if (settled) return;
			settled = true;
			const r = runningPlaylists.get(playlistId);
			if (r) r.engineProc = null;
			resolve(v);
		};

		proc.stdout?.on('data', (chunk) => {
			lineBuffer += chunk.toString();
			const lines = lineBuffer.split('\n');
			lineBuffer = lines.pop()!;
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const p = JSON.parse(line);
					if (p.type === 'progress') {
						onProgress(p.downloaded ?? 0, p.total ?? 0, p.speed_bps ?? 0, p.eta_secs ?? 0);
					} else if (p.type === 'already_exists') finish('completed');
					else if (p.type === 'fatal') finish('error');
				} catch { /* ignore */ }
			}
		});

		proc.on('error', () => finish('error'));
		proc.on('close', (code) => {
			const intent = runningPlaylists.get(playlistId)?.intent ?? 'normal';
			if (intent === 'cancelled') finish('cancelled');
			else if (intent === 'paused') finish('paused');
			else finish(code === 0 ? 'completed' : 'error');
		});
	});
}

function safeOrigin(referer: string): string {
	try {
		return new URL(referer).origin;
	} catch {
		return referer;
	}
}

async function runPlaylistJob(playlistId: string): Promise<void> {
	const ctx = runningPlaylists.get(playlistId);
	if (!ctx) return;

	const rows = await db.select().from(playlistJobs).where(eq(playlistJobs.id, playlistId));
	let row = rows[0];
	if (!row) {
		runningPlaylists.delete(playlistId);
		return;
	}

	const entries = (row.entries as PlaylistEntry[]) ?? [];
	const settings = parsePlaylistFormatSettings(row.settings ?? defaultPlaylistFormatSettings());
	let index = row.currentIndex;
	let completed = row.completedTracks;
	let failed = row.failedTracks;
	let failedIndices = parseFailedIndices(row.failedIndices);

	const resumed = prepareResumePosition(entries, row.saveDir, index, completed, failedIndices);
	index = resumed.index;
	completed = resumed.completed;
	failedIndices = resumed.failedIndices;
	if (index !== row.currentIndex || completed !== row.completedTracks) {
		await patchJob(playlistId, { currentIndex: index, completedTracks: completed, failedIndices });
		row = (await db.select().from(playlistJobs).where(eq(playlistJobs.id, playlistId)))[0]!;
	}

	await patchJob(playlistId, { status: 'downloading', error: null });
	row = (await db.select().from(playlistJobs).where(eq(playlistJobs.id, playlistId)))[0]!;
	broadcastPlaylist(ctx.broadcast, row, { status: 'downloading' });

	while (index < entries.length) {
		const run = runningPlaylists.get(playlistId);
		if (!run) break;

		if (run.intent === 'cancelled') {
			await finishPlaylistJob(playlistId, ctx, row, {
				status: 'cancelled',
				currentIndex: index,
				completedTracks: completed,
				failedTracks: failed,
				failedIndices
			});
			return;
		}
		if (run.intent === 'paused') {
			await patchJob(playlistId, {
				status: 'paused',
				currentIndex: index,
				completedTracks: completed,
				failedTracks: failed,
				failedIndices
			});
			row = (await db.select().from(playlistJobs).where(eq(playlistJobs.id, playlistId)))[0]!;
			broadcastPlaylist(ctx.broadcast, row, { status: 'paused' });
			runningPlaylists.delete(playlistId);
			return;
		}

		const entry = entries[index];
		const stem = trackStem(entry, index);
		const trackTitle = entry.title || `Track ${index + 1}`;

		if (failedIndices.includes(index)) {
			index++;
			await patchJob(playlistId, { currentIndex: index, failedIndices });
			continue;
		}

		if (findCompletedTrackFile(row.saveDir, stem)) {
			completed++;
			index++;
			await patchJob(playlistId, { currentIndex: index, completedTracks: completed, failedIndices });
			row = (await db.select().from(playlistJobs).where(eq(playlistJobs.id, playlistId)))[0]!;
			broadcastPlaylist(ctx.broadcast, row, { currentIndex: index, completedTracks: completed, failedTracks: failed });
			continue;
		}

		await patchJob(playlistId, { currentIndex: index, currentTrackTitle: trackTitle, downloadedBytes: 0, totalBytes: 0 });

		let media: { url: string; ext: string } | null = null;
		for (const fmt of formatAttemptsForTrack(settings)) {
			media = await extractMediaWithFormat(entry.url, fmt);
			if (media) break;
		}

		if (!media) {
			failedIndices = markTrackFailed(failedIndices, index);
			failed++;
			index++;
			await patchJob(playlistId, { currentIndex: index, failedTracks: failed, failedIndices });
			row = (await db.select().from(playlistJobs).where(eq(playlistJobs.id, playlistId)))[0]!;
			broadcastPlaylist(ctx.broadcast, row, { currentIndex: index, failedTracks: failed, completedTracks: completed });
			continue;
		}

		const fileName = sanitizeFileName(`${stem}${media.ext.startsWith('.') ? media.ext : '.' + media.ext}`);
		const fullPath = path.join(row.saveDir, fileName);

		if (isTrackCompleteOnDisk(fullPath)) {
			completed++;
			index++;
			await patchJob(playlistId, { currentIndex: index, completedTracks: completed, failedIndices });
			continue;
		}

		row = (await db.select().from(playlistJobs).where(eq(playlistJobs.id, playlistId)))[0]!;
		broadcastPlaylist(ctx.broadcast, row, { currentIndex: index, currentTrackTitle: trackTitle, completedTracks: completed, failedTracks: failed });

		const result = await runEngine(
			playlistId,
			`${playlistId}-t${index}`,
			media.url,
			fullPath,
			row.referer ?? undefined,
			{ ...run.runtime, defaultThreads: row.threads },
			(downloaded, total, speedBps, etaSecs) => {
				if (runningPlaylists.get(playlistId)?.intent !== 'normal') return;
				void patchJob(playlistId, { downloadedBytes: downloaded, totalBytes: total });
				db.select().from(playlistJobs).where(eq(playlistJobs.id, playlistId)).then((r2) => {
					if (r2[0]) {
						broadcastPlaylist(ctx.broadcast, r2[0], {
							downloadedBytes: downloaded,
							totalBytes: total,
							speedBps,
							etaSecs,
							currentTrackTitle: trackTitle
						});
					}
				});
			}
		);

		if (result === 'paused' || result === 'cancelled') {
			if (result === 'cancelled') {
				await finishPlaylistJob(playlistId, ctx, row, {
					status: 'cancelled',
					currentIndex: index,
					completedTracks: completed,
					failedTracks: failed,
					failedIndices
				});
			} else {
				await patchJob(playlistId, {
					status: 'paused',
					currentIndex: index,
					completedTracks: completed,
					failedTracks: failed,
					failedIndices
				});
				row = (await db.select().from(playlistJobs).where(eq(playlistJobs.id, playlistId)))[0]!;
				broadcastPlaylist(ctx.broadcast, row, { status: 'paused' });
				runningPlaylists.delete(playlistId);
			}
			return;
		}

		if (result === 'completed') {
			completed++;
		} else {
			failedIndices = markTrackFailed(failedIndices, index);
			failed++;
		}

		index++;
		await patchJob(playlistId, {
			currentIndex: index,
			completedTracks: completed,
			failedTracks: failed,
			failedIndices,
			downloadedBytes: 0,
			totalBytes: 0
		});
	}

	await finishPlaylistJob(playlistId, ctx, row, {
		status: 'completed',
		currentIndex: index,
		completedTracks: completed,
		failedTracks: failed,
		failedIndices
	});
}

function pumpPlaylistQueue() {
	if (playlistWorkerActive) return;
	const nextId = playlistQueue.shift();
	if (!nextId) return;
	const ctx = runningPlaylists.get(nextId);
	if (!ctx) {
		pumpPlaylistQueue();
		return;
	}
	playlistWorkerActive = true;
	void runPlaylistJob(nextId).finally(() => {
		playlistWorkerActive = false;
		pumpPlaylistQueue();
	});
}

export function schedulePlaylistJob(playlistId: string, runtime: PlaylistRuntime, broadcast: BroadcastFn) {
	if (runningPlaylists.has(playlistId)) return;
	runningPlaylists.set(playlistId, { intent: 'normal', engineProc: null, runtime, broadcast });
	playlistQueue.push(playlistId);
	pumpPlaylistQueue();
}

export function pausePlaylistJob(playlistId: string) {
	const run = runningPlaylists.get(playlistId);
	if (run) {
		run.intent = 'paused';
		run.engineProc?.kill('SIGTERM');
		return;
	}
	void patchJob(playlistId, { status: 'paused' });
}

export async function cancelPlaylistJob(playlistId: string, broadcast: BroadcastFn) {
	const run = runningPlaylists.get(playlistId);
	if (run) {
		run.intent = 'cancelled';
		run.engineProc?.kill('SIGTERM');
		return;
	}
	await db.delete(playlistJobs).where(eq(playlistJobs.id, playlistId));
	broadcast({ type: 'PLAYLIST_REMOVED', playlistId });
}

export async function resumePlaylistJob(playlistId: string, runtime: PlaylistRuntime, broadcast: BroadcastFn) {
	if (runningPlaylists.has(playlistId)) return;
	const row = await getPlaylistJob(playlistId);
	if (!row || row.status === 'completed' || row.status === 'cancelled') return;
	await patchJob(playlistId, { status: 'queued' });
	schedulePlaylistJob(playlistId, runtime, broadcast);
}

export async function queuePlaylistDownload(opts: {
	macAddress: string;
	playlistUrl: string;
	referer?: string;
	baseDir: string;
	threads: number;
	formatSettings: PlaylistFormatSettings;
	runtime: PlaylistRuntime;
	broadcast: BroadcastFn;
}): Promise<{ ok: true; playlistId: string; total: number; title: string; saveDir: string } | { ok: false; error: string }> {
	const active = await db.select().from(playlistJobs)
		.where(and(
			eq(playlistJobs.deviceId, opts.macAddress),
			eq(playlistJobs.playlistUrl, opts.playlistUrl),
			inArray(playlistJobs.status, ['queued', 'downloading', 'paused'])
		))
		.limit(1);
	if (active[0]) {
		const row = active[0];
		if (row.status === 'paused' || row.status === 'queued') {
			schedulePlaylistJob(row.id, opts.runtime, opts.broadcast);
		}
		return { ok: true, playlistId: row.id, total: row.totalTracks, title: row.title, saveDir: row.saveDir };
	}

	const pl = await resolvePlaylist(opts.playlistUrl);
	if (!pl?.entries.length) {
		return { ok: false, error: 'No playlist entries found (or not a playlist).' };
	}

	if (pl.entries.length > 100) {
		console.warn(`[Veloce] Large playlist (${pl.entries.length} tracks) — sequential download may take a while.`);
	}

	const dirPath = playlistDir(opts.baseDir, pl.title);
	if (!dirPath) return { ok: false, error: 'Invalid playlist folder path.' };

	await mkdir(dirPath, { recursive: true });

	const id = crypto.randomUUID();
	await db.insert(playlistJobs).values({
		id,
		deviceId: opts.macAddress,
		playlistUrl: opts.playlistUrl,
		title: pl.title,
		saveDir: dirPath,
		status: 'queued',
		currentIndex: 0,
		totalTracks: pl.entries.length,
		completedTracks: 0,
		failedTracks: 0,
		failedIndices: [],
		entries: pl.entries,
		settings: opts.formatSettings,
		referer: opts.referer ?? null,
		threads: opts.threads,
		downloadedBytes: 0,
		totalBytes: 0,
		createdAt: new Date()
	});

	const row = (await db.select().from(playlistJobs).where(eq(playlistJobs.id, id)))[0];
	if (row) broadcastPlaylist(opts.broadcast, row, { status: 'queued' });

	return { ok: true, playlistId: id, total: pl.entries.length, title: pl.title, saveDir: dirPath };
}

export async function listPlaylistJobsForDevice(deviceId: string) {
	return db.select().from(playlistJobs)
		.where(and(
			eq(playlistJobs.deviceId, deviceId),
			not(inArray(playlistJobs.status, ['completed', 'cancelled']))
		))
		.orderBy(desc(playlistJobs.createdAt))
		.limit(20);
}

export function isActivePlaylistJob(id: string): boolean {
	return runningPlaylists.has(id);
}

export async function getPlaylistJob(id: string) {
	const rows = await db.select().from(playlistJobs).where(eq(playlistJobs.id, id));
	return rows[0] ?? null;
}
