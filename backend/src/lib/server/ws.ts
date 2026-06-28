import { WebSocketServer } from 'ws';
import type { Server } from 'http';
import { db } from './db';
import { downloads, devices } from './db/schema';
import { getMacAddress } from './identity';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
export function setupWebSocketServer(server: Server) {
	const wss = new WebSocketServer({ server, path: '/ws' });
	
	wss.on('connection', async (ws) => {
		console.log('Extension connected to Local Coordinator via WebSocket!');
		
		const macAddress = getMacAddress();
		
		// Ensure device exists in DB using the MAC address
		try {
			const deviceResult = await db.select().from(devices).where(eq(devices.id, macAddress));
			if (deviceResult.length === 0) {
				await db.insert(devices).values({
					id: macAddress,
					createdAt: new Date(),
					lastActive: new Date(),
					settings: {}
				});
			} else {
				await db.update(devices).set({ lastActive: new Date() }).where(eq(devices.id, macAddress));
			}
		} catch (err) {
			console.error('Failed to initialize device identity:', err);
		}

		ws.on('message', async (message) => {
			try {
				const data = JSON.parse(message.toString());
				
				if (data.type === 'NEW_DOWNLOAD') {
					console.log('📥 Received new download request:', data.payload);
					
					const downloadId = crypto.randomUUID();
					
					// Parse base directory
					let baseDir = data.payload.baseDirectory;
					if (!baseDir || baseDir.trim() === '') {
						baseDir = path.join(os.homedir(), 'Downloads', 'Veloce');
					}
					
					// Categorize based on file extension
					const ext = path.extname(data.payload.fileName).toLowerCase();
					let category = 'others';
					if (['.mp4', '.mkv', '.webm', '.avi', '.mov'].includes(ext)) {
						category = 'videos';
					} else if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) {
						category = 'images';
					} else if (['.mp3', '.wav', '.flac', '.ogg'].includes(ext)) {
						category = 'audio';
					} else if (['.pdf', '.doc', '.docx', '.txt'].includes(ext)) {
						category = 'documents';
					} else if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) {
						category = 'archives';
					}
					
					const savePath = path.join(baseDir, category, data.payload.fileName);
					
					// 1. Save to Database Queue
					await db.insert(downloads).values({
						id: downloadId,
						deviceId: macAddress,
						url: data.payload.url,
						fileName: data.payload.fileName,
						savePath: savePath,
						status: 'queued'
					});
					
					// 2. Acknowledge receipt back to the Extension
					ws.send(JSON.stringify({ 
						type: 'DOWNLOAD_ACK', 
						downloadId,
						status: 'queued'
					}));
					
					console.log(`✅ Download queued in database with ID: ${downloadId}`);
					
					// 3. TODO: Spawn Rust Core Engine Child Process here!
				}
			} catch (err) {
				console.error('❌ Failed to process WebSocket message:', err);
			}
		});

		ws.on('close', () => {
			console.log('Extension disconnected.');
		});
	});
}
