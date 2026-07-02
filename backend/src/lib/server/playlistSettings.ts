/** User-configurable playlist download format rules (persisted in device settings). */
export type PlaylistMediaType = 'audio' | 'video';
export type PlaylistVideoQuality = '1080' | '720' | '480' | '360' | 'best';
export type PlaylistAudioFallback = 'video' | 'skip';

export interface PlaylistFormatSettings {
	mediaType: PlaylistMediaType;
	videoQuality: PlaylistVideoQuality;
	/** When mediaType=audio and no audio stream exists for a track. */
	audioMissingFallback: PlaylistAudioFallback;
}

export function defaultPlaylistFormatSettings(): PlaylistFormatSettings {
	return {
		mediaType: 'audio',
		videoQuality: '720',
		audioMissingFallback: 'video'
	};
}

export function parsePlaylistFormatSettings(raw: unknown): PlaylistFormatSettings {
	const d = defaultPlaylistFormatSettings();
	if (!raw || typeof raw !== 'object') return d;
	const o = raw as Record<string, unknown>;
	const mediaType = o.mediaType === 'video' ? 'video' : 'audio';
	const videoQuality =
		o.videoQuality === '1080' || o.videoQuality === '720' || o.videoQuality === '480' ||
		o.videoQuality === '360' || o.videoQuality === 'best'
			? o.videoQuality
			: d.videoQuality;
	const audioMissingFallback = o.audioMissingFallback === 'skip' ? 'skip' : 'video';
	return { mediaType, videoQuality, audioMissingFallback };
}

const HEIGHT_LADDER: Record<Exclude<PlaylistVideoQuality, 'best'>, number[]> = {
	'1080': [1080, 720, 480, 360],
	'720': [720, 480, 360],
	'480': [480, 360],
	'360': [360]
};

/** yt-dlp -f selector for combined video+audio single URLs (progressive or merged). */
export function ytdlpVideoFormatChain(quality: PlaylistVideoQuality): string {
	if (quality === 'best') {
		return 'best[vcodec!=none][acodec!=none]/b';
	}
	const parts = HEIGHT_LADDER[quality].map(
		(h) => `best[height<=${h}][vcodec!=none][acodec!=none]`
	);
	parts.push('b');
	return parts.join('/');
}

export const YTDLP_AUDIO_FORMAT = 'ba/b/bestaudio/b';

/** Ordered format attempts for one playlist track. */
export function formatAttemptsForTrack(settings: PlaylistFormatSettings): string[] {
	if (settings.mediaType === 'video') {
		return [ytdlpVideoFormatChain(settings.videoQuality)];
	}
	const attempts = [YTDLP_AUDIO_FORMAT];
	if (settings.audioMissingFallback === 'video') {
		attempts.push(ytdlpVideoFormatChain(settings.videoQuality));
	}
	return attempts;
}
