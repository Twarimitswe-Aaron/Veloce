import { describe, expect, it } from 'vitest';
import {
	githubBlobToRaw,
	isGithubRawUrl,
	isGithubRepoBrowseUrl,
	resolveGithubDownloadUrl
} from '../src/lib/server/github';

describe('github URL helpers', () => {
	it('detects repo browse pages', () => {
		expect(isGithubRepoBrowseUrl('https://github.com/Beblia/Holy-Bible-XML-Format')).toBe(true);
		expect(isGithubRepoBrowseUrl('https://github.com/o/r/tree/main/docs')).toBe(true);
		expect(isGithubRepoBrowseUrl('https://github.com/o/r/blob/main/file.xml')).toBe(false);
	});

	it('converts blob pages to raw URLs', () => {
		expect(
			githubBlobToRaw('https://github.com/o/r/blob/main/path/file.xml')
		).toBe('https://raw.githubusercontent.com/o/r/main/path/file.xml');
	});

	it('passes through raw.githubusercontent.com', () => {
		const url = 'https://raw.githubusercontent.com/o/r/main/file.xml';
		expect(isGithubRawUrl(url)).toBe(true);
		expect(resolveGithubDownloadUrl(url)).toEqual({ url });
	});

	it('rejects repository root URLs', () => {
		const r = resolveGithubDownloadUrl('https://github.com/Beblia/Holy-Bible-XML-Format');
		expect('error' in r).toBe(true);
	});
});

describe('listFormats github', () => {
	it('resolves blob pages to raw.githubusercontent.com', async () => {
		const { listFormats } = await import('../src/lib/server/extractor');
		const formats = await listFormats(
			'https://github.com/Beblia/Holy-Bible-XML-Format/blob/master/Kinyarwanda2012Bible.xml',
			{ force: true }
		);
		expect(formats).toHaveLength(1);
		expect(formats[0].url).toBe(
			'https://raw.githubusercontent.com/Beblia/Holy-Bible-XML-Format/master/Kinyarwanda2012Bible.xml'
		);
		expect(formats[0].ext).toBe('.xml');
	});
});
