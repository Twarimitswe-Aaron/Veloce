import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { db } from './db';
import { downloads, devices } from './db/schema';
import { getMacAddress } from './identity';
import { eq, or, sql, inArray } from 'drizzle-orm';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import { statfs, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { extractMediaUrl } from './extractor';
import { config } from './config';

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

/**
 * Validate a user-supplied download URL: only http(s), and (optionally) block
 * hosts that point back at the local machine / private networks / cloud
 * metadata endpoints. This is an SSRF guard — important because the engine
 * fetches whatever URL it is given.
 */
function isSafeDownloadUrl(raw: string): { ok: true } | { ok: false; reason: string } {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return { ok: false, reason: 'Invalid URL.' };
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') {
		return { ok: false, reason: `Unsupported protocol "${u.protocol}". Only http/https are allowed.` };
	}
	if (config.blockPrivateHosts) {
		const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
		const isPrivate =
			host === 'localhost' ||
			host === '0.0.0.0' ||
			host === '::1' ||
			host.endsWith('.localhost') ||
			/^127\./.test(host) ||
			/^10\./.test(host) ||
			/^192\.168\./.test(host) ||
			/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
			/^169\.254\./.test(host) || // link-local incl. 169.254.169.254 metadata
			/^fe80:/i.test(host) ||
			/^fc00:/i.test(host) ||
			/^fd[0-9a-f]{2}:/i.test(host);
		if (isPrivate) {
			return { ok: false, reason: 'Downloads from local/private network addresses are blocked.' };
		}
	}
	return { ok: true };
}

/** Strip any directory components / control chars so a filename can't escape its folder. */
function sanitizeFileName(name: string): string {
	let base = path.basename(name || '').replace(/[\\/\x00-\x1f]/g, '_').trim();
	if (!base || base === '.' || base === '..') base = `download_${Date.now()}`;
	return base.slice(0, 200);
}

/**
 * Join into a path that is guaranteed to stay within `baseDir`. Returns null if
 * the result would escape the base (defense-in-depth against traversal).
 */
function safeJoin(baseDir: string, category: string, fileName: string): string | null {
	const root = path.resolve(baseDir);
	const target = path.resolve(root, category, sanitizeFileName(fileName));
	const rel = path.relative(root, target);
	if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
	return target;
}

// ── Filesystem / disk helpers ────────────────────────────────────────────────

