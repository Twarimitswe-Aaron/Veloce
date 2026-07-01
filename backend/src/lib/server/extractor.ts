import { spawn, type ChildProcess } from 'child_process';
import path from 'path';

export interface MediaFormat {
	id: string;
	label: string;
	url: string;
	ext: string;
	filesize?: number;
}

const EXTRACTOR_DOMAINS = [
	'youtube.com', 'youtu.be', 'instagram.com', 'tiktok.com',
	'twitter.com', 'x.com', 'vimeo.com', 'facebook.com', 'twitch.tv', 'mediafire.com'
];

const FORMAT_CACHE_TTL_MS = 10 * 60 * 1000;
const FAIL_CACHE_TTL_MS = 90 * 1000;
const formatCache = new Map<string, { formats: MediaFormat[]; ts: number }>();
const failCache = new Map<string, { reason: string; ts: number }>();
const inflight = new Map<string, Promise<MediaFormat[]>>();

/** Browsers to try for cookie auth (Linux/Kali often uses chromium). */
const COOKIE_BROWSERS = ['chromium', 'chrome', 'brave', 'firefox'] as const;

function normalizePageUrl(url: string): string {
	try {
		const u = new URL(url);
		u.hash = '';
		if (/instagram\.com/i.test(u.hostname)) {
			u.search = '';
			u.pathname = u.pathname.replace(/\/+$/, '');
		}
		return u.href;
	} catch {
		return url;
	}
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
	const hit = failCache.get(normalizePageUrl(url));
	if (hit && Date.now() - hit.ts < FAIL_CACHE_TTL_MS) return hit.reason;
	return undefined;
}

export function isExtractorDomain(url: string): boolean {
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		return EXTRACTOR_DOMAINS.some((d) => hostname.includes(d));
	} catch {
		return false;
	}
}

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
export async function listFormats(url: string): Promise<MediaFormat[]> {
	const key = normalizePageUrl(url);
	const cached = getCached(key);
	if (cached) return cached;

	const recentFail = failCache.get(key);
	if (recentFail && Date.now() - recentFail.ts < FAIL_CACHE_TTL_MS) return [];

	if (inflight.has(key)) {
		return inflight.get(key)!;
	}

	const work = listFormatsUncached(key, url).finally(() => inflight.delete(key));
	inflight.set(key, work);
	return work;
}

async function listFormatsUncached(cacheKey: string, url: string): Promise<MediaFormat[]> {
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
		const formats = [{ id: 'direct', label: `Direct — ${name}`, url: direct, ext: path.extname(name) || '.bin' }];
		setCached(cacheKey, formats);
		return formats;
	}

	if (isDirectFileUrl(url)) {
		const name = path.basename(new URL(url).pathname) || 'download';
		const formats = [{ id: 'direct', label: `Direct — ${name}`, url, ext: path.extname(name) || '.bin' }];
		setCached(cacheKey, formats);
		return formats;
	}

	if (!isExtractorDomain(url)) {
		try {
			const u = new URL(url);
			const name = path.basename(u.pathname) || 'download';
			const ext = path.extname(name) || '.bin';
			const formats = [{ id: 'direct', label: `Direct — ${name}`, url, ext }];
			setCached(cacheKey, formats);
			return formats;
		} catch {
			return [];
		}
	}

	const formats = await raceFormatStrategies(url);
	if (formats.length > 0) {
		setCached(cacheKey, formats);
	} else {
		const reason = /instagram\.com/i.test(url)
			? 'Instagram returned no formats. Stay logged in to Instagram in Chrome/Chromium, reload the page, and retry. Image-only posts have no video formats.'
			: 'No downloadable formats found for this URL.';
		failCache.set(cacheKey, { reason, ts: Date.now() });
	}
	return formats;
}

async function raceFormatStrategies(url: string): Promise<MediaFormat[]> {
	const isInstagram = /instagram\.com/i.test(url);

	if (isInstagram) {
		let attempts = 0;
		for (const pageUrl of instagramUrlVariants(url)) {
			for (const browser of COOKIE_BROWSERS) {
				if (attempts >= 3) return [];
				attempts++;
				const run = runYtDlpJson(pageUrl, ['--cookies-from-browser', browser], 26_000, {
					allowPlaylist: true,
					label: `instagram/${browser}`
				});
				const formats = await run.promise;
				run.kill();
				if (formats.length > 0) return formats;
			}
		}
		return [];
	}

	const runners = [
		runYtDlpJson(url, [], 10_000, { label: 'no-cookies' }),
		runYtDlpJson(url, ['--cookies-from-browser', 'chromium'], 22_000, { label: 'chromium' }),
		runYtDlpJson(url, ['--cookies-from-browser', 'chrome'], 22_000, { label: 'chrome' })
	];

	return new Promise((resolve) => {
		let finished = 0;
		let resolved = false;

		const finishAll = (formats: MediaFormat[]) => {
			if (!resolved) {
				resolved = true;
				for (const r of runners) r.kill();
				resolve(formats);
			}
		};

		for (const r of runners) {
			r.promise.then((formats) => {
				if (!resolved && formats.length > 0) {
					finishAll(formats);
					return;
				}
				finished++;
				if (finished === runners.length && !resolved) finishAll([]);
			});
		}
	});
}

type YtDlpRunOpts = { allowPlaylist?: boolean; label?: string };

function runYtDlpJson(
	url: string,
	cookieArgs: string[],
	timeoutMs: number,
	opts: YtDlpRunOpts = {}
): { promise: Promise<MediaFormat[]>; kill: () => void } {
	let proc: ChildProcess | null = null;

	const kill = () => {
		try {
			proc?.kill('SIGTERM');
		} catch { /* ignore */ }
	};

	const promise = new Promise<MediaFormat[]>((resolve) => {
		const ytdlpPath = path.resolve(process.cwd(), 'bin', 'yt-dlp');
		const args = [
			...cookieArgs,
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
		let lastErr = '';
		let settled = false;
		const done = (result: MediaFormat[]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (!result.length && lastErr && opts.label) {
				console.error(`[yt-dlp formats/${opts.label}]: ${lastErr}`);
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

		proc.on('close', (code) => {
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

	return { promise, kill };
}

function parseYtDlpFormats(output: string): MediaFormat[] {
	const info = JSON.parse(output);

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
		if (f.ext === 'mhtml' || f.format_note === 'storyboard') continue;
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
			filesize: size
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
			console.log(`[Extractor] Mediafire CDN expired — refreshing via ${filePage}`);
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
        [],
        ['--cookies-from-browser', 'chromium'],
        ['--cookies-from-browser', 'chrome'],
        ['--cookies-from-browser', 'firefox'],
    ];

    for (const cookieArgs of cookieStrategies) {
        const label = cookieArgs.length ? cookieArgs[1] : 'no-cookies';
        const directUrl = await runYtDlp(url, cookieArgs);
        if (directUrl) {
            console.log(`[Extractor] Resolved via yt-dlp (${label})`);
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
