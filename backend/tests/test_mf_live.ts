import { listFormats } from '../src/lib/server/extractor';

async function main() {
	const url = 'https://www.mediafire.com/file/j6xouw4etkyx16s/SAIYAARA_BB.mp4/file';
	console.log('Testing MediaFire format listing for:', url);
	const formats = await listFormats(url, { force: true });
	console.log('Format count:', formats.length);
	if (formats.length > 0) {
		console.log('Label:', formats[0].label);
		console.log('Source:', formats[0].source);
		console.log('Kind:', formats[0].kind);
		console.log('URL (truncated):', formats[0].url.slice(0, 80) + '...');
		console.log('SUCCESS: MediaFire format listing works!');
	} else {
		console.error('FAILED: No formats returned');
		process.exit(1);
	}
}

main().catch((e) => {
	console.error('Error:', e);
	process.exit(1);
});
