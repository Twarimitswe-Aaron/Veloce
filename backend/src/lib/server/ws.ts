import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { db } from './db';
import { downloads, devices } from './db/schema';
import { getMacAddress } from './identity';
import { eq, sql, inArray } from 'drizzle-orm';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import { statfs, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { extractMediaUrl, listFormats, listPlaylistEntries, getRecentFormatError, isDirectFileUrl } from './extractor';
import { config } from './config';
import { isSafeDownloadUrl, sanitizeFileName, safeJoin, categoryForExt } from './util';

const MIN_FREE_BYTES = config.minFreeDiskMb * 1024 * 1024; // early sanity buffer
const VIDEO_CATEGORY = 'videos';

type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'error';

interface JobSpec {
	id: string;
	pageUrl: string; // original page URL — used for (re)extraction and dedup
	fileName: string;
	savePath: string;
	category: string;
	threads: number;
	/** Only a brand-new download may be renamed from extraction; resumes must keep the path stable. */
	allowRename: boolean;
	/** When set, download this URL directly (skip yt-dlp extraction). */
	directUrl?: string;
}

// ── Connected clients (broadcast target) ─────────────────────────────────────
const clients = new Set<WebSocket>();
function broadcast(obj: unknown) {
	const msg = JSON.stringify(obj);
	for (const c of clients) {
		if (c.readyState === 1) c.send(msg);
	}
}

// ── Running engine processes, keyed by downloadId, with caller intent ─────────
type Intent = 'normal' | 'paused' | 'cancelled';
const running = new Map<string, { proc: ChildProcess; intent: Intent }>();

// ── Security helpers ─────────────────────────────────────────────────────────

/**
 * Only the browser extension (chrome-/moz-extension origins) or local dev
 * pages may connect. This blocks ordinary websites from driving the local
 * downloader via `new WebSocket('ws://localhost:14921/ws')`. Browsers set the
 * Origin header and JS cannot forge it, so this check is reliable.
 */
function isAllowedOrigin(origin?: string): boolean {
	if (!origin) return true; // non-browser/native clients (no Origin header)
	if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
		// If an allowlist is configured, the extension ID must be in it.
		if (config.allowedExtensionIds.length === 0) return true;
		const id = origin.replace(/^chrome-extension:\/\//, '').replace(/^moz-extension:\/\//, '').replace(/\/.*$/, '');
		return config.allowedExtensionIds.includes(id);
	}
	try {
		const u = new URL(origin);
		return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
	} catch {
		return false;
	}
}

// ── Filesystem / disk helpers ────────────────────────────────────────────────

function completedFileStillExists(savePath: string): boolean {
	return existsSync(`${savePath}.veloce_done`) || existsSync(savePath);
}

/**
 * Avoid silently overwriting an unrelated existing file: if `savePath` is taken
 * (on disk or by another DB row), append " (1)", " (2)", … like classic IDMs.
 */
async function uniqueSavePath(savePath: string): Promise<string> {
	const dir = path.dirname(savePath);
	const ext = path.extname(savePath);
	const stem = path.basename(savePath, ext);
	let candidate = savePath;
	for (let i = 1; ; i++) {
		const taken =
			existsSync(candidate) ||
			existsSync(`${candidate}.veloce_state`) ||
			(await db.select().from(downloads).where(eq(downloads.savePath, candidate))).length > 0;
		if (!taken) return candidate;
		candidate = path.join(dir, `${stem} (${i})${ext}`);
	}
}

async function cleanupFiles(savePath: string) {
	await unlink(savePath).catch(() => {});
	await unlink(`${savePath}.veloce_state`).catch(() => {});
	await unlink(`${savePath}.veloce_done`).catch(() => {});
}

/** Free space for a target dir, walking up to the first directory that exists. */
async function freeSpaceFor(targetDir: string): Promise<number | null> {
	let dir = path.resolve(targetDir);
	for (;;) {
		try {
			const s = await statfs(dir);
			return Number(s.bavail) * Number(s.bsize);
		} catch {
			const parent = path.dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	}
}

function pickDirectory(): string | null {
	const candidates = [
		'zenity --file-selection --directory 2>/dev/null',
		'kdialog --getexistingdirectory "$HOME" 2>/dev/null'
	];
	for (const cmd of candidates) {
		try {
			const out = execSync(cmd).toString().trim();
			if (out) {
				console.log(`✅ Directory picker returned: ${out}`);
				return out;
			}
			return null; // empty + exit 0 => user cancelled
		} catch (e: any) {
			if (e?.status === 1) return null; // user cancelled
			// else: picker missing — try the next one
		}
	}
	console.error('❌ No graphical folder picker available (tried zenity, kdialog).');
	return null;
}

// ── Runtime settings (overridable at run time via SET_SETTINGS) ───────────────
// Initialized from `.env` config; persisted per-device in `devices.settings` and
// applied live so the popup / dashboard can tune behavior without a restart.
interface RuntimeSettings {
	maxConcurrentDownloads: number;
	defaultThreads: number;
	maxRateBytes: number;
	baseDirectory: string;
	engineQuiet: boolean;
}

const runtime: RuntimeSettings = {
	maxConcurrentDownloads: config.maxConcurrentDownloads,
	defaultThreads: config.defaultThreads,
	maxRateBytes: config.maxRateBytes,
	baseDirectory: config.baseDir || path.join(os.homedir(), 'Downloads', 'Veloce'),
	engineQuiet: config.engineQuiet
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** Merge an untrusted partial settings object into the live runtime settings. */
function applySettings(patch: Record<string, unknown>) {
	if (patch.maxConcurrentDownloads !== undefined)
		runtime.maxConcurrentDownloads = clampInt(patch.maxConcurrentDownloads, 1, 64, runtime.maxConcurrentDownloads);
	if (patch.defaultThreads !== undefined)
		runtime.defaultThreads = clampInt(patch.defaultThreads, 1, 64, runtime.defaultThreads);
	if (patch.maxRateBytes !== undefined)
		runtime.maxRateBytes = clampInt(patch.maxRateBytes, 0, Number.MAX_SAFE_INTEGER, runtime.maxRateBytes);
	if (typeof patch.baseDirectory === 'string' && patch.baseDirectory.trim())
		runtime.baseDirectory = patch.baseDirectory.trim();
	if (typeof patch.engineQuiet === 'boolean') runtime.engineQuiet = patch.engineQuiet;
}

let settingsLoaded = false;

/** Load persisted device settings into the live runtime (once, on first client). */
async function loadSettings(macAddress: string) {
	if (settingsLoaded) return;
	settingsLoaded = true;
	try {
		const rows = await db.select().from(devices).where(eq(devices.id, macAddress));
		const s = rows[0]?.settings as Record<string, unknown> | null;
		if (s) applySettings(s);
	} catch (e) {
		console.error('Failed to load device settings:', e);
	}
}

/** Persist the live runtime settings to this device's row. */
async function persistSettings(macAddress: string) {
	try {
		await db.update(devices).set({ settings: { ...runtime } }).where(eq(devices.id, macAddress));
	} catch (e) {
		console.error('Failed to persist device settings:', e);
	}
}

/** Open a path (file or folder) with the desktop's default handler, detached. */
function xdgOpen(target: string): boolean {
	try {
		const child = spawn('xdg-open', [target], { stdio: 'ignore', detached: true });
		child.on('error', (e) => console.error('xdg-open failed:', e));
		child.unref();
		return true;
	} catch (e) {
		console.error('xdg-open spawn failed:', e);
		return false;
	}
}

/** Reveal a file in the file manager, highlighting it when the DBus API exists. */
function revealInFileManager(filePath: string): boolean {
	try {
		const child = spawn(
			'dbus-send',
			[
				'--session', '--print-reply', '--dest=org.freedesktop.FileManager1',
				'--type=method_call', '/org/freedesktop/FileManager1',
				'org.freedesktop.FileManager1.ShowItems',
				`array:string:file://${filePath}`, 'string:'
			],
			{ stdio: 'ignore' }
		);
		let failed = false;
		child.on('error', () => { failed = true; });
		child.on('close', (code) => {
			if (failed || code !== 0) xdgOpen(path.dirname(filePath)); // fallback: open folder
		});
		return true;
	} catch {
		return xdgOpen(path.dirname(filePath));
	}
}

// ── Scheduler: cap concurrent engine processes ───────────────────────────────
let activeDownloads = 0;
const pendingJobs: Array<() => Promise<void>> = [];

function pumpScheduler() {
	while (activeDownloads < runtime.maxConcurrentDownloads && pendingJobs.length > 0) {
		const job = pendingJobs.shift()!;
		activeDownloads++;
		job()
			.catch((e) => console.error('❌ Scheduled download job failed:', e))
			.finally(() => {
				activeDownloads--;
				pumpScheduler();
			});
	}
}

function scheduleDownload(job: () => Promise<void>) {
	pendingJobs.push(job);
	pumpScheduler();
}

async function setStatus(id: string, status: DownloadStatus) {
	await db.update(downloads).set({ status }).where(eq(downloads.id, id));
}

async function markError(id: string, error: string) {
	await setStatus(id, 'error');
	broadcast({ type: 'DOWNLOAD_ERROR', downloadId: id, error });
}

function specFromRow(row: typeof downloads.$inferSelect): JobSpec {
	// savePath layout is `${baseDir}/${category}/${fileName}`.
	const category = path.basename(path.dirname(row.savePath));
	return {
		id: row.id,
		pageUrl: row.url,
		fileName: row.fileName,
		savePath: row.savePath,
		category,
		threads: 8,
		allowRename: false
	};
}

/**
 * Resolve the media URL (re-extracting for video sites so expired CDN links are
 * refreshed on resume), verify disk space, spawn the engine, and stream
 * progress. Holds a scheduler slot until the engine process settles.
 */
async function runDownloadJob(spec: JobSpec): Promise<void> {
	const { id } = spec;
	let { savePath, fileName } = spec;
	try {
		let finalUrl = spec.directUrl || spec.pageUrl;

		// MediaFire CDN tokens expire — always resolve a fresh download URL.
		if (finalUrl.includes('mediafire.com')) {
			console.log(`🔍 Refreshing Mediafire URL for ${finalUrl}...`);
			const fresh = await extractMediaUrl(finalUrl);
			if (!fresh) {
				console.error(`❌ Mediafire link expired or unavailable: ${finalUrl}`);
				await markError(id, 'MediaFire download link expired. Refresh the file page in your browser and try again.');
				return;
			}
			finalUrl = fresh;
			console.log('🎯 Mediafire URL refreshed');
		} else if (!spec.directUrl && !isDirectFileUrl(spec.pageUrl) && spec.category === VIDEO_CATEGORY) {
			console.log(`🔍 Extracting direct URL for ${spec.pageUrl}...`);
			const directUrl = await extractMediaUrl(spec.pageUrl);
			if (!directUrl) {
				console.error(`❌ Could not extract a direct media URL for ${spec.pageUrl}. Aborting.`);
				await markError(id, 'Could not extract a downloadable media URL (the site may require login, or yt-dlp/cookies failed).');
				return;
			}
			finalUrl = directUrl;
			console.log('🎯 Extracted direct URL successfully');

			// Improve a generic filename from the resolved URL — only for fresh downloads.
			if (spec.allowRename && (fileName.startsWith('file') || fileName.startsWith('download_file'))) {
				try {
					const u = new URL(finalUrl);
					const parts = u.pathname.split('/').filter((p) => p.length > 0);
					let betterName = parts.pop();
					if (betterName && betterName.includes('.')) {
						betterName = decodeURIComponent(betterName.replace(/\+/g, ' '));
						const baseDir = path.dirname(path.dirname(savePath));
						const newPath = safeJoin(baseDir, spec.category, betterName);
						if (newPath) {
							fileName = sanitizeFileName(betterName);
							savePath = newPath;
							await db.update(downloads).set({ fileName, savePath }).where(eq(downloads.id, id));
						}
					}
				} catch {
					// keep original name
				}
			}
		}

		// Disk space sanity check (early, coarse). The engine does the precise,
		// size-aware check after it discovers the content length.
		const free = await freeSpaceFor(path.dirname(savePath));
		if (free !== null && free < MIN_FREE_BYTES) {
			console.error('❌ Insufficient disk space!');
			await markError(id, 'Insufficient disk space');
			return;
		}

		await setStatus(id, 'downloading');
		console.log(`🚀 Spawning Rust Core for ID: ${id}`);

		const coreDir = path.resolve(process.cwd(), '../core_engine');
		const binaryPath = path.join(coreDir, 'target', 'release', 'core_engine');
		const engineArgs = [
			'--id', id,
			'--url', finalUrl,
			'--save-path', savePath,
			'--threads', spec.threads.toString(),
			'--max-rate', runtime.maxRateBytes.toString()
		];
		if (runtime.engineQuiet) engineArgs.push('--quiet');
		const rustProcess = spawn(binaryPath, engineArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
		running.set(id, { proc: rustProcess, intent: 'normal' });

		let resolveProc!: () => void;
		const procDone = new Promise<void>((r) => { resolveProc = r; });

		let settled = false;
		const settle = async (status: 'completed' | 'error' | 'paused', errorMsg?: string) => {
			if (settled) return;
			settled = true;
			await setStatus(id, status);
			if (status === 'completed') {
				// DB row is the durable completion record; remove on-disk markers permanently.
				await unlink(`${savePath}.veloce_done`).catch(() => {});
				await unlink(`${savePath}.veloce_state`).catch(() => {});
				broadcast({ type: 'DOWNLOAD_COMPLETED', downloadId: id, status });
			} else if (status === 'paused') {
				broadcast({ type: 'DOWNLOAD_PAUSED', downloadId: id });
			} else {
				broadcast({ type: 'DOWNLOAD_ERROR', downloadId: id, error: errorMsg ?? 'Download failed' });
			}
			resolveProc();
		};

		const finishCancelled = async () => {
			if (settled) return;
			settled = true;
			await cleanupFiles(savePath);
			await db.delete(downloads).where(eq(downloads.id, id));
			broadcast({ type: 'DOWNLOAD_REMOVED', downloadId: id });
			resolveProc();
		};

		let lineBuffer = '';
		let lastDbWrite = 0;
		rustProcess.stdout?.on('data', async (chunk) => {
			lineBuffer += chunk.toString();
			const lines = lineBuffer.split('\n');
			lineBuffer = lines.pop()!;
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const progress = JSON.parse(line);
					if (progress.type === 'progress') {
						const now = Date.now();
						if (now - lastDbWrite > 5000) {
							lastDbWrite = now;
							await db.update(downloads)
								.set({ downloadedBytes: progress.downloaded, totalBytes: progress.total })
								.where(eq(downloads.id, id));
						}
						broadcast({
							type: 'PROGRESS',
							downloadId: id,
							downloaded: progress.downloaded,
							total: progress.total,
							speedBps: progress.speed_bps || 0,
							etaSecs: progress.eta_secs || 0,
							elapsedSecs: progress.elapsed_secs || 0,
							threads: progress.threads || []
						});
					} else if (progress.type === 'info') {
						const chunkMb = (progress.chunk_size_bytes / 1024 / 1024).toFixed(2);
						const totalMb = (progress.total_size_bytes / 1024 / 1024).toFixed(2);
						console.log(`\n[Veloce] Starting ${progress.threads} connections | piece: ${chunkMb} MB | total: ${totalMb} MB`);
					} else if (progress.type === 'already_exists') {
						console.log('\n[Veloce] File already fully downloaded — skipping!');
						await settle('completed');
					} else if (progress.type === 'fatal') {
						console.error(`\n[Veloce] Engine fatal: ${progress.error}`);
						await settle('error', progress.error || 'Engine fatal error');
					} else if (progress.type === 'done') {
						const totalMb = (progress.total / 1024 / 1024).toFixed(1);
						console.log(`\n✅ [Veloce] Download complete! ${totalMb} MB in ${progress.elapsed_secs?.toFixed(1)}s @ avg ${progress.avg_speed_mbps?.toFixed(2)} MB/s`);
					}
				} catch {
					console.log(`\n[Rust Core]: ${line}`);
				}
			}
		});

		rustProcess.on('error', async (err) => {
			console.error(`❌ Failed to launch core engine at ${binaryPath}:`, err);
			await settle('error', `Could not start the download engine (${err.message}). Is core_engine built?`);
		});

		rustProcess.on('close', async (code) => {
			const intent = running.get(id)?.intent ?? 'normal';
			running.delete(id);
			console.log(`\n[Rust Core] Exited with code ${code} (intent=${intent})`);
			if (intent === 'cancelled') {
				await finishCancelled();
			} else if (intent === 'paused') {
				await settle('paused');
			} else {
				await settle(code === 0 ? 'completed' : 'error', `Engine exited with code ${code}`);
			}
		});

		await procDone;
	} catch (e) {
		console.error('❌ Background processing failed:', e);
		running.delete(id);
		try {
			await markError(id, 'Internal error while starting download');
		} catch {}
	}
}

const EXTRACTOR_DOMAINS = ['youtube.com', 'youtu.be', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com', 'vimeo.com', 'facebook.com', 'twitch.tv', 'mediafire.com'];

function categoryFor(sourceUrl: string, rawName: string): { category: string; rawName: string } {
	let ext = path.extname(rawName).toLowerCase();
	try {
		const hostname = new URL(sourceUrl).hostname.toLowerCase();
		if (EXTRACTOR_DOMAINS.some((d) => hostname.includes(d))) {
			if (!ext) rawName += (ext = '.mp4');
			return { category: VIDEO_CATEGORY, rawName };
		}
	} catch { /* ignore */ }
	return { category: categoryForExt(ext), rawName };
}

interface QueueOpts {
	macAddress: string;
	rawUrl: string; // normalized source url (used for dedup + re-extraction)
	fileName: string;
	baseDir: string;
	threads: number;
	directUrl?: string;
	ext?: string;
}

/**
 * Create (or attach to) a single download from a normalized request. Handles
 * categorization, path confinement, dedup, DB insert, ACK broadcast and
 * scheduling. Shared by the single-download and playlist-expansion paths.
 */
async function queueDownload(opts: QueueOpts): Promise<{ ok: true; downloadId: string } | { ok: false; error: string }> {
	let rawName = sanitizeFileName(opts.fileName || 'download_file');
	if (opts.directUrl) {
		try {
			const du = new URL(opts.directUrl);
			const fromPath = path.basename(du.pathname);
			if (fromPath && fromPath.includes('.')) {
				rawName = sanitizeFileName(fromPath);
			} else if (opts.ext) {
				const stem = rawName.replace(/\.[^.]+$/, '') || 'download';
				rawName = sanitizeFileName(`${stem}${opts.ext.startsWith('.') ? opts.ext : '.' + opts.ext}`);
			}
		} catch { /* keep rawName */ }
	}

	const cat = categoryFor(opts.rawUrl, rawName);
	const category = cat.category;
	rawName = cat.rawName;

	const desiredPath = safeJoin(opts.baseDir, category, rawName);
	if (!desiredPath) return { ok: false, error: 'Invalid file path' };

	// Dedup keyed on SOURCE url. A picked format/direct URL allows multiple
	// qualities but still collapses an *active* identical source+target.
	let duplicate: (typeof downloads.$inferSelect) | undefined;
	const sameSource = await db.select().from(downloads).where(eq(downloads.url, opts.rawUrl));
	if (!opts.directUrl) {
		const activeDownload = sameSource.find((d) => ['queued', 'downloading', 'paused'].includes(d.status));
		const completedOnDisk = sameSource.find((d) => d.status === 'completed' && completedFileStillExists(d.savePath));
		duplicate = activeDownload ?? completedOnDisk;
	} else {
		duplicate = sameSource.find(
			(d) => ['queued', 'downloading'].includes(d.status) && path.basename(d.savePath) === rawName
		);
	}
	if (duplicate) {
		console.log(`♻️  Duplicate found! Attaching to existing download ID: ${duplicate.id}`);
		broadcast({ type: 'DOWNLOAD_ACK', downloadId: duplicate.id, fileName: duplicate.fileName, status: duplicate.status });
		return { ok: true, downloadId: duplicate.id };
	}

	const savePath = await uniqueSavePath(desiredPath);
	const finalName = path.basename(savePath);
	const downloadId = crypto.randomUUID();
	await db.insert(downloads).values({
		id: downloadId,
		deviceId: opts.macAddress,
		url: opts.rawUrl,
		fileName: finalName,
		savePath,
		status: 'queued'
	});
	broadcast({ type: 'DOWNLOAD_ACK', downloadId, fileName: finalName, status: 'queued' });
	console.log(`✅ Download queued with ID: ${downloadId}`);

	scheduleDownload(() => runDownloadJob({
		id: downloadId,
		pageUrl: opts.rawUrl,
		fileName: finalName,
		savePath,
		category,
		threads: opts.threads,
		allowRename: !opts.directUrl && !isDirectFileUrl(opts.rawUrl),
		directUrl: opts.directUrl || (isDirectFileUrl(opts.rawUrl) ? opts.rawUrl : undefined)
	}));
	return { ok: true, downloadId };
}

/**
 * On startup, reclaim downloads that were mid-flight when the process last
 * stopped. Their engine child was killed with us, but the `.veloce_state`
 * sidecar lets the engine resume. This delivers the crash-recovery promise.
 */
async function reconcileInterrupted() {
	try {
		const stuck = await db.select().from(downloads)
			.where(inArray(downloads.status, ['downloading', 'queued']));
		if (stuck.length === 0) return;
		console.log(`♻️  Reconciling ${stuck.length} interrupted download(s) after restart...`);
		for (const row of stuck) {
			await setStatus(row.id, 'queued');
			scheduleDownload(() => runDownloadJob(specFromRow(row)));
		}
	} catch (e) {
		console.error('Failed to reconcile interrupted downloads:', e);
	}
}

let reconciled = false;

export function setupWebSocketServer(server: Server) {
	const wss = new WebSocketServer({
		server,
		path: '/ws',
		verifyClient: (info: { origin: string; secure: boolean; req: import('http').IncomingMessage }) => {
			const ok = isAllowedOrigin(info.origin);
			if (!ok) console.warn(`🚫 Rejected WebSocket from disallowed origin: ${info.origin}`);
			return ok;
		}
	});

	if (!reconciled) {
		reconciled = true;
		void reconcileInterrupted();
	}

	wss.on('connection', async (ws) => {
		clients.add(ws);
		console.log(`Extension connected to Local Coordinator (${clients.size} client${clients.size === 1 ? '' : 's'})`);
		const macAddress = getMacAddress();

		try {
			const deviceResult = await db.select().from(devices).where(eq(devices.id, macAddress));
			if (deviceResult.length === 0) {
				await db.insert(devices).values({ id: macAddress, createdAt: new Date(), lastActive: new Date(), settings: {} });
			} else {
				await db.update(devices).set({ lastActive: new Date() }).where(eq(devices.id, macAddress));
			}
			await loadSettings(macAddress);
			if (ws.readyState === 1) {
				ws.send(JSON.stringify({ type: 'DIRECTORY_SELECTED', payload: { path: runtime.baseDirectory } }));
				ws.send(JSON.stringify({ type: 'SETTINGS', settings: { ...runtime } }));
			}
		} catch (err) {
			console.error('Failed to initialize device identity:', err);
		}

		// Rehydrate the popup with a snapshot of recent/active downloads.
		try {
			const recent = await db.select().from(downloads)
				.where(eq(downloads.deviceId, macAddress))
				.orderBy(sql`rowid desc`)
				.limit(20);
			if (ws.readyState === 1 && recent.length > 0) {
				ws.send(JSON.stringify({
					type: 'DOWNLOAD_SNAPSHOT',
					downloads: recent.map((d) => ({
						downloadId: d.id,
						fileName: d.fileName,
						status: d.status,
						downloaded: d.downloadedBytes ?? 0,
						total: d.totalBytes ?? 0
					}))
				}));
			}
		} catch (err) {
			console.error('Failed to send download snapshot:', err);
		}

		ws.on('message', async (message) => {
			try {
				const data = JSON.parse(message.toString());

				if (data.type === 'PING') {
					if (ws.readyState === 1) {
						ws.send(JSON.stringify({ type: 'PONG' }));
					}
					return;
				}

				if (data.type === 'NEW_DOWNLOAD') {
					console.log('📥 Received new download request:', data.payload);

					// Validate the URL up front (scheme + SSRF guard).
					const safety = isSafeDownloadUrl(data.payload.url ?? '');
					if (!safety.ok) {
						ws.send(JSON.stringify({ type: 'DOWNLOAD_ERROR', downloadId: null, error: safety.reason }));
						return;
					}
					if (data.payload.directUrl) {
						const directSafety = isSafeDownloadUrl(data.payload.directUrl);
						if (!directSafety.ok) {
							ws.send(JSON.stringify({ type: 'DOWNLOAD_ERROR', downloadId: null, error: directSafety.reason }));
							return;
						}
					}

					// Normalize URL (strip tracking params).
					let rawUrl = data.payload.url;
					try {
						const urlObj = new URL(rawUrl);
						for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'igsh', 'fbclid', 'gclid', 'si']) {
							urlObj.searchParams.delete(p);
						}
						rawUrl = urlObj.toString();
					} catch {
						console.error('Invalid URL during normalization');
					}

					const threads = data.payload.threads || runtime.defaultThreads;

					let baseDir = data.payload.baseDirectory;
					if (!baseDir || baseDir.trim() === '') {
						baseDir = runtime.baseDirectory;
					}

					// Playlist: expand into one download per entry (best format each).
					if (data.payload.playlist) {
						let entries: { url: string; title?: string }[] = [];
						try {
							entries = await listPlaylistEntries(rawUrl);
						} catch (e) {
							console.error('Playlist expansion failed:', e);
						}
						if (!entries.length) {
							ws.send(JSON.stringify({ type: 'DOWNLOAD_ERROR', downloadId: null, error: 'No playlist entries found (or not a playlist).' }));
							return;
						}
						console.log(`📃 Expanding playlist into ${entries.length} download(s)`);
						let queued = 0;
						for (const entry of entries) {
							if (!isSafeDownloadUrl(entry.url).ok) continue;
							const r = await queueDownload({
								macAddress,
								rawUrl: entry.url,
								fileName: entry.title || 'video',
								baseDir,
								threads
							});
							if (r.ok) queued++;
						}
						ws.send(JSON.stringify({ type: 'PLAYLIST_QUEUED', count: queued, total: entries.length }));
						return;
					}

					const result = await queueDownload({
						macAddress,
						rawUrl,
						fileName: data.payload.fileName || 'download_file',
						baseDir,
						threads,
						directUrl: data.payload.directUrl,
						ext: data.payload.ext
					});
					if (!result.ok) {
						ws.send(JSON.stringify({ type: 'DOWNLOAD_ERROR', downloadId: null, error: result.error }));
					}
				} else if (data.type === 'LIST_FORMATS') {
					const pageUrl = data.payload?.url ?? '';
					if (/^(blob:|data:|mediastream:)/i.test(pageUrl)) {
						ws.send(JSON.stringify({
							type: 'FORMATS_ERROR',
							requestId: data.requestId,
							error: 'Browser-only blob URL — reload the Veloce extension and refresh the page. The badge should resolve to the Instagram post link (/p/…).'
						}));
						return;
					}
					const safety = isSafeDownloadUrl(pageUrl);
					if (!safety.ok) {
						ws.send(JSON.stringify({ type: 'FORMATS_ERROR', requestId: data.requestId, error: safety.reason }));
						return;
					}
					try {
						const formats = await listFormats(pageUrl);
						if (!formats.length) {
							const hint = getRecentFormatError(pageUrl);
							ws.send(JSON.stringify({
								type: 'FORMATS_ERROR',
								requestId: data.requestId,
								error: hint ?? 'No formats found for this URL.'
							}));
							return;
						}
						ws.send(JSON.stringify({ type: 'FORMATS_LIST', requestId: data.requestId, formats }));
					} catch (e) {
						console.error('LIST_FORMATS failed:', e);
						ws.send(JSON.stringify({ type: 'FORMATS_ERROR', requestId: data.requestId, error: 'Could not list formats.' }));
					}
				} else if (data.type === 'PAUSE_DOWNLOAD') {
					const r = running.get(data.downloadId);
					if (r) {
						r.intent = 'paused';
						r.proc.kill('SIGTERM');
					}
				} else if (data.type === 'RESUME_DOWNLOAD') {
					const row = (await db.select().from(downloads).where(eq(downloads.id, data.downloadId)))[0];
					if (row && ['paused', 'error', 'queued'].includes(row.status) && !running.has(row.id)) {
						await setStatus(row.id, 'queued');
						broadcast({ type: 'DOWNLOAD_ACK', downloadId: row.id, fileName: row.fileName, status: 'queued' });
						scheduleDownload(() => runDownloadJob(specFromRow(row)));
					}
				} else if (data.type === 'CANCEL_DOWNLOAD') {
					const r = running.get(data.downloadId);
					if (r) {
						r.intent = 'cancelled';
						r.proc.kill('SIGTERM'); // close handler does cleanup + row delete
					} else {
						const row = (await db.select().from(downloads).where(eq(downloads.id, data.downloadId)))[0];
						if (row) {
							await cleanupFiles(row.savePath);
							await db.delete(downloads).where(eq(downloads.id, row.id));
						}
						broadcast({ type: 'DOWNLOAD_REMOVED', downloadId: data.downloadId });
					}
				} else if (data.type === 'REMOVE_DOWNLOAD') {
					// Remove from history only (keeps any completed file on disk).
					if (!running.has(data.downloadId)) {
						await db.delete(downloads).where(eq(downloads.id, data.downloadId));
						broadcast({ type: 'DOWNLOAD_REMOVED', downloadId: data.downloadId });
					}
				} else if (data.type === 'REQUEST_DIRECTORY_PICKER') {
					console.log('🔄 Directory picker requested by frontend');
					const result = pickDirectory();
					if (result) {
						runtime.baseDirectory = result;
						await persistSettings(macAddress);
						if (ws.readyState === 1) {
							ws.send(JSON.stringify({ type: 'DIRECTORY_SELECTED', payload: { path: result } }));
						}
					} else if (ws.readyState === 1) {
						ws.send(JSON.stringify({
							type: 'DIRECTORY_PICKER_UNAVAILABLE',
							error: 'No graphical folder picker found. Install zenity or kdialog, or type the path manually.'
						}));
					}
				} else if (data.type === 'OPEN_FILE' || data.type === 'REVEAL_FILE') {
					const row = (await db.select().from(downloads).where(eq(downloads.id, data.downloadId)))[0];
					if (!row) return;
					if (!existsSync(row.savePath)) {
						ws.send(JSON.stringify({ type: 'DOWNLOAD_ERROR', downloadId: row.id, error: 'File no longer exists on disk.' }));
						return;
					}
					if (data.type === 'OPEN_FILE') xdgOpen(row.savePath);
					else revealInFileManager(row.savePath);
				} else if (data.type === 'GET_SETTINGS') {
					if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'SETTINGS', settings: { ...runtime } }));
				} else if (data.type === 'SET_SETTINGS') {
					applySettings(data.payload ?? {});
					await persistSettings(macAddress);
					pumpScheduler(); // a raised concurrency cap may free queued jobs immediately
					broadcast({ type: 'SETTINGS', settings: { ...runtime } });
				}
			} catch (err) {
				console.error('❌ Failed to process WebSocket message:', err);
			}
		});

		ws.on('close', () => {
			clients.delete(ws);
			console.log(`Extension disconnected (${clients.size} client${clients.size === 1 ? '' : 's'} remaining)`);
		});
	});
}
