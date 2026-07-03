import { describe, expect, it } from 'vitest';
import { buildEngineCliArgs } from '../src/lib/server/engineCli';

describe('buildEngineCliArgs', () => {
	it('includes performance flags', () => {
		const args = buildEngineCliArgs({
			id: 'x',
			url: 'https://example.com/f',
			savePath: '/tmp/f.bin',
			threads: 8,
			maxRateBytes: 0,
			engineQuiet: true,
			hasQuietFlag: true
		});
		expect(args).toContain('--read-buffer-bytes');
		expect(args).toContain('--piece-size-bytes');
		expect(args).toContain('--quiet');
	});

	it('can disable auto-tune via env-backed config', () => {
		const args = buildEngineCliArgs({
			id: 'x',
			url: 'https://example.com/f',
			savePath: '/tmp/f.bin',
			threads: 4,
			maxRateBytes: 1000,
			engineQuiet: false,
			hasQuietFlag: false
		});
		expect(args).not.toContain('--quiet');
	});
});
