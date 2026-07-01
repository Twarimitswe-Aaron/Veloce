import { describe, it, expect } from 'vitest';
import path from 'path';
import { isSafeDownloadUrl, sanitizeFileName, safeJoin, categoryForExt } from '../src/lib/server/util';

describe('isSafeDownloadUrl', () => {
	it('accepts normal http(s) URLs', () => {
		expect(isSafeDownloadUrl('https://example.com/a.mp4').ok).toBe(true);
		expect(isSafeDownloadUrl('http://example.com/a.zip').ok).toBe(true);
	});

	it('rejects non-http protocols', () => {
		expect(isSafeDownloadUrl('ftp://example.com/a').ok).toBe(false);
		expect(isSafeDownloadUrl('file:///etc/passwd').ok).toBe(false);
		expect(isSafeDownloadUrl('blob:https://x/y').ok).toBe(false);
	});

	it('rejects invalid URLs', () => {
		expect(isSafeDownloadUrl('not a url').ok).toBe(false);
	});

	it('blocks localhost / private / metadata hosts (SSRF)', () => {
		expect(isSafeDownloadUrl('http://localhost/x').ok).toBe(false);
		expect(isSafeDownloadUrl('http://127.0.0.1/x').ok).toBe(false);
		expect(isSafeDownloadUrl('http://10.0.0.5/x').ok).toBe(false);
		expect(isSafeDownloadUrl('http://192.168.1.1/x').ok).toBe(false);
		expect(isSafeDownloadUrl('http://169.254.169.254/latest/meta-data').ok).toBe(false);
		expect(isSafeDownloadUrl('http://172.16.0.1/x').ok).toBe(false);
	});
});

describe('sanitizeFileName', () => {
	it('strips directory components', () => {
		expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
		expect(sanitizeFileName('/abs/path/file.mp4')).toBe('file.mp4');
	});

	it('replaces control chars', () => {
		expect(sanitizeFileName('a\u0000b.mp4')).toBe('a_b.mp4');
	});

	it('falls back for empty / dot names', () => {
		expect(sanitizeFileName('')).toMatch(/^download_/);
		expect(sanitizeFileName('..')).toMatch(/^download_/);
	});
});

describe('safeJoin', () => {
	it('keeps paths within the base dir', () => {
		const p = safeJoin('/base', 'videos', 'a.mp4');
		expect(p).toBe(path.resolve('/base/videos/a.mp4'));
	});

	it('confines traversal attempts to the base', () => {
		// The filename is reduced to a basename first, so traversal cannot escape.
		const p = safeJoin('/base', 'videos', '../../evil.sh');
		expect(p).toBe(path.resolve('/base/videos/evil.sh'));
	});
});

describe('categoryForExt', () => {
	it('maps known extensions', () => {
		expect(categoryForExt('.mp4')).toBe('videos');
		expect(categoryForExt('.MKV')).toBe('videos');
		expect(categoryForExt('.jpg')).toBe('images');
		expect(categoryForExt('.mp3')).toBe('audio');
		expect(categoryForExt('.pdf')).toBe('documents');
		expect(categoryForExt('.zip')).toBe('archives');
	});

	it('defaults unknown to others', () => {
		expect(categoryForExt('.xyz')).toBe('others');
		expect(categoryForExt('')).toBe('others');
	});
});
