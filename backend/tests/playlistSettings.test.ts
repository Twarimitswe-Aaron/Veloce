import { describe, it, expect } from 'vitest';
import {
	formatAttemptsForTrack,
	parsePlaylistFormatSettings,
	ytdlpVideoFormatChain
} from '../src/lib/server/playlistSettings';

describe('playlistSettings', () => {
	it('parses playlist format settings', () => {
		const s = parsePlaylistFormatSettings({
			mediaType: 'video',
			videoQuality: '1080',
			audioMissingFallback: 'skip'
		});
		expect(s.mediaType).toBe('video');
		expect(s.videoQuality).toBe('1080');
		expect(s.audioMissingFallback).toBe('skip');
	});

	it('audio mode tries audio then video fallback', () => {
		const attempts = formatAttemptsForTrack({
			mediaType: 'audio',
			videoQuality: '720',
			audioMissingFallback: 'video'
		});
		expect(attempts.length).toBe(2);
		expect(attempts[0]).toContain('bestaudio');
		expect(attempts[1]).toContain('height<=720');
	});

	it('video mode uses quality ladder', () => {
		const chain = ytdlpVideoFormatChain('720');
		expect(chain).toContain('height<=720');
		expect(chain).toContain('height<=480');
		expect(chain).toContain('/b');
	});
});
