import { describe, expect, it } from 'vitest';
import { buildEngineCliArgs, engineAutoTuneEnabled } from '../src/lib/server/engineCli';

const allCaps = {
	quiet: true,
	referer: true,
	origin: true,
	readBufferBytes: true,
	pieceSizeBytes: true,
	noAutoTune: true,
	baseDir: false
};

const legacyCaps = {
	quiet: true,
	referer: true,
	origin: true,
	readBufferBytes: false,
	pieceSizeBytes: false,
	noAutoTune: false,
	baseDir: false
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
			caps: allCaps,
			autoTune: true
		});
		expect(args).toContain('--read-buffer-bytes');
		expect(args).toContain('--piece-size-bytes');
		expect(args).toContain('--quiet');
		expect(args).not.toContain('--no-auto-tune');
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

	it('passes --no-auto-tune for MediaFire CDN URLs', () => {
		const args = buildEngineCliArgs({
			id: 'x',
			url: 'https://download2393.mediafire.com/token/Let,S+Fight.mp4',
			savePath: '/tmp/f.mp4',
			threads: 2,
			maxRateBytes: 0,
			engineQuiet: false,
			caps: allCaps
		});
		expect(args).toContain('--no-auto-tune');
		expect(args).not.toContain('--quiet');
	});

	it('strips googlevideo range= from --url', () => {
		const raw =
			'https://rr1---sn-abc.googlevideo.com/videoplayback?id=1&range=0-9999999&clen=500000000';
		const args = buildEngineCliArgs({
			id: 'x',
			url: raw,
			savePath: '/tmp/f.mp4',
			threads: 8,
			maxRateBytes: 0,
			engineQuiet: false,
			caps: allCaps,
			autoTune: true
		});
		const urlIdx = args.indexOf('--url');
		expect(urlIdx).toBeGreaterThanOrEqual(0);
		expect(args[urlIdx + 1]).not.toContain('range=');
		expect(args[urlIdx + 1]).toContain('clen=500000000');
	});

	it('passes --no-auto-tune when pageUrl is MediaFire', () => {
		const args = buildEngineCliArgs({
			id: 'x',
			url: 'https://cdn.example.com/opaque',
			pageUrl: 'https://www.mediafire.com/file/abc/video.mp4/file',
			savePath: '/tmp/f.mp4',
			threads: 2,
			maxRateBytes: 0,
			engineQuiet: true,
			caps: allCaps
		});
		expect(args).toContain('--no-auto-tune');
	});

	it('honors explicit autoTune: false', () => {
		const args = buildEngineCliArgs({
			id: 'x',
			url: 'https://example.com/stream',
			savePath: '/tmp/f.bin',
			threads: 4,
			maxRateBytes: 1000,
			engineQuiet: false,
			caps: allCaps,
			autoTune: false
		});
		expect(args).toContain('--no-auto-tune');
	});
});

describe('engineAutoTuneEnabled', () => {
	it('skips MediaFire, direct files, and GitHub', () => {
		expect(
			engineAutoTuneEnabled('https://download1.mediafire.com/x/y.mp4')
		).toBe(false);
		expect(engineAutoTuneEnabled('https://cdn.example.com/clip.mp4')).toBe(false);
		expect(
			engineAutoTuneEnabled('https://raw.githubusercontent.com/a/b/main/f.bin')
		).toBe(false);
	});

	it('allows generic non-file hosts', () => {
		expect(engineAutoTuneEnabled('https://cdn.example.com/stream')).toBe(true);
	});
});
