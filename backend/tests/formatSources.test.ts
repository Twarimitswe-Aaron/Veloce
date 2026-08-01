import { describe, it, expect } from 'vitest';
import {
	detectMediaSource,
	failReasonForSource,
	isInstagramMediaPageUrl,
	isManifestFormatUrl
} from '../src/lib/server/formatSources';

describe('detectMediaSource', () => {
	it('detects known platforms', () => {
		expect(detectMediaSource('https://www.youtube.com/watch?v=x')).toBe('youtube');
		expect(detectMediaSource('https://www.instagram.com/reel/AbCd/')).toBe('instagram');
		expect(detectMediaSource('https://www.tiktok.com/@u/video/1')).toBe('tiktok');
	});

	it('falls back to generic', () => {
		expect(detectMediaSource('https://cdn.example.com/v.mp4')).toBe('generic');
	});
});

describe('failReasonForSource', () => {
	it('returns Instagram-specific guidance for Instagram URLs', () => {
		const msg = failReasonForSource('instagram', 'Instagram sent an empty media response');
		expect(msg.toLowerCase()).toContain('instagram');
		expect(msg.toLowerCase()).not.toContain('youtube');
	});

	it('returns YouTube-specific guidance for YouTube errors', () => {
		const msg = failReasonForSource('youtube', 'This video is not available');
		expect(msg.toLowerCase()).toContain('youtube');
		expect(msg.toLowerCase()).not.toContain('instagram');
	});
});

describe('isManifestFormatUrl', () => {
	it('detects HLS and DASH manifests', () => {
		expect(isManifestFormatUrl('https://cdn.example.com/stream.m3u8?sig=1')).toBe(true);
		expect(isManifestFormatUrl('https://cdn.example.com/manifest.mpd')).toBe(true);
		expect(
			isManifestFormatUrl(
				'https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1/id/x'
			)
		).toBe(true);
		expect(isManifestFormatUrl('https://googlevideo.com/videoplayback?id=1&itag=22')).toBe(false);
	});
});

describe('isInstagramMediaPageUrl', () => {
	it('accepts post/reel/story paths and rejects homepage', () => {
		expect(isInstagramMediaPageUrl('https://www.instagram.com/reel/AbCd/')).toBe(true);
		expect(isInstagramMediaPageUrl('https://www.instagram.com/p/AbCd/')).toBe(true);
		expect(isInstagramMediaPageUrl('https://www.instagram.com/stories/user/123')).toBe(true);
		expect(isInstagramMediaPageUrl('https://www.instagram.com/')).toBe(false);
		expect(isInstagramMediaPageUrl('https://www.instagram.com/someuser/')).toBe(false);
	});
});
