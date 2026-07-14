import { config } from './config';
import { execSync } from 'child_process';
import path from 'path';

export function coreEngineBinaryPath(): string {
	const coreDir = path.resolve(process.cwd(), '../core_engine');
	return path.join(coreDir, 'target', 'release', 'core_engine');
}

export type EngineCapabilities = {
	quiet: boolean;
	referer: boolean;
	origin: boolean;
	readBufferBytes: boolean;
	pieceSizeBytes: boolean;
	noAutoTune: boolean;
	baseDir: boolean;
};

let capsCache: EngineCapabilities | null = null;
let helpCache: string | null = null;

function coreEngineHelp(): string {
	if (helpCache != null) return helpCache;
	try {
		helpCache = execSync(`"${coreEngineBinaryPath()}" --help`, { encoding: 'utf8', timeout: 5000 });
	} catch {
		helpCache = '';
	}
	return helpCache;
}

/** Parse `core_engine --help` once — only pass flags the installed binary understands. */
export function getCoreEngineCapabilities(): EngineCapabilities {
	if (capsCache) return capsCache;
	const help = coreEngineHelp();
	capsCache = {
		quiet: help.includes('--quiet'),
		referer: help.includes('--referer'),
		origin: help.includes('--origin'),
		readBufferBytes: help.includes('--read-buffer-bytes'),
		pieceSizeBytes: help.includes('--piece-size-bytes'),
		noAutoTune: help.includes('--no-auto-tune'),
		baseDir: help.includes('--base-dir')
	};
	return capsCache;
}

/** @deprecated Use getCoreEngineCapabilities().quiet */
export function coreEngineHasQuietFlag(): boolean {
	return getCoreEngineCapabilities().quiet;
}

export type EngineCliOpts = {
	id: string;
	url: string;
	savePath: string;
	threads: number;
	maxRateBytes: number;
	engineQuiet: boolean;
	referer?: string;
	caps?: EngineCapabilities;
};

/** CLI arguments for core_engine — keeps ws + playlist runner in sync. */
export function buildEngineCliArgs(opts: EngineCliOpts): string[] {
	const caps = opts.caps ?? getCoreEngineCapabilities();
	const threads = Math.min(64, Math.max(1, opts.threads || 8));
	const args = [
		'--id', opts.id,
		'--url', opts.url,
		'--save-path', opts.savePath,
		'--threads', String(threads),
		'--max-rate', String(opts.maxRateBytes)
	];
	if (caps.readBufferBytes) {
		args.push('--read-buffer-bytes', String(config.engineReadBufferBytes));
	}
	if (caps.pieceSizeBytes) args.push('--piece-size-bytes', '0');
	if (caps.noAutoTune && !config.engineAutoTune) args.push('--no-auto-tune');
	if (opts.engineQuiet && caps.quiet) args.push('--quiet');
	if (opts.referer) {
		if (caps.referer) args.push('--referer', opts.referer);
		if (caps.origin) {
			try {
				args.push('--origin', new URL(opts.referer).origin);
			} catch { /* ignore */ }
		}
	}
	// Confine writes under the download root when the engine supports --base-dir.
	if (caps.baseDir) {
		try {
			const base = path.dirname(opts.savePath);
			if (base && base !== '.' && base !== opts.savePath) {
				args.push('--base-dir', base);
			}
		} catch { /* ignore */ }
	}
	return args;
}

/** Reset cached --help parse (for tests). */
export function resetCoreEngineCapabilitiesCache(): void {
	capsCache = null;
	helpCache = null;
}
