import { describe, it, expect } from 'vitest';
import { isDirectFileUrl, isExtractorDomain, normalizeFormatUrl, finalizeFormatsForPicker, type MediaFormat } from '../src/lib/server/extractor';

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
		expect(out.some((f) => f.id === '137')).toBe(false);
		expect(out.some((f) => f.id === '18')).toBe(true);
		expect(out.some((f) => f.id === '140')).toBe(false);
	});
});
