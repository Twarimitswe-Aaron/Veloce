import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
	detectMediaSource,
	failCacheTtlMs,
	failReasonForSource,
	inferFormatKind,
	isManifestFormatUrl,
	type FormatKind,
	type MediaSource
} from './formatSources';

export type { FormatKind, MediaSource };

export interface MediaFormat {
	id: string;
	label: string;
	url: string;
	ext: string;
	filesize?: number;
	/** Platform that produced this format (youtube, instagram, …). */
	source?: MediaSource;
	/** How the engine should fetch it. */
	kind?: FormatKind;
}

const EXTRACTOR_DOMAINS = [
	'youtube.com', 'youtu.be', 'instagram.com', 'tiktok.com',
	'twitter.com', 'x.com', 'vimeo.com', 'facebook.com', 'twitch.tv', 'mediafire.com'
];

const FORMAT_CACHE_TTL_MS = 10 * 60 * 1000;
const FAIL_CACHE_TTL_MS = 90 * 1000;
const formatCache = new Map<string, { formats: MediaFormat[]; ts: number }>();
const failCache = new Map<string, { reason: string; ts: number; source?: MediaSource }>();
const inflight = new Map<string, Promise<MediaFormat[]>>();

/** Browsers to try for cookie auth — chrome first (most users log in there). */
const COOKIE_BROWSER_ORDER = ['chrome', 'chromium', 'firefox', 'brave'] as const;

const BROWSER_COOKIE_PATHS: Partial<Record<(typeof COOKIE_BROWSER_ORDER)[number], string>> = {
	chrome: path.join(os.homedir(), '.config/google-chrome/Default/Cookies'),
	chromium: path.join(os.homedir(), '.config/chromium/Default/Cookies'),
	brave: path.join(os.homedir(), '.config/BraveSoftware/Brave-Browser/Default/Cookies')
};

/** Skip browsers with no cookie DB (avoids brave spam on machines without Brave). */
function availableCookieBrowsers(): (typeof COOKIE_BROWSER_ORDER)[number][] {
	const out: (typeof COOKIE_BROWSER_ORDER)[number][] = [];
	for (const browser of COOKIE_BROWSER_ORDER) {
		if (browser === 'firefox') {
			out.push(browser);
			continue;
		}
		const cookiePath = BROWSER_COOKIE_PATHS[browser];
		if (cookiePath && fs.existsSync(cookiePath)) out.push(browser);
	}
	return out.length ? out : ['chrome'];
}

/**
 * YouTube requires solving JS challenges (n-parameter / signatures). yt-dlp needs a JS runtime.
 * @see https://github.com/yt-dlp/yt-dlp/wiki/EJS
 */
function ytdlpSharedArgs(): string[] {
	return ['--js-runtimes', 'node'];
}

const INSTAGRAM_FAIL_CACHE_TTL_MS = 5 * 60 * 1000;
const ytDlpErrorLogged = new Set<string>();

/** Canonical cache key — same video/post must map to one key across content, SW, and backend. */
export function normalizeFormatUrl(url: string): string {
	try {
		const u = new URL(url);
		u.hash = '';
		const host = u.hostname.toLowerCase();
		if (host === 'youtu.be') {
			const id = u.pathname.split('/').filter(Boolean)[0];
			if (id) return `https://www.youtube.com/watch?v=${id}`;
		}
		if (host.includes('youtube.com')) {
			if (u.pathname.startsWith('/shorts/')) {
				const id = u.pathname.split('/').filter(Boolean)[1];
				if (id) return `https://www.youtube.com/shorts/${id}`;
			}
			if (u.pathname === '/watch') {
				const v = u.searchParams.get('v');
				if (v) return `https://www.youtube.com/watch?v=${v}`;
			}
		}
		if (/instagram\.com/i.test(u.hostname)) {
			u.search = '';
			u.pathname = u.pathname.replace(/\/+$/, '');
		}
		return u.href;
	} catch {
		return url;
	}
}

function normalizePageUrl(url: string): string {
	return normalizeFormatUrl(url);
}

