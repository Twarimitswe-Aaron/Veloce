import { describe, expect, it } from 'vitest';
import { decodeRemoteFileName, sanitizeFileName } from '../src/lib/server/util';

describe('decodeRemoteFileName / sanitizeFileName', () => {
	it('decodes MediaFire-style CDN names', () => {
		expect(decodeRemoteFileName('Let%2CS+Fight+Ghost+Ep2+Hd.mp4')).toBe(
			'Let,S Fight Ghost Ep2 Hd.mp4'
		);
		expect(sanitizeFileName('Let%2CS+Fight+Ghost+Ep2+Hd.mp4')).toBe(
			'Let,S Fight Ghost Ep2 Hd.mp4'
		);
	});

	it('does not leave Direct as a filename', () => {
		expect(sanitizeFileName('Direct.mp4')).toBe('Direct.mp4');
	});
});