function completedFileStillExists(savePath: string): boolean {
	return existsSync(`${savePath}.veloce_done`) || existsSync(savePath);
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

// ── Scheduler: cap concurrent engine processes ───────────────────────────────
const MAX_CONCURRENT_DOWNLOADS = 3;
let activeDownloads = 0;
const pendingJobs: Array<() => Promise<void>> = [];

function pumpScheduler() {
	while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && pendingJobs.length > 0) {
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
		let finalUrl = spec.pageUrl;

		// (Re)extract direct media URL for video/social sites.
		if (spec.category === VIDEO_CATEGORY) {
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
		const rustProcess = spawn(
			binaryPath,
			['--id', id, '--url', finalUrl, '--save-path', savePath, '--threads', spec.threads.toString()],
			{ stdio: ['ignore', 'pipe', 'inherit'] }
		);
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
		console.log('Extension connected to Local Coordinator via WebSocket!');
		clients.add(ws);
		const macAddress = getMacAddress();

		try {
			const deviceResult = await db.select().from(devices).where(eq(devices.id, macAddress));
			if (deviceResult.length === 0) {
				await db.insert(devices).values({ id: macAddress, createdAt: new Date(), lastActive: new Date(), settings: {} });
			} else {
				await db.update(devices).set({ lastActive: new Date() }).where(eq(devices.id, macAddress));
				const settings = deviceResult[0].settings as any;
				if (settings?.baseDirectory && ws.readyState === 1) {
					ws.send(JSON.stringify({ type: 'DIRECTORY_SELECTED', payload: { path: settings.baseDirectory } }));
				}
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

				if (data.type === 'NEW_DOWNLOAD') {
					console.log('📥 Received new download request:', data.payload);

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

					const threads = data.payload.threads || 8;

					let baseDir = data.payload.baseDirectory;
					if (!baseDir || baseDir.trim() === '') {
						baseDir = path.join(os.homedir(), 'Downloads', 'Veloce');
					}

					// Categorize by domain, then extension.
					let rawName = sanitizeFileName(data.payload.fileName || 'download_file');
					let ext = path.extname(rawName).toLowerCase();
					let category = 'others';
					try {
						const hostname = new URL(data.payload.url).hostname.toLowerCase();
						const extractorDomains = ['youtube.com', 'youtu.be', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com', 'vimeo.com', 'facebook.com', 'twitch.tv', 'mediafire.com'];
						if (extractorDomains.some((d) => hostname.includes(d))) {
							category = VIDEO_CATEGORY;
							if (!ext) {
								ext = '.mp4';
								rawName += ext;
							}
						}
					} catch {
						// ignore invalid URL
					}
					if (category === 'others') {
						if (['.mp4', '.mkv', '.webm', '.avi', '.mov'].includes(ext)) category = VIDEO_CATEGORY;
						else if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) category = 'images';
						else if (['.mp3', '.wav', '.flac', '.ogg'].includes(ext)) category = 'audio';
						else if (['.pdf', '.doc', '.docx', '.txt'].includes(ext)) category = 'documents';
						else if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) category = 'archives';
					}

					const savePath = safeJoin(baseDir, category, rawName);
					if (!savePath) {
						ws.send(JSON.stringify({ type: 'DOWNLOAD_ERROR', downloadId: null, error: 'Invalid file path' }));
						return;
					}

					// Dedup: in-flight rows, or completed rows whose bytes still exist.
					const existing = await db.select().from(downloads)
						.where(or(eq(downloads.url, rawUrl), eq(downloads.savePath, savePath)));
					const activeDownload = existing.find((d) => ['queued', 'downloading', 'paused'].includes(d.status));
					const completedOnDisk = existing.find((d) => d.status === 'completed' && completedFileStillExists(d.savePath));
					const duplicate = activeDownload ?? completedOnDisk;

					if (duplicate) {
						console.log(`♻️  Duplicate found! Attaching to existing download ID: ${duplicate.id}`);
						ws.send(JSON.stringify({ type: 'DOWNLOAD_ACK', downloadId: duplicate.id, fileName: duplicate.fileName, status: duplicate.status }));
						return;
					}

					const downloadId = crypto.randomUUID();
					await db.insert(downloads).values({
						id: downloadId,
						deviceId: macAddress,
						url: rawUrl,
						fileName: rawName,
						savePath,
						status: 'queued'
					});
					broadcast({ type: 'DOWNLOAD_ACK', downloadId, fileName: rawName, status: 'queued' });
					console.log(`✅ Download queued with ID: ${downloadId}`);

					scheduleDownload(() => runDownloadJob({
						id: downloadId,
						pageUrl: rawUrl,
						fileName: rawName,
						savePath,
						category,
						threads,
						allowRename: true
					}));
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
						await db.update(devices).set({ settings: { baseDirectory: result } }).where(eq(devices.id, macAddress));
						if (ws.readyState === 1) {
							ws.send(JSON.stringify({ type: 'DIRECTORY_SELECTED', payload: { path: result } }));
						}
					} else if (ws.readyState === 1) {
						ws.send(JSON.stringify({
							type: 'DIRECTORY_PICKER_UNAVAILABLE',
							error: 'No graphical folder picker found. Install zenity or kdialog, or type the path manually.'
						}));
					}
				}
			} catch (err) {
				console.error('❌ Failed to process WebSocket message:', err);
			}
		});

		ws.on('close', () => {
			clients.delete(ws);
			console.log('Extension disconnected.');
		});
	});
}