/** Reel and /p/ URLs share the same shortcode — try both if one fails. */
function instagramUrlVariants(url: string): string[] {
	if (!/instagram\.com/i.test(url)) return [url];
	const variants = new Set<string>([normalizePageUrl(url)]);
	const m = url.match(/instagram\.com\/(reel|p|tv)\/([^/?#]+)/i);
	if (m) {
		const code = m[2];
		variants.add(`https://www.instagram.com/p/${code}`);
		variants.add(`https://www.instagram.com/reel/${code}`);
	}
	return [...variants];
}

export function getRecentFormatError(url: string): string | undefined {
	const key = normalizePageUrl(url);
	const hit = failCache.get(key);
	if (!hit) return undefined;
	const source = hit.source ?? detectMediaSource(key);
	const ttl = failCacheTtlMs(source, key);
	if (Date.now() - hit.ts < ttl) return hit.reason;
	return undefined;
}

function isTrapDownloadUrl(url: string): boolean {
	try {
		const u = new URL(url);
		const path = u.pathname.toLowerCase();
		if (/\/redirect|\/pkg\/|\/api\/|\/graphql|\/download\?/i.test(path)) return true;
		if (/redirect|download/i.test(u.searchParams.get('a') || '')) return true;
		return false;
	} catch {
		return false;
	}
}

export function isExtractorDomain(url: string): boolean {
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		return EXTRACTOR_DOMAINS.some((d) => hostname.includes(d));
	} catch {
		return false;
	}
}

export { detectMediaSource, isManifestFormatUrl } from './formatSources';

function formatBytes(n: number): string {
	if (!n) return '';
	const units = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(n) / Math.log(1024));
	return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function getCached(url: string): MediaFormat[] | null {
	const hit = formatCache.get(url);
	if (hit && Date.now() - hit.ts < FORMAT_CACHE_TTL_MS) return hit.formats;
	return null;
}

function setCached(url: string, formats: MediaFormat[]) {
	if (formats.length > 0) formatCache.set(url, { formats, ts: Date.now() });
}

/**
 * List downloadable formats for a URL. Video/social pages go through yt-dlp;
 * direct file links return a single "Direct" entry.
 */
export async function listFormats(url: string, opts?: { force?: boolean }): Promise<MediaFormat[]> {
	const key = normalizePageUrl(url);
	const cached = getCached(key);
	if (cached) return cached;

	if (!opts?.force) {
		const recentFail = failCache.get(key);
		if (recentFail) {
			const ttl = /instagram\.com/i.test(key) ? INSTAGRAM_FAIL_CACHE_TTL_MS : FAIL_CACHE_TTL_MS;
			if (Date.now() - recentFail.ts < ttl) return [];
		}
	}

	if (inflight.has(key)) {
		return inflight.get(key)!;
	}

	const work = listFormatsUncached(key, url, opts).finally(() => inflight.delete(key));
	inflight.set(key, work);
	return work;
}

async function listFormatsUncached(
	cacheKey: string,
	url: string,
	opts?: { force?: boolean }
): Promise<MediaFormat[]> {
	const source = detectMediaSource(url);
	if (url.includes('mediafire.com')) {
		const direct = await resolveMediafireDownload(url);
		if (!direct) {
			failCache.set(cacheKey, {
				reason: 'MediaFire link expired or unavailable. Open the MediaFire file page in your browser and try again.',
				ts: Date.now()
			});
			return [];
		}
		const name = path.basename(new URL(direct).pathname) || 'download';
		const formats = [{ id: 'direct', label: `Direct — ${name}`, url: direct, ext: path.extname(name) || '.bin', source: 'mediafire' as MediaSource, kind: 'direct' as FormatKind }];
		setCached(cacheKey, formats);
		return formats;
	}

	if (isDirectFileUrl(url)) {
		const name = path.basename(new URL(url).pathname) || 'download';
		const formats = [{ id: 'direct', label: `Direct — ${name}`, url, ext: path.extname(name) || '.bin', source: 'direct' as MediaSource, kind: 'direct' as FormatKind }];
		setCached(cacheKey, formats);
		return formats;
	}

	if (!isExtractorDomain(url)) {
		if (isTrapDownloadUrl(url)) {
			failCache.set(cacheKey, {
				reason: 'Redirect/API link — use the Veloce intercept format picker on the page instead of this URL directly.',
				ts: Date.now()
			});
			return [];
		}
		try {
			const u = new URL(url);
			const name = path.basename(u.pathname) || 'download';
			const ext = path.extname(name) || '.bin';
			const formats = [{ id: 'direct', label: `Direct — ${name}`, url, ext, source: 'direct' as MediaSource, kind: 'direct' as FormatKind }];
			setCached(cacheKey, formats);
			return formats;
		} catch {
			return [];
		}
	}

	const { formats, lastErr } = await listFormatsBySource(url, source, opts);
	if (formats.length > 0) {
		setCached(cacheKey, formats);
	} else {
		failCache.set(cacheKey, {
			reason: failReasonForSource(source, lastErr),
			ts: Date.now(),
			source
		});
	}
	return formats;
}

type YtDlpAttempt = {
	cookieArgs: string[];
	extraArgs?: string[];
	timeoutMs: number;
	label: string;
	allowPlaylist?: boolean;
};

type FormatListResult = { formats: MediaFormat[]; lastErr: string };

async function listFormatsBySource(
	url: string,
	source: MediaSource,
	opts?: { force?: boolean }
): Promise<FormatListResult> {
	switch (source) {
		case 'instagram':
			return raceInstagramFormats(url, opts?.force === true);
		case 'youtube':
			return raceYoutubeFormats(url, opts?.force === true);
		default:
			return raceGenericYtDlpFormats(url, source, opts?.force === true);
	}
}

async function raceInstagramFormats(url: string, force: boolean): Promise<FormatListResult> {
	const urls = instagramUrlVariants(url);
	// Chrome first — most users log in there; Chromium-only misses cookies on Linux.
	const browsers = force
		? (['chrome', 'chromium', 'brave', 'firefox'] as const)
		: (['chrome', 'chromium'] as const);
	const timeoutMs = force ? 24_000 : 14_000;
	let lastErr = '';

	for (const pageUrl of urls) {
		for (const browser of browsers) {
			const run = runYtDlpJson(pageUrl, ['--cookies-from-browser', browser], timeoutMs, {
				allowPlaylist: true,
				label: `instagram/${browser}`
			});
			const formats = tagFormats(await run.promise, 'instagram');
			run.kill();
			if (formats.length) return { formats, lastErr: '' };
			lastErr = run.getError() || lastErr;
		}
	}
	return { formats: [], lastErr };
}

function youtubeAttempts(force: boolean): YtDlpAttempt[] {
	const out: YtDlpAttempt[] = [];
	const timeout = force ? 28_000 : 18_000;
	for (const browser of availableCookieBrowsers()) {
		out.push({
			cookieArgs: ['--cookies-from-browser', browser],
			timeoutMs: timeout,
			label: `youtube/${browser}`
		});
	}
	for (const client of ['android', 'web', 'ios'] as const) {
		out.push({
			cookieArgs: ['--cookies-from-browser', 'chrome'],
			extraArgs: ['--extractor-args', `youtube:player_client=${client}`],
			timeoutMs: force ? 24_000 : 14_000,
			label: `youtube/chrome/${client}`
		});
	}
	out.push({
		cookieArgs: [],
		timeoutMs: 10_000,
		label: 'youtube/no-cookies'
	});
	return out;
}

async function raceYoutubeFormats(url: string, force: boolean): Promise<FormatListResult> {
	const attempts = youtubeAttempts(force);
	let lastErr = '';

	if (force) {
		for (const attempt of attempts) {
			const run = runYtDlpJson(url, attempt.cookieArgs, attempt.timeoutMs, {
				label: attempt.label,
				extraArgs: attempt.extraArgs
			});
			const formats = tagFormats(await run.promise, 'youtube');
			run.kill();
			if (formats.length) return { formats, lastErr: '' };
			lastErr = run.getError() || lastErr;
		}
		return { formats: [], lastErr };
	}

	// Fast path: one chrome/chromium attempt usually succeeds in ~7s once JS runtime is enabled.
	const primary = attempts[0];
	if (primary) {
		const run = runYtDlpJson(url, primary.cookieArgs, primary.timeoutMs, {
			label: primary.label,
			extraArgs: primary.extraArgs
		});
		const primaryFormats = tagFormats(await run.promise, 'youtube');
		lastErr = run.getError() || lastErr;
		run.kill();
		if (primaryFormats.length) return { formats: primaryFormats, lastErr: '' };
	}

	const fallbacks = attempts.slice(1, 5);
	if (!fallbacks.length) return { formats: [], lastErr };

	const runners = fallbacks.map((attempt) =>
		runYtDlpJson(url, attempt.cookieArgs, attempt.timeoutMs, {
			label: attempt.label,
			extraArgs: attempt.extraArgs
		})
	);

	return new Promise((resolve) => {
		let finished = 0;
		let resolved = false;
		let bestErr = lastErr;

		const finishAll = (formats: MediaFormat[]) => {
			if (!resolved) {
				resolved = true;
				for (const r of runners) r.kill();
				resolve({ formats: tagFormats(formats, 'youtube'), lastErr: bestErr });
			}
		};

		for (const r of runners) {
			r.promise.then((formats) => {
				if (!resolved && formats.length > 0) {
					finishAll(formats);
					return;
				}
				bestErr = r.getError() || bestErr;
				finished++;
				if (finished === runners.length && !resolved) finishAll([]);
			});
		}
	});
}

async function raceGenericYtDlpFormats(
	url: string,
	source: MediaSource,
	force: boolean
): Promise<FormatListResult> {
	const attempts: YtDlpAttempt[] = [
		{ cookieArgs: ['--cookies-from-browser', 'chrome'], timeoutMs: force ? 24_000 : 20_000, label: `${source}/chrome` },
		{ cookieArgs: ['--cookies-from-browser', 'chromium'], timeoutMs: force ? 24_000 : 20_000, label: `${source}/chromium` },
		{ cookieArgs: [], timeoutMs: 12_000, label: `${source}/no-cookies` }
	];
	let lastErr = '';

	if (force) {
		for (const attempt of attempts) {
			const run = runYtDlpJson(url, attempt.cookieArgs, attempt.timeoutMs, { label: attempt.label });
			const formats = tagFormats(await run.promise, source);
			run.kill();
			if (formats.length) return { formats, lastErr: '' };
			lastErr = run.getError() || lastErr;
		}
		return { formats: [], lastErr };
	}

	const runners = attempts.map((attempt) =>
		runYtDlpJson(url, attempt.cookieArgs, attempt.timeoutMs, { label: attempt.label })
	);

	return new Promise((resolve) => {
		let finished = 0;
		let resolved = false;
		let bestErr = '';

		const finishAll = (formats: MediaFormat[]) => {
			if (!resolved) {
				resolved = true;
				for (const r of runners) r.kill();
				resolve({ formats: tagFormats(formats, source), lastErr: bestErr });
			}
		};

		for (const r of runners) {
			r.promise.then((formats) => {
				if (!resolved && formats.length > 0) {
					finishAll(formats);
					return;
				}
				bestErr = r.getError() || bestErr;
				finished++;
				if (finished === runners.length && !resolved) finishAll([]);
			});
		}
	});
}

function tagFormats(formats: MediaFormat[], source: MediaSource): MediaFormat[] {
	return formats.map((f) => ({
		...f,
		source: f.source ?? source,
		kind: f.kind ?? (isManifestFormatUrl(f.url) ? 'manifest' : 'progressive')
	}));
}

type YtDlpRunOpts = { allowPlaylist?: boolean; label?: string; extraArgs?: string[] };

function runYtDlpJson(
	url: string,
	cookieArgs: string[],
	timeoutMs: number,
	opts: YtDlpRunOpts = {}
): { promise: Promise<MediaFormat[]>; kill: () => void; getError: () => string } {
	let proc: ChildProcess | null = null;
	let lastErr = '';

	const kill = () => {
		try {
			proc?.kill('SIGTERM');
		} catch { /* ignore */ }
	};

	const getError = () => lastErr;

	const promise = new Promise<MediaFormat[]>((resolve) => {
		const ytdlpPath = path.resolve(process.cwd(), 'bin', 'yt-dlp');
		const args = [
			...ytdlpSharedArgs(),
			...cookieArgs,
			...(opts.extraArgs ?? []),
			'--no-warnings',
			'--no-progress',
			'--socket-timeout', '12',
			'--retries', '1',
			'-J',
			'--',
			url
		];
		if (!opts.allowPlaylist) {
			args.splice(args.length - 2, 0, '--no-playlist');
		}

		proc = spawn(ytdlpPath, args);

		let output = '';
		let settled = false;
		const done = (result: MediaFormat[]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (!result.length && lastErr && opts.label) {
				const logKey = `${opts.label}:${url}`;
				if (!ytDlpErrorLogged.has(logKey)) {
					ytDlpErrorLogged.add(logKey);
					console.error(`[yt-dlp formats/${opts.label}]: ${lastErr}`);
					setTimeout(() => ytDlpErrorLogged.delete(logKey), 120_000);
				}
			}
			resolve(result);
		};

		const timeout = setTimeout(() => {
			kill();
			done([]);
		}, timeoutMs);

		proc.stdout?.on('data', (data) => { output += data.toString(); });
		proc.stderr?.on('data', (data) => {
			const line = data.toString().trim();
			if (line.startsWith('ERROR:')) lastErr = line.replace(/^ERROR:\s*/, '');
		});

		proc.on('close', () => {
			if (!output.trim()) {
				done([]);
				return;
			}
			try {
				const parsed = parseYtDlpFormats(output);
				done(parsed);
			} catch (e) {
				console.error('[Extractor] Failed to parse yt-dlp JSON', e);
				done([]);
			}
		});

		proc.on('error', () => done([]));
	});

	return { promise, kill, getError };
}

function parseYtDlpFormats(output: string): MediaFormat[] {
	let info: Record<string, unknown> | null;
	try {
		info = JSON.parse(output);
	} catch {
		return [];
	}
	if (!info || typeof info !== 'object') return [];

	if (info._type === 'playlist' && Array.isArray(info.entries)) {
		const merged: MediaFormat[] = [];
		const baseTitle = ((info.title as string) || 'post').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
		const total = info.entries.length;
		for (let i = 0; i < info.entries.length; i++) {
			const entry = info.entries[i];
			if (!entry) continue;
			const suffix = total > 1 ? ` [${i + 1}/${total}]` : '';
			merged.push(...formatsFromInfo(entry, `${baseTitle}${suffix}`));
		}
		if (merged.length > 0) return dedupeFormats(merged).slice(0, 40);
	}

	return dedupeFormats(formatsFromInfo(info, (info.title as string) || 'video'));
}

function formatsFromInfo(info: Record<string, unknown>, title: string): MediaFormat[] {
	const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
	const raw = (info.formats as Record<string, unknown>[]) ?? [];
	const out: MediaFormat[] = [];

	// Single direct URL (some extractors skip the formats array).
	const directUrl = info.url as string | undefined;
	const directExt = (info.ext as string) || 'mp4';
	if (directUrl && raw.length === 0) {
		out.push({
			id: '0',
			label: `${safeTitle} — ${directExt}`,
			url: directUrl,
			ext: directExt.startsWith('.') ? directExt : `.${directExt}`
		});
	}

	for (const f of raw) {
		if (!f.url) continue;
		const formatId = String(f.format_id ?? '');
		if (f.ext === 'mhtml' || f.format_note === 'storyboard' || formatId.startsWith('sb')) continue;
		const hasVideo = f.vcodec && f.vcodec !== 'none';
		const hasAudio = f.acodec && f.acodec !== 'none';
		if (!hasVideo && !hasAudio) continue;

		const res = f.resolution && f.resolution !== 'audio only' ? f.resolution : '';
		const kind = hasVideo && hasAudio ? 'video+audio' : hasVideo ? 'video' : 'audio';
		const size = (f.filesize || f.filesize_approx) as number | undefined;
		const sizeStr = size ? ` · ${formatBytes(size)}` : '';
		const ext = (f.ext as string) || 'mp4';
		const label = [res || kind, ext, sizeStr].filter(Boolean).join(' ');

		out.push({
			id: String(f.format_id),
			label: `${safeTitle} — ${label}`.trim(),
			url: f.url as string,
			ext: ext.startsWith('.') ? ext : `.${ext}`,
			filesize: size,
			kind: inferFormatKind(f.url as string, f.protocol as string | undefined)
		});
	}

	return out;
}

const MF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function isMediafireCdnHost(hostname: string): boolean {
	return /^download\d+\.mediafire\.com$/i.test(hostname);
}

function isMediafireFilePage(url: string): boolean {
	return /www\.mediafire\.com\/file\//i.test(url);
}

/** True when the URL already points at a file, not an HTML landing page. */
export function isDirectFileUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (!/^https?:$/i.test(u.protocol)) return false;
		if (isMediafireCdnHost(u.hostname)) return true;
		return /\.(mp4|mkv|webm|avi|mov|m4v|mp3|wav|flac|ogg|m4a|zip|rar|7z|tar|gz|bz2|pdf|png|jpe?g|gif|webp|svg|iso)(\?|#|$)/i.test(u.pathname);
	} catch {
		return false;
	}
}

/** CDN URLs embed `/qkey/filename` — rebuild the public file page from that. */
function mediafireFilePageFromCdn(url: string): string | null {
	try {
		const parts = new URL(url).pathname.split('/').filter(Boolean);
		if (parts.length < 2) return null;
		const fileName = decodeURIComponent(parts[parts.length - 1]);
		const qkey = parts[parts.length - 2];
		return `https://www.mediafire.com/file/${qkey}/${fileName}`;
	} catch {
		return null;
	}
}

/** HEAD without following redirects — CDN links expire and 302 to a repair page. */
async function probeMediafireCdn(url: string): Promise<string | null> {
	try {
		const res = await fetch(url, {
			method: 'HEAD',
			redirect: 'manual',
			headers: { 'User-Agent': MF_UA }
		});
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get('location') ?? '';
			if (loc.includes('download_repair')) return null;
		}
		if (res.status === 200) {
			const ct = res.headers.get('content-type') ?? '';
			if (ct.includes('video/') || ct.includes('audio/') || ct.includes('octet-stream')) {
				return url;
			}
		}
		if (res.status === 206) return url;
	} catch { /* fall through */ }
	return null;
}

