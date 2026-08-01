/** Platform signature for format listing and download routing. */
export type MediaSource =
	| 'youtube'
	| 'instagram'
	| 'tiktok'
	| 'twitter'
	| 'mediafire'
	| 'direct'
	| 'generic';

export type FormatKind = 'direct' | 'progressive' | 'adaptive' | 'manifest';

export function detectMediaSource(url: string): MediaSource {
	try {
		const h = new URL(url).hostname.toLowerCase();
		if (h.includes('youtube.com') || h === 'youtu.be') return 'youtube';
		if (h.includes('instagram.com')) return 'instagram';
		if (h.includes('tiktok.com')) return 'tiktok';
		if (h.includes('twitter.com') || h === 'x.com') return 'twitter';
		if (h.includes('mediafire.com')) return 'mediafire';
	} catch { /* ignore */ }
	return 'generic';
}

export function isManifestFormatUrl(url: string): boolean {
	if (!url) return false;
	const u = url.toLowerCase();
	try {
		const host = new URL(url).hostname.toLowerCase();
		// YouTube HLS/DASH host — playlist body must never be fed to core_engine as a file.
		if (host === 'manifest.googlevideo.com' || host.endsWith('.manifest.googlevideo.com')) {
			return true;
		}
	} catch {
		/* ignore */
	}
	return (
		u.includes('.m3u8') ||
		u.includes('.mpd') ||
		u.includes('/manifest/') ||
		u.includes('playlist_type') ||
		/\bformat=m3u8/i.test(u)
	);
}

/** True for /p/, /reel/, /tv/, /stories/… — not the Instagram homepage or profile root. */
export function isInstagramMediaPageUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (!u.hostname.toLowerCase().includes('instagram.com')) return false;
		return /\/(p|reel|reels|tv|stories)\//i.test(u.pathname);
	} catch {
		return false;
	}
}

export function inferFormatKind(formatUrl: string, protocol?: string): FormatKind {
	const p = (protocol || '').toLowerCase();
	if (isManifestFormatUrl(formatUrl) || p.includes('m3u8') || p.includes('dash')) {
		return 'manifest';
	}
	if (p.includes('http') && !p.includes('m3u8')) return 'progressive';
	return 'progressive';
}

/** User-facing error — always matched to the URL's platform, never a generic cross-site message. */
export function failReasonForSource(source: MediaSource, lastErr?: string): string {
	const err = (lastErr || '').toLowerCase();

	if (source === 'instagram') {
		if (err.includes('secretstorage') || err.includes('failed to decrypt')) {
			// yt-dlp (bundled Python tool) decrypts Chrome cookies — not Veloce TS/Rust.
			return 'Cannot read Chrome login cookies for Instagram (yt-dlp). Log in to Instagram in Firefox and retry the badge.';
		}
		if (err.includes('cookies database') || err.includes('could not find')) {
			return 'Could not read browser cookies for Instagram. Log in to Instagram in Firefox, then retry the Veloce badge.';
		}
		if (err.includes('empty media')) {
			return 'Instagram blocked yt-dlp for this post. Stay logged in to Instagram in Firefox or Chrome, reload the post, then click the Veloce badge again. Image-only posts have no video.';
		}
		if (err.includes('story') || err.includes('stories')) {
			return 'Instagram story extraction failed. Stay logged in, open the video story, then click the Veloce badge. Photo-only stories have no video stream.';
		}
		if (err.includes('video-with-audio') || err.includes('dash-only') || err.includes('silent')) {
			return 'Instagram only offered silent video streams for this post. Stay logged in, reload, and retry — or try another reel.';
		}
		return 'Instagram returned no formats. Log in to Instagram in Firefox, reload the page, and retry.';
	}

	if (source === 'youtube') {
		if (
			err.includes('challenge solving') ||
			err.includes('signature solving') ||
			err.includes('only images are available')
		) {
			return 'YouTube blocked format extraction (JS challenge). Ensure Node.js is installed on your system, restart the Veloce backend, then retry from the badge.';
		}
		if (err.includes('not available') || err.includes('private')) {
			return 'YouTube reports this video is unavailable (region, sign-in, or age gate). Open it in your browser, sign in if needed, then retry from the Veloce badge.';
		}
		if (err.includes('requested format is not available')) {
			return 'YouTube returned no progressive formats for this video. Retry with the Veloce badge — the backend will try alternate player clients.';
		}
		return 'YouTube returned no formats. Sign in to YouTube in Chrome and retry.';
	}

	if (source === 'tiktok') {
		return 'TikTok returned no formats. Open the video in your browser while logged in, then retry.';
	}

	if (source === 'twitter') {
		return 'X/Twitter returned no formats. Open the post in your browser while logged in, then retry.';
	}

	if (lastErr) {
		return lastErr.length > 240 ? `${lastErr.slice(0, 237)}…` : lastErr;
	}

	return 'No downloadable formats found for this URL.';
}

export function failCacheTtlMs(source: MediaSource, urlKey: string): number {
	if (source === 'instagram' || /instagram\.com/i.test(urlKey)) return 5 * 60 * 1000;
	return 90 * 1000;
}
