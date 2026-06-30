import { readFileSync } from 'fs';
import path from 'path';

/**
 * Zero-dependency .env loader. Reads `<cwd>/.env` once at startup and merges it
 * into a plain object (real `process.env` always wins so deployments can
 * override). We avoid the `dotenv` package because this repo uses pnpm
 * `workspace:` links that make ad-hoc installs awkward.
 */
function loadDotEnv(): Record<string, string> {
	const merged: Record<string, string> = {};
	try {
		const raw = readFileSync(path.resolve(process.cwd(), '.env'), 'utf8');
		for (const line of raw.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const eq = trimmed.indexOf('=');
			if (eq === -1) continue;
			const key = trimmed.slice(0, eq).trim();
			let val = trimmed.slice(eq + 1).trim();
			// Strip optional surrounding quotes.
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			merged[key] = val;
		}
	} catch {
		// No .env file — defaults apply.
	}
	// Real environment overrides file values.
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) merged[k] = v;
	}
	return merged;
}

const env = loadDotEnv();

function num(key: string, def: number): number {
	const v = env[key];
	if (v === undefined || v.trim() === '') return def;
	const n = Number(v);
	return Number.isFinite(n) ? n : def;
}

function bool(key: string, def: boolean): boolean {
	const v = env[key];
	if (v === undefined) return def;
	return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function list(key: string): string[] {
	const v = env[key];
	if (!v) return [];
	return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
	/** Port the Local Coordinator (WebSocket + dev server) listens on. */
	port: num('VELOCE_PORT', 14921),
	/** Max engine processes running at once. */
	maxConcurrentDownloads: num('VELOCE_MAX_CONCURRENT_DOWNLOADS', 10),
	/** Default per-download connection count when the client doesn't specify. */
	defaultThreads: num('VELOCE_DEFAULT_THREADS', 8),
	/** Global per-download speed cap in bytes/sec (0 = unlimited), passed to the engine. */
	maxRateBytes: num('VELOCE_MAX_RATE_BYTES', 0),
	/** Minimum free disk space (MB) required before starting a download. */
	minFreeDiskMb: num('VELOCE_MIN_FREE_DISK_MB', 500),
	/** Optional override for the default base download directory. */
	baseDir: env['VELOCE_BASE_DIR'] || '',
	/**
	 * Allowlisted browser-extension IDs. When non-empty, only
	 * `chrome-extension://<id>` / `moz-extension://<id>` origins in this list may
	 * connect. When empty, any extension origin is accepted (websites are always
	 * rejected regardless).
	 */
	allowedExtensionIds: list('VELOCE_ALLOWED_EXTENSION_IDS'),
	/** Block downloads whose host is localhost/loopback/private/link-local (SSRF guard). */
	blockPrivateHosts: bool('VELOCE_BLOCK_PRIVATE_HOSTS', true)
};