async function parseMediafirePage(url: string): Promise<string | null> {
	try {
		const res = await fetch(url, {
			redirect: 'follow',
			headers: {
				Range: 'bytes=0-131071',
				'User-Agent': MF_UA
			}
		});
		const ct = res.headers.get('content-type') ?? '';
		if (ct.includes('video/') || ct.includes('audio/') || ct.includes('application/octet-stream')) {
			return url;
		}
		const html = await res.text();
		const match = html.match(/href="(https?:\/\/download\d+\.mediafire\.com[^"]+)"/i);
		return match?.[1] ?? null;
	} catch (e) {
		console.error('[Extractor] Failed to parse Mediafire page', e);
		return null;
	}
}

async function resolveMediafireDownload(url: string): Promise<string | null> {
	if (isMediafireFilePage(url)) {
		return parseMediafirePage(url);
	}
	if (isMediafireCdnHost(new URL(url).hostname)) {
		const live = await probeMediafireCdn(url);
		if (live) return live;
		const filePage = mediafireFilePageFromCdn(url);
		if (filePage) {
			return parseMediafirePage(filePage);
		}
	}
	if (url.includes('mediafire.com')) {
		return parseMediafirePage(url);
	}
	return null;
}

function dedupeFormats(out: MediaFormat[]): MediaFormat[] {
	out.sort((a, b) => (b.filesize ?? 0) - (a.filesize ?? 0));
	const seen = new Set<string>();
	return out.filter((f) => {
		const key = `${f.label}|${f.ext}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export interface PlaylistEntry {
	url: string;
	title?: string;
}

/**
 * Return the entries of a playlist (YouTube playlist, channel, Instagram
 * carousel, etc.) using yt-dlp's flat listing. Each entry is a single item URL
 * the caller can queue as its own download. Returns [] for non-playlists.
 */
export async function listPlaylistEntries(url: string): Promise<PlaylistEntry[]> {
	if (!isExtractorDomain(url)) return [];

	for (const cookieArgs of [[], ['--cookies-from-browser', 'chromium'], ['--cookies-from-browser', 'chrome']]) {
		const entries = await runYtDlpFlatPlaylist(url, cookieArgs);
		if (entries.length) return entries;
	}
	return [];
}

function runYtDlpFlatPlaylist(url: string, cookieArgs: string[]): Promise<PlaylistEntry[]> {
	return new Promise((resolve) => {
		const ytdlpPath = path.resolve(process.cwd(), 'bin', 'yt-dlp');
		const proc = spawn(ytdlpPath, [
			...ytdlpSharedArgs(),
			...cookieArgs,
			'--flat-playlist',
			'--no-warnings',
			'--no-progress',
			'--socket-timeout', '12',
			'--retries', '1',
			'-J',
			'--',
			url
		]);

		let output = '';
		let settled = false;
		const done = (result: PlaylistEntry[]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(result);
		};
		const timeout = setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } done([]); }, 40_000);

		proc.stdout?.on('data', (d) => { output += d.toString(); });
		proc.on('error', () => done([]));
		proc.on('close', () => {
			if (!output.trim()) return done([]);
			try {
				const info = JSON.parse(output);
				if (info._type !== 'playlist' || !Array.isArray(info.entries)) return done([]);
				const out: PlaylistEntry[] = [];
				for (const e of info.entries) {
					if (!e) continue;
					const entryUrl = (e.url as string) || (e.webpage_url as string) ||
						(e.id ? `https://www.youtube.com/watch?v=${e.id}` : '');
					if (entryUrl && /^https?:/i.test(entryUrl)) {
						out.push({ url: entryUrl, title: (e.title as string) || undefined });
					}
				}
				done(out);
			} catch {
				done([]);
			}
		});
	});
}

