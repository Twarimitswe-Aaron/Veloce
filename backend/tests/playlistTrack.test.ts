import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import { findCompletedTrackFile, parseFailedIndices, trackStem } from '../src/lib/server/playlistTrack';

describe('playlistTrack', () => {
	const tmp = path.join(process.cwd(), 'tests', '_tmp_playlist_track');

	beforeEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(tmp, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it('builds track stem with index prefix', () => {
		expect(trackStem({ url: 'https://x', title: 'Song', index: 3 }, 2)).toBe('03 - Song');
	});

	it('finds completed track by prefix', () => {
		const stem = '01 - Hello';
		writeFileSync(path.join(tmp, '01 - Hello.m4a'), 'data');
		writeFileSync(path.join(tmp, '01 - Hello.m4a.veloce_done'), '');
		expect(findCompletedTrackFile(tmp, stem)).toContain('01 - Hello.m4a');
	});

	it('ignores in-progress downloads with veloce_state', () => {
		const stem = '02 - Partial';
		writeFileSync(path.join(tmp, '02 - Partial.webm'), 'partial');
		writeFileSync(path.join(tmp, '02 - Partial.webm.veloce_state'), '{}');
		expect(findCompletedTrackFile(tmp, stem)).toBeNull();
	});

	it('parses failed index list', () => {
		expect(parseFailedIndices([0, 5, 'x', 1.5])).toEqual([0, 5]);
		expect(parseFailedIndices(null)).toEqual([]);
	});
});
