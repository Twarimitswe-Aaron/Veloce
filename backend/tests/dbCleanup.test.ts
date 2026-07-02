import { describe, it, expect } from 'vitest';
import { prepareResumePosition } from '../src/lib/server/playlistTrack';
import type { PlaylistEntry } from '../src/lib/server/extractor';

describe('dbCleanup', () => {
	it('detects legacy playlist folder paths', async () => {
		const { isOrphanPlaylistDownloadRow } = await import('../src/lib/server/dbCleanup');
		expect(isOrphanPlaylistDownloadRow({
			savePath: '/home/x/Downloads/Veloce/playlists/My Mix/01 - Song.webm',
			fileName: '01 - Song.webm'
		})).toBe(true);
		expect(isOrphanPlaylistDownloadRow({
			savePath: '/home/x/Downloads/Veloce/videos/movie.mp4',
			fileName: 'movie.mp4'
		})).toBe(false);
	});
});

describe('prepareResumePosition', () => {
	const entries: PlaylistEntry[] = [
		{ url: 'https://youtube.com/watch?v=a', title: 'A', index: 1 },
		{ url: 'https://youtube.com/watch?v=b', title: 'B', index: 2 },
		{ url: 'https://youtube.com/watch?v=c', title: 'C', index: 3 }
	];

	it('skips failed indices on resume', () => {
		const r = prepareResumePosition(entries, '/tmp/empty', 1, 1, [1]);
		expect(r.index).toBe(2);
	});
});