/**
 * Extracts the direct media URL from a social media link (Instagram, YouTube, etc) using yt-dlp.
 * @param url The raw social media URL
 * @returns The absolute direct media URL, or null if it fails
 */
export async function extractMediaUrl(url: string): Promise<string | null> {
	if (url.includes('mediafire.com')) {
		return resolveMediafireDownload(url);
	}

	if (isDirectFileUrl(url)) {
		return url;
	}
    const cookieStrategies: string[][] = [
        ['--cookies-from-browser', 'chrome'],
        ['--cookies-from-browser', 'chromium'],
        ['--cookies-from-browser', 'firefox'],
        [],
    ];

    for (const cookieArgs of cookieStrategies) {
        const label = cookieArgs.length ? cookieArgs[1] : 'no-cookies';
        const directUrl = await runYtDlp(url, cookieArgs);
        if (directUrl) {
            return directUrl;
        }
        console.error(`[Extractor] yt-dlp attempt failed (${label}) for ${url}`);
    }

    console.error(`[Extractor] All yt-dlp strategies failed for ${url}`);
    return null;
}

/**
 * Run yt-dlp once with a given cookie strategy and return the first direct
 * media URL, or null on failure/timeout. Uses `-f b` (best progressive stream)
 * so the engine receives a single downloadable URL with audio+video combined.
 */
