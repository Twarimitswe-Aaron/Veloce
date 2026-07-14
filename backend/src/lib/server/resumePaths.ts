/**
 * Hidden resume sidecars: `{parent}/.veloce/{filename}.state|.done`
 * Legacy adjacent `{file}.veloce_state|.veloce_done` are migrated on touch.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, unlinkSync, writeFileSync, statSync } from 'fs';
import path from 'path';

export function sidecarPaths(savePath: string): { state: string; done: string; dir: string } {
	const parent = path.dirname(savePath);
	const name = path.basename(savePath);
	const dir = path.join(parent, '.veloce');
	return {
		dir,
		state: path.join(dir, `${name}.state`),
		done: path.join(dir, `${name}.done`)
	};
}

export function migrateLegacySidecars(savePath: string): void {
	const { state, done, dir } = sidecarPaths(savePath);
	const legacyState = `${savePath}.veloce_state`;
	const legacyDone = `${savePath}.veloce_done`;
	try {
		if (existsSync(legacyState) && !existsSync(state)) {
			mkdirSync(dir, { recursive: true });
			try {
				renameSync(legacyState, state);
			} catch {
				writeFileSync(state, readFileSync(legacyState));
				unlinkSync(legacyState);
			}
		}
		if (existsSync(legacyDone) && !existsSync(done)) {
			mkdirSync(dir, { recursive: true });
			try {
				renameSync(legacyDone, done);
			} catch {
				writeFileSync(done, readFileSync(legacyDone));
				unlinkSync(legacyDone);
			}
		}
	} catch {
		/* best-effort */
	}
}

export function hasResumeState(savePath: string): boolean {
	migrateLegacySidecars(savePath);
	const { state } = sidecarPaths(savePath);
	return existsSync(state) || existsSync(`${savePath}.veloce_state`);
}

export function isMarkedComplete(savePath: string): boolean {
	migrateLegacySidecars(savePath);
	const { done } = sidecarPaths(savePath);
	return existsSync(done) || existsSync(`${savePath}.veloce_done`);
}

export function pathIsOccupied(savePath: string): boolean {
	return (
		existsSync(savePath) ||
		hasResumeState(savePath) ||
		isMarkedComplete(savePath)
	);
}

export function removeResumeSidecars(savePath: string): void {
	const { state, done } = sidecarPaths(savePath);
	for (const p of [state, done, `${savePath}.veloce_state`, `${savePath}.veloce_done`]) {
		try {
			if (existsSync(p)) unlinkSync(p);
		} catch {
			/* ignore */
		}
	}
}

/** Prefer incomplete file with resume state over creating `(1)/(2)`. */
export function reuseOrUniqueSavePath(desired: string): string {
	migrateLegacySidecars(desired);
	if (hasResumeState(desired)) return desired;
	if (existsSync(desired) && isMarkedComplete(desired)) return desired;
	if (!pathIsOccupied(desired)) return desired;

	const dir = path.dirname(desired);
	const ext = path.extname(desired);
	const stem = path.basename(desired, ext);
	let best: { size: number; path: string } | null = null;
	const candidates = [path.join(dir, `${stem}${ext}`)];
	for (let i = 1; i < 50; i++) candidates.push(path.join(dir, `${stem} (${i})${ext}`));
	for (const cand of candidates) {
		migrateLegacySidecars(cand);
		if (!hasResumeState(cand) || isMarkedComplete(cand)) continue;
		let size = 0;
		try {
			size = existsSync(cand) ? statSync(cand).size : 0;
		} catch {
			size = 0;
		}
		if (!best || size > best.size) best = { size, path: cand };
	}
	if (best) return best.path;

	let candidate = desired;
	for (let i = 1; ; i++) {
		if (!pathIsOccupied(candidate)) return candidate;
		candidate = path.join(dir, `${stem} (${i})${ext}`);
	}
}

/** Migrate every legacy sidecar in a directory into `.veloce/`. */
export function sweepLegacySidecars(dir: string): void {
	if (!existsSync(dir)) return;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name.endsWith('.veloce_state')) {
			migrateLegacySidecars(path.join(dir, name.slice(0, -'.veloce_state'.length)));
		} else if (name.endsWith('.veloce_done')) {
			migrateLegacySidecars(path.join(dir, name.slice(0, -'.veloce_done'.length)));
		}
	}
}
