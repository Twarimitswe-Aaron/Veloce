// Generates Veloce PNG icons (navy background, white "V") at 16/48/128 px.
// No image deps — encodes a PNG by hand with zlib. Run: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve(process.cwd(), 'static', 'icons');
const BG = [10, 37, 99]; // navy
const FG = [255, 255, 255]; // white

function distToSegment(px, py, ax, ay, bx, by) {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy || 1;
	let t = ((px - ax) * dx + (py - ay) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	const cx = ax + t * dx;
	const cy = ay + t * dy;
	return Math.hypot(px - cx, py - cy);
}

function renderPixels(size) {
	const stroke = 0.14; // relative half-width of the V strokes
	const rows = [];
	for (let y = 0; y < size; y++) {
		const row = Buffer.alloc(size * 4);
		for (let x = 0; x < size; x++) {
			const nx = x / (size - 1);
			const ny = y / (size - 1);
			// Two strokes forming a V meeting at bottom-center.
			const d = Math.min(
				distToSegment(nx, ny, 0.22, 0.22, 0.5, 0.8),
				distToSegment(nx, ny, 0.78, 0.22, 0.5, 0.8)
			);
			const isV = d < stroke;
			const [r, g, b] = isV ? FG : BG;
			const o = x * 4;
			row[o] = r; row[o + 1] = g; row[o + 2] = b; row[o + 3] = 255;
		}
		rows.push(Buffer.concat([Buffer.from([0]), row])); // filter byte 0 per scanline
	}
	return Buffer.concat(rows);
}

function crc32(buf) {
	let c = ~0;
	for (let i = 0; i < buf.length; i++) {
		c ^= buf[i];
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return (~c) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, 'ascii');
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size) {
	const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
	ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
	const idat = deflateSync(renderPixels(size));
	return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
	const file = path.join(OUT_DIR, `icon-${size}.png`);
	writeFileSync(file, encodePng(size));
	console.log('wrote', file);
}
