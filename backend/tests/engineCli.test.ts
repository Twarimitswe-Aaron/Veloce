import { describe, expect, it } from 'vitest';
import { buildEngineCliArgs } from '../src/lib/server/engineCli';

const allCaps = {
	quiet: true,
	referer: true,
	origin: true,
	readBufferBytes: true,
	pieceSizeBytes: true,
	noAutoTune: true
};

const legacyCaps = {
	quiet: true,
	referer: true,
	origin: true,
	readBufferBytes: false,
	pieceSizeBytes: false,
	noAutoTune: false
};

describe('buildEngineCliArgs', () => {
	it('includes performance flags when the binary supports them', () => {
		const args = buildEngineCliArgs({
			id: 'x',
			url: 'https://example.com/f',
			savePath: '/tmp/f.bin',
			threads: 8,
			maxRateBytes: 0,
			engineQuiet: true,
			caps: allCaps
		});
		expect(args).toContain('--read-buffer-bytes');
		expect(args).toContain('--piece-size-bytes');
		expect(args).toContain('--quiet');
	});

	it('omits flags the installed binary does not understand', () => {
		const args = buildEngineCliArgs({
			id: 'x',
			url: 'https://example.com/f',
			savePath: '/tmp/f.bin',
			threads: 8,
			maxRateBytes: 0,
			engineQuiet: true,
			caps: legacyCaps
		});
		expect(args).not.toContain('--read-buffer-bytes');
		expect(args).not.toContain('--piece-size-bytes');
		expect(args).toContain('--quiet');
	});

	it('can disable auto-tune when supported', () => {
		const args = buildEngineCliArgs({
			id: 'x',
			url: 'https://example.com/f',
			savePath: '/tmp/f.bin',
			threads: 4,
			maxRateBytes: 1000,
			engineQuiet: false,
			caps: allCaps
		});
		expect(args).not.toContain('--quiet');
	});
});
