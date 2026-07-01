import path from 'path';
import { config } from './config';

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
	if (!base || base === '.' || base === '..') base = `download_${Date.now()}`;
	return base.slice(0, 200);
}

/**
 * Join into a path that is guaranteed to stay within `baseDir`. Returns null if
 * the result would escape the base (defense-in-depth against traversal).
 */
export function safeJoin(baseDir: string, category: string, fileName: string): string | null {
	const root = path.resolve(baseDir);
	const target = path.resolve(root, category, sanitizeFileName(fileName));
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
