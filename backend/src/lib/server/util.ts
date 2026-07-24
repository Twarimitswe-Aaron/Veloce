import path from 'path';
import { existsSync } from 'fs';
import { config } from './config';
import { isMarkedComplete } from './resumePaths';

/**
 * Validate a user-supplied download URL: only http(s), and (optionally) block
 * hosts that point back at the local machine / private networks / cloud
 * metadata endpoints. This is an SSRF guard — important because the engine
 * fetches whatever URL it is given.
 */
export function isSafeDownloadUrl(raw: string): { ok: true } | { ok: false; reason: string } {
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
export function sanitizeFileName(name: string): string {
	let base = path.basename(name || '').replace(/[\\/\x00-\x1f]/g, '_').trim();
	base = decodeRemoteFileName(base);
	base = base.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
	if (!base || base === '.' || base === '..') base = `download_${Date.now()}`;
	return base.slice(0, 200);
}

/**
 * Decode CDN / MediaFire path names: `Let%2CS+Fight.mp4` → `Let,S Fight.mp4`.
 */
export function decodeRemoteFileName(raw: string): string {
	let s = (raw || '').trim();
	if (!s) return '';
	try {
		s = decodeURIComponent(s.replace(/\+/g, '%20'));
	} catch {
		s = s.replace(/\+/g, ' ');
	}
	return s.replace(/\s+/g, ' ').trim();
}

/** Playlist folder names — allow spaces; strip illegal path chars. */
export function sanitizeFolderName(name: string): string {
	const cleaned = (name || 'playlist')
		.replace(/[\\/\x00-\x1f:*?"<>|]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 120);
	return cleaned || 'playlist';
}

/**
 * Join into a path that is guaranteed to stay within `baseDir`. Returns null if
 * the result would escape the base (defense-in-depth against traversal).
 */
export function safeJoin(baseDir: string, category: string, fileName: string, subfolder?: string): string | null {
	const root = path.resolve(baseDir);
	const parts = [root, category];
	if (subfolder) parts.push(sanitizeFolderName(subfolder));
	parts.push(sanitizeFileName(fileName));
	const target = path.resolve(...parts);
	const rel = path.relative(root, target);
	if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
	return target;
}

/** Map a filename extension to a download category folder. */
export function categoryForExt(ext: string): string {
	const e = ext.toLowerCase();
	if (['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'].includes(e)) return 'videos';
	if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(e)) return 'images';
	if (['.mp3', '.wav', '.flac', '.ogg', '.m4a'].includes(e)) return 'audio';
	if (['.pdf', '.doc', '.docx', '.txt'].includes(e)) return 'documents';
	if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'].includes(e)) return 'archives';
	return 'others';
}

/** True when a download finished and the bytes (or done sidecar) are still on disk. */
export function completedFileStillExists(savePath: string): boolean {
	return isMarkedComplete(savePath) || existsSync(savePath);
}

/**
 * Strip CDN `range=` query params that pin a URL to a byte slice.
 * YouTube googlevideo URLs from yt-dlp often include `range=0-N`; discovering
 * against that URL makes Content-Length = N+1 and the engine "completes" early.
 */
export function sanitizeDownloadMediaUrl(url: string): string {
	try {
		const u = new URL(url);
		if (!u.searchParams.has('range')) return url;
		const pairs: Array<[string, string]> = [];
		u.searchParams.forEach((v, k) => {
			if (k.toLowerCase() !== 'range') pairs.push([k, v]);
		});
		// Rebuild query preserving remaining param order (URLSearchParams iteration order).
		const next = new URL(u.toString());
		next.search = '';
		for (const [k, v] of pairs) next.searchParams.append(k, v);
		return next.toString();
	} catch {
		return url;
	}
}
