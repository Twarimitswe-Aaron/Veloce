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

    // 2. yt-dlp Extractor for everything else
    return new Promise((resolve) => {
        // Use the locally downloaded yt-dlp binary
        const ytdlpPath = path.resolve(process.cwd(), 'bin', 'yt-dlp');
        const ytdlp = spawn(ytdlpPath, ['--cookies-from-browser', 'chrome', '-f', 'b', '-g', url]);
        
        let output = '';
        
        ytdlp.stdout.on('data', (data) => {
            output += data.toString();
        });

        ytdlp.stderr.on('data', (data) => {
            console.error(`[yt-dlp log]: ${data.toString().trim()}`);
        });
        
        ytdlp.on('close', (code) => {
            if (code === 0 && output.trim()) {
                resolve(output.trim().split('\n')[0]);
            } else {
                console.error(`yt-dlp failed for url ${url}`);
                resolve(null);
            }
        });
        
        ytdlp.on('error', (err) => {
            console.error('yt-dlp error (is it installed?):', err);
            resolve(null);
        });
    });
}
