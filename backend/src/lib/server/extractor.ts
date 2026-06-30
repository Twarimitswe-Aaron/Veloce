import { spawn } from 'child_process';
import path from 'path';

/**
 * Extracts the direct media URL from a social media link (Instagram, YouTube, etc) using yt-dlp.
 * @param url The raw social media URL
 * @returns The absolute direct media URL, or null if it fails
 */
export async function extractMediaUrl(url: string): Promise<string | null> {
    // 1. Custom Mediafire Extractor
    if (url.includes('mediafire.com')) {
        console.log(`[Extractor] Using custom Mediafire parser for ${url}`);
        try {
            const res = await fetch(url);
            const html = await res.text();
            // Find the direct download button link (e.g. https://download2355.mediafire.com/...)
            const match = html.match(/href="([^"]*download[^"]*mediafire\.com[^"]*)"/i);
            if (match && match[1]) {
                return match[1];
            }
        } catch (e) {
            console.error('[Extractor] Failed to parse Mediafire link', e);
        }
        return null;
    }

    // 2. yt-dlp Extractor for everything else (YouTube, Instagram, TikTok, ...).
    //    Many sites (e.g. Instagram reels) need login cookies and the URL has no
    //    file extension. We try several cookie sources in order and take the
    //    first that yields a direct media URL.
    const cookieStrategies: string[][] = [
        ['--cookies-from-browser', 'chrome'],
        ['--cookies-from-browser', 'firefox'],
        [] // no cookies — works for fully public media
    ];

    for (const cookieArgs of cookieStrategies) {
        const label = cookieArgs.length ? cookieArgs[1] : 'no-cookies';
        const directUrl = await runYtDlp(url, cookieArgs);
        if (directUrl) {
            console.log(`[Extractor] Resolved via yt-dlp (${label})`);
            return directUrl;
        }
        console.error(`[Extractor] yt-dlp attempt failed (${label}) for ${url}`);
    }

    console.error(`[Extractor] All yt-dlp strategies failed for ${url}`);
    return null;
}

/**
 * Run yt-dlp once with a given cookie strategy and return the first direct
 * media URL, or null on failure/timeout. Uses `-f b` (best progressive stream)
 * so the engine receives a single downloadable URL with audio+video combined.
 */
function runYtDlp(url: string, cookieArgs: string[]): Promise<string | null> {
    return new Promise((resolve) => {
        const ytdlpPath = path.resolve(process.cwd(), 'bin', 'yt-dlp');
        const ytdlp = spawn(ytdlpPath, [
            ...cookieArgs,
            // Best SINGLE progressive file (audio+video in one URL). We avoid
            // split video+audio formats because the engine downloads one URL.
            '-f', 'b/best',
            '--no-playlist',
            '-g',
            url
        ]);

        let output = '';
        let settled = false;
        const done = (result: string | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };

        // Kill yt-dlp after 30s to avoid hanging when a browser is locked,
        // cookies are inaccessible, or the network stalls.
        const timeout = setTimeout(() => {
            ytdlp.kill();
            console.error(`[yt-dlp] Timed out after 30s for: ${url}`);
            done(null);
        }, 30_000);

        ytdlp.stdout.on('data', (data) => {
            output += data.toString();
        });

        ytdlp.stderr.on('data', (data) => {
            console.error(`[yt-dlp log]: ${data.toString().trim()}`);
        });

        ytdlp.on('close', (code) => {
            if (code === 0 && output.trim()) {
                // With merged formats yt-dlp may print multiple URLs; take the first.
                done(output.trim().split('\n')[0]);
            } else {
                done(null);
            }
        });

        ytdlp.on('error', (err) => {
            console.error('yt-dlp error (is it installed?):', err);
            done(null);
        });
    });
}
