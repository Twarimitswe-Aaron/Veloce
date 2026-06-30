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
const formatCache = new Map<string, { formats: MediaFormat[]; ts: number }>();
const inflight = new Map<string, Promise<MediaFormat[]>>();

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
	const cached = getCached(url);
	if (cached) {
		console.log('[Veloce] listFormats cache hit:', url);
		return cached;
	}

	if (inflight.has(url)) {
		console.log('[Veloce] listFormats joining in-flight:', url);
		return inflight.get(url)!;
	}

	const work = listFormatsUncached(url).finally(() => inflight.delete(url));
	inflight.set(url, work);
	return work;
}

async function listFormatsUncached(url: string): Promise<MediaFormat[]> {
	const t0 = Date.now();

	if (url.includes('mediafire.com')) {
		const direct = await extractMediaUrl(url);
		if (!direct) return [];
		const name = path.basename(new URL(direct).pathname) || 'download';
		const formats = [{ id: 'direct', label: `Direct — ${name}`, url: direct, ext: path.extname(name) || '.bin' }];
		setCached(url, formats);
		return formats;
	}

	if (!isExtractorDomain(url)) {
		try {
			const u = new URL(url);
			const name = path.basename(u.pathname) || 'download';
			const ext = path.extname(name) || '.bin';
			const formats = [{ id: 'direct', label: `Direct — ${name}`, url, ext }];
			setCached(url, formats);
			return formats;
		} catch {
			return [];
		}
	}

	// Race strategies: no-cookies is fast for public posts; chrome cookies help private/login walls.
	const formats = await raceFormatStrategies(url);
	console.log(`[Veloce] listFormats done in ${Date.now() - t0}ms (${formats.length} formats)`);
	setCached(url, formats);
	return formats;
}

async function raceFormatStrategies(url: string): Promise<MediaFormat[]> {
	const runners = [
		runYtDlpJson(url, [], 10_000),
		runYtDlpJson(url, ['--cookies-from-browser', 'chrome'], 22_000)
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

function runYtDlpJson(url: string, cookieArgs: string[], timeoutMs: number): { promise: Promise<MediaFormat[]>; kill: () => void } {
	let proc: ChildProcess | null = null;

	const kill = () => {
		try {
			proc?.kill('SIGTERM');
		} catch { /* ignore */ }
	};

	const promise = new Promise<MediaFormat[]>((resolve) => {
		const ytdlpPath = path.resolve(process.cwd(), 'bin', 'yt-dlp');
		proc = spawn(ytdlpPath, [
			...cookieArgs,
			'--no-playlist',
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
		const done = (result: MediaFormat[]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(result);
		};

		const timeout = setTimeout(() => {
			kill();
			done([]);
		}, timeoutMs);

		proc.stdout?.on('data', (data) => { output += data.toString(); });
		proc.stderr?.on('data', (data) => {
			console.error(`[yt-dlp formats]: ${data.toString().trim()}`);
		});

		proc.on('close', (code) => {
			if (code !== 0 || !output.trim()) {
				done([]);
				return;
			}
			try {
				done(parseYtDlpFormats(output));
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
	const title = (info.title as string) || 'video';
	const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
	const raw = (info.formats as any[]) ?? [];
	const out: MediaFormat[] = [];

	for (const f of raw) {
		if (!f.url) continue;
		if (f.ext === 'mhtml' || f.format_note === 'storyboard') continue;
		const hasVideo = f.vcodec && f.vcodec !== 'none';
		const hasAudio = f.acodec && f.acodec !== 'none';
		if (!hasVideo && !hasAudio) continue;

		const res = f.resolution && f.resolution !== 'audio only' ? f.resolution : '';
		const kind = hasVideo && hasAudio ? 'video+audio' : hasVideo ? 'video' : 'audio';
		const size = f.filesize || f.filesize_approx;
		const sizeStr = size ? ` · ${formatBytes(size)}` : '';
		const ext = f.ext || 'mp4';
		const label = [res || kind, ext, sizeStr].filter(Boolean).join(' ');

		out.push({
			id: String(f.format_id),
			label: label.trim(),
			url: f.url,
			ext: ext.startsWith('.') ? ext : `.${ext}`,
			filesize: size
		});
	}

	out.sort((a, b) => (b.filesize ?? 0) - (a.filesize ?? 0));

	const seen = new Set<string>();
	const unique = out.filter((f) => {
		const key = `${f.label}|${f.ext}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	for (const f of unique) {
		f.label = `${safeTitle} — ${f.label}`;
	}

	return unique.slice(0, 40);
}

/**
 * Extracts the direct media URL from a social media link (Instagram, YouTube, etc) using yt-dlp.
 * @param url The raw social media URL
 * @returns The absolute direct media URL, or null if it fails
 */
export async function extractMediaUrl(url: string): Promise<string | null> {
    // 1. Custom Mediafire Extractor
    if (url.includes('mediafire.com')) {
        console.log(`[Extractor] Using custom Mediafire parser for ${url}`);
        try {
            const res = await fetch(url);
            const html = await res.text();
            // Find the direct download button link (e.g. https://download2355.mediafire.com/...)
            const match = html.match(/href="([^"]*download[^"]*mediafire\.com[^"]*)"/i);
            if (match && match[1]) {
                return match[1];
            }
        } catch (e) {
            console.error('[Extractor] Failed to parse Mediafire link', e);
        }
        return null;
    }

    // 2. yt-dlp Extractor for everything else (YouTube, Instagram, TikTok, ...).
    const cookieStrategies: string[][] = [
        [],
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
