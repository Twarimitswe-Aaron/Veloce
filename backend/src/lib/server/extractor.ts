import { spawn } from 'child_process';

/**
 * Extracts the direct media URL from a social media link (Instagram, YouTube, etc) using yt-dlp.
 * @param url The raw social media URL
 * @returns The absolute direct media URL, or null if it fails
 */
export async function extractMediaUrl(url: string): Promise<string | null> {
    return new Promise((resolve) => {
        // TODO: Ensure yt-dlp is installed and available in the system PATH
        const ytdlp = spawn('yt-dlp', ['-g', url]);
        
        let output = '';
        
        ytdlp.stdout.on('data', (data) => {
            output += data.toString();
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
