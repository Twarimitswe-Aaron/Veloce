import { describe, it, expect } from 'vitest';
import { isDirectFileUrl, isExtractorDomain, normalizeFormatUrl, finalizeFormatsForPicker, isInstagramSilentDashUrl, type MediaFormat } from '../src/lib/server/extractor';

describe('isDirectFileUrl', () => {
	it('detects direct media/file links by extension', () => {
		expect(isDirectFileUrl('https://cdn.example.com/video.mp4')).toBe(true);
		expect(isDirectFileUrl('https://x.com/a/b/song.mp3?token=1')).toBe(true);
		expect(isDirectFileUrl('https://host/file.zip#frag')).toBe(true);
		expect(isDirectFileUrl('https://host/image.jpeg')).toBe(true);
		expect(isDirectFileUrl('https://raw.githubusercontent.com/o/r/main/bible.xml')).toBe(true);
	});

	it('treats MediaFire CDN hosts as direct', () => {
		expect(isDirectFileUrl('https://download2393.mediafire.com/abc/key/movie.mp4')).toBe(true);
	});

	it('rejects landing pages and non-http', () => {
		expect(isDirectFileUrl('https://example.com/watch?v=abc')).toBe(false);
		expect(isDirectFileUrl('https://www.mediafire.com/file/key/name')).toBe(false);
		expect(isDirectFileUrl('https://github.com/o/r/blob/main/file.xml')).toBe(false);
		expect(isDirectFileUrl('ftp://host/file.mp4')).toBe(false);
		expect(isDirectFileUrl('not a url')).toBe(false);
	});
});

describe('normalizeFormatUrl', () => {
	it('canonicalizes YouTube watch URLs', () => {
		expect(normalizeFormatUrl('https://www.youtube.com/watch?v=abc123&list=PLx')).toBe(
			'https://www.youtube.com/watch?v=abc123'
		);
		expect(normalizeFormatUrl('https://youtu.be/abc123')).toBe(
			'https://www.youtube.com/watch?v=abc123'
		);
	});

	it('canonicalizes Instagram post URLs', () => {
		expect(normalizeFormatUrl('https://www.instagram.com/reel/AbCd/?igsh=1')).toBe(
			'https://www.instagram.com/reel/AbCd'
		);
		expect(normalizeFormatUrl('https://www.instagram.com/reels/AbCd/?igsh=1')).toBe(
			'https://www.instagram.com/reel/AbCd'
		);
	});

	it('canonicalizes Instagram story URLs', () => {
		expect(normalizeFormatUrl('https://www.instagram.com/stories/li_estas_leul/345678901234/?utm=x')).toBe(
			'https://www.instagram.com/stories/li_estas_leul/345678901234'
		);
		expect(normalizeFormatUrl('https://www.instagram.com/stories/user/')).toBe(
			'https://www.instagram.com/stories/user'
		);
	});
});

describe('isExtractorDomain', () => {
	it('recognizes video/social domains', () => {
		expect(isExtractorDomain('https://www.youtube.com/watch?v=x')).toBe(true);
		expect(isExtractorDomain('https://youtu.be/x')).toBe(true);
		expect(isExtractorDomain('https://www.instagram.com/reel/x')).toBe(true);
		expect(isExtractorDomain('https://www.mediafire.com/file/x/y')).toBe(true);
	});

	it('returns false for generic hosts', () => {
		expect(isExtractorDomain('https://example.com/a.mp4')).toBe(false);
		expect(isExtractorDomain('bad url')).toBe(false);
	});
});

describe('finalizeFormatsForPicker', () => {
	it('hides YouTube video-only streams and adds a best row', () => {
		const raw: MediaFormat[] = [
			{ id: '137', label: 'Song — 1920x1080 webm · 200 MB', url: 'https://v.example/v', ext: '.webm', av: 'video' },
			{ id: '18', label: 'Song — 640x360 mp4 · 11 MB', url: 'https://v.example/p', ext: '.mp4', av: 'both' },
			{ id: '140', label: 'Song — audio only m4a', url: 'https://v.example/a', ext: '.m4a', av: 'audio' }
		];
		const out = finalizeFormatsForPicker(raw, 'youtube');
		expect(out[0]?.id).toBe('best');
		// Best is seeded from the top progressive URL so download can skip a second yt-dlp.
		expect(out[0]?.url).toBe('https://v.example/p');
		expect(out.some((f) => f.id === '137')).toBe(false);
		expect(out.some((f) => f.id === '18')).toBe(true);
		expect(out.some((f) => f.id === '140')).toBe(false);
	});

	it('hides Instagram video-only DASH and prefers video+audio', () => {
		const raw: MediaFormat[] = [
			{
				id: 'dash-v',
				label: 'Clip — 1080x1920 video only mp4 · 8 MB',
				url: 'https://cdn.example/v.mp4',
				ext: '.mp4',
				av: 'video',
				filesize: 8_000_000
			},
			{
				id: 'dash-a',
				label: 'Clip — audio only m4a',
				url: 'https://cdn.example/a.m4a',
				ext: '.m4a',
				av: 'audio'
			},
			{
				id: '0',
				label: 'Clip — video+audio mp4 · 3 MB',
				url: 'https://cdn.example/combined.mp4',
				ext: '.mp4',
				av: 'both',
				filesize: 3_000_000
			}
		];
		const out = finalizeFormatsForPicker(raw, 'instagram');
		expect(out[0]?.id).toBe('best');
		expect(out[0]?.url).toBe('https://cdn.example/combined.mp4');
		expect(out[0]?.source).toBe('instagram');
		expect(out.some((f) => f.id === '0')).toBe(true);
		expect(out.some((f) => f.id === 'dash-v')).toBe(false);
		expect(out.some((f) => f.id === 'dash-a')).toBe(false);
	});

	it('rejects Instagram CDN URLs whose efg marks silent DASH', () => {
		const dashEfg =
			'eyJ2ZW5jb2RlX3RhZyI6ImlnLXhwdmRzLmNsaXBzLmlnd3d3LUMzLmRhc2hfcjJldmV2cDktcjFnZW4ydnA5X3E5MCIsInZpZGVvX2lkIjpudWxsfQ';
		const dashUrl = `https://instagram.fnbo18-1.fna.fbcdn.net/o1/v/t2/f2/m367/x.mp4?efg=${dashEfg}`;
		expect(isInstagramSilentDashUrl(dashUrl)).toBe(true);
		expect(isInstagramSilentDashUrl('https://cdn.example.com/x.mp4')).toBe(false);
		expect(
			isInstagramSilentDashUrl(
				'https://instagram.fnbo18-1.fna.fbcdn.net/o1/v/t2/f2/m367/x.m4a?efg=' + dashEfg
			)
		).toBe(false);

		const out = finalizeFormatsForPicker(
			[
				{
					id: '0',
					label: 'Throwback — video+audio mp4',
					url: dashUrl,
					ext: '.mp4',
					av: 'both'
				},
				{
					id: '18',
					label: 'Throwback — video+audio mp4',
					url: 'https://instagram.fnbo18-1.fna.fbcdn.net/o1/v/t2/f2/m86/combined.mp4',
					ext: '.mp4',
					av: 'both'
				}
			],
			'instagram'
		);
		expect(out[0]?.url).toContain('combined.mp4');
		expect(out.some((f) => f.url === dashUrl)).toBe(false);
	});
});
