import { describe, it, expect } from 'vitest';
import { isDirectFileUrl, isExtractorDomain } from '../src/lib/server/extractor';

describe('isDirectFileUrl', () => {
	it('detects direct media/file links by extension', () => {
		expect(isDirectFileUrl('https://cdn.example.com/video.mp4')).toBe(true);
		expect(isDirectFileUrl('https://x.com/a/b/song.mp3?token=1')).toBe(true);
		expect(isDirectFileUrl('https://host/file.zip#frag')).toBe(true);
		expect(isDirectFileUrl('https://host/image.jpeg')).toBe(true);
	});

	it('treats MediaFire CDN hosts as direct', () => {
		expect(isDirectFileUrl('https://download2393.mediafire.com/abc/key/movie.mp4')).toBe(true);
	});

	it('rejects landing pages and non-http', () => {
		expect(isDirectFileUrl('https://example.com/watch?v=abc')).toBe(false);
		expect(isDirectFileUrl('https://www.mediafire.com/file/key/name')).toBe(false);
		expect(isDirectFileUrl('ftp://host/file.mp4')).toBe(false);
		expect(isDirectFileUrl('not a url')).toBe(false);
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
