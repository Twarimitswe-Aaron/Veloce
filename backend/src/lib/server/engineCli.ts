import { config } from './config';
import { execSync } from 'child_process';
import path from 'path';

export function coreEngineBinaryPath(): string {
	const coreDir = path.resolve(process.cwd(), '../core_engine');
	return path.join(coreDir, 'target', 'release', 'core_engine');
}

export function coreEngineHasQuietFlag(): boolean {
	try {
		const help = execSync(`"${coreEngineBinaryPath()}" --help`, { encoding: 'utf8', timeout: 5000 });
		return help.includes('--quiet');
	} catch {
		return false;
	}
}

export type EngineCliOpts = {
	id: string;
	url: string;
	savePath: string;
	threads: number;
	maxRateBytes: number;
	engineQuiet: boolean;
	hasQuietFlag: boolean;
	referer?: string;
};

/** CLI arguments for core_engine — keeps ws + playlist runner in sync. */
export function buildEngineCliArgs(opts: EngineCliOpts): string[] {
	const args = [
		'--id', opts.id,
		'--url', opts.url,
		'--save-path', opts.savePath,
		'--threads', String(opts.threads),
		'--max-rate', String(opts.maxRateBytes),
		'--read-buffer-bytes', String(config.engineReadBufferBytes),
		'--piece-size-bytes', '0'
	];
	if (!config.engineAutoTune) args.push('--no-auto-tune');
	if (opts.engineQuiet && opts.hasQuietFlag) args.push('--quiet');
	if (opts.referer) {
		args.push('--referer', opts.referer);
		try {
			args.push('--origin', new URL(opts.referer).origin);
		} catch { /* ignore */ }
	}
	return args;
}