function runYtDlp(url: string, cookieArgs: string[]): Promise<string | null> {
    return new Promise((resolve) => {
        const ytdlpPath = path.resolve(process.cwd(), 'bin', 'yt-dlp');
        const ytdlp = spawn(ytdlpPath, [
            ...ytdlpSharedArgs(),
            ...cookieArgs,
            '-f', 'b/best',
            '--no-playlist',
            '--no-warnings',
            '--no-progress',
            '--socket-timeout', '12',
            '--retries', '1',
            '-g',
            '--',
            url
        ]);

        let output = '';
        let settled = false;
        const done = (result: string | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };

        const timeout = setTimeout(() => {
            ytdlp.kill();
            console.error(`[yt-dlp] Timed out after 30s for: ${url}`);
            done(null);
        }, 30_000);

        ytdlp.stdout.on('data', (data) => {
            output += data.toString();
        });

        ytdlp.stderr.on('data', (data) => {
            console.error(`[yt-dlp log]: ${data.toString().trim()}`);
        });

        ytdlp.on('close', (code) => {
            if (code === 0 && output.trim()) {
                done(output.trim().split('\n')[0]);
            } else {
                done(null);
            }
        });

        ytdlp.on('error', (err) => {
            console.error('yt-dlp error (is it installed?):', err);
            done(null);
        });
    });
}
