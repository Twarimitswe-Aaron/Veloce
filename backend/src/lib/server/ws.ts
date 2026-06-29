import { WebSocketServer } from 'ws';
import type { Server } from 'http';
import { db } from './db';
import { downloads, devices } from './db/schema';
import { getMacAddress } from './identity';
import { eq, or } from 'drizzle-orm';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import { statfs } from 'fs/promises';
import { spawn } from 'child_process';
import { extractMediaUrl } from './extractor';
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
				
				const settings = deviceResult[0].settings as any;
				if (settings && settings.baseDirectory) {
					if (ws.readyState === 1) {
						console.log(`📤 Sending restored directory on connection: ${settings.baseDirectory}`);
						ws.send(JSON.stringify({
							type: 'DIRECTORY_SELECTED',
							payload: { path: settings.baseDirectory }
						}));
					}
				}
			}
		} catch (err) {
			console.error('Failed to initialize device identity:', err);
		}

		ws.on('message', async (message) => {
			try {
				const data = JSON.parse(message.toString());
				
				if (data.type === 'NEW_DOWNLOAD') {
					console.log('📥 Received new download request:', data.payload);
					
					// 1. URL Normalization
					let rawUrl = data.payload.url;
					try {
						const urlObj = new URL(rawUrl);
						const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'igsh', 'fbclid', 'gclid', 'si'];
						for (const param of trackingParams) {
							urlObj.searchParams.delete(param);
						}
						rawUrl = urlObj.toString();
					} catch (e) {
						console.error('Invalid URL during normalization:', e);
					}

					const threads = data.payload.threads || 64;

					// Parse base directory
					let baseDir = data.payload.baseDirectory;
					if (!baseDir || baseDir.trim() === '') {
						baseDir = path.join(os.homedir(), 'Downloads', 'Veloce');
					}
					
					// Categorize based on file extension and domain
					let ext = path.extname(data.payload.fileName).toLowerCase();
					let category = 'others';

					// 1. Detect known video/social platforms from URL
					try {
						const urlObj = new URL(data.payload.url);
						const hostname = urlObj.hostname.toLowerCase();
						
						const extractorDomains = ['youtube.com', 'youtu.be', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com', 'vimeo.com', 'facebook.com', 'twitch.tv', 'mediafire.com'];
						
						if (extractorDomains.some(d => hostname.includes(d))) {
							category = 'videos';
							// If the filename has no extension, append .mp4 as a safe default for video sites
							if (!ext) {
								ext = '.mp4';
								data.payload.fileName += ext;
							}
						}
					} catch(e) {
						// Ignore invalid URLs
					}

					// 2. If not caught by domain logic, fallback to extension-based categorization
					if (category === 'others') {
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
					}
					
					let savePath = path.join(baseDir, category, data.payload.fileName);
					
					// 2. Database Deduplication Check
					const existing = await db.select().from(downloads)
						.where(
							or(
								eq(downloads.url, rawUrl),
								eq(downloads.savePath, savePath)
							)
						);
					
					const activeDownload = existing.find(d => ['queued', 'downloading', 'completed'].includes(d.status));
					if (activeDownload) {
						console.log(`♻️  Duplicate found! Attaching to existing download ID: ${activeDownload.id}`);
						ws.send(JSON.stringify({ 
							type: 'DOWNLOAD_ACK', 
							downloadId: activeDownload.id,
							status: activeDownload.status
						}));
						// We skip inserting a new record and spawning Rust.
						// Note: We need a return here, but we are inside an if-statement block.
					} else {
						// Proceed with new download
						const downloadId = crypto.randomUUID();
						
						// 3. Save to Database Queue
						await db.insert(downloads).values({
							id: downloadId,
							deviceId: macAddress,
							url: rawUrl,
							fileName: data.payload.fileName,
							savePath: savePath,
							status: 'queued'
						});
						
						// 4. Acknowledge receipt back to the Extension
						ws.send(JSON.stringify({ 
							type: 'DOWNLOAD_ACK', 
							downloadId,
							status: 'queued'
						}));
						
						console.log(`✅ Download queued in database with ID: ${downloadId}`);
						
						// 5. Implement Background yt-dlp, Disk Space Check, and Spawn Rust Core Engine
						(async () => {
							try {
								let finalUrl = rawUrl;
								
								// 5a. yt-dlp extraction for video sites and file hosts
								if (category === 'videos') {
									console.log(`🔍 Extracting direct URL for ${rawUrl}...`);
									const directUrl = await extractMediaUrl(rawUrl);
									if (directUrl) {
										finalUrl = directUrl;
										console.log(`🎯 Extracted direct URL successfully`);
										
										// Try to get a better filename from the direct URL if the current one is generic
										if (data.payload.fileName.startsWith('file') || data.payload.fileName.startsWith('download_file')) {
											try {
												const u = new URL(finalUrl);
												const parts = u.pathname.split('/').filter(p => p.length > 0);
												let betterName = parts.pop();
												if (betterName && betterName.includes('.')) {
													// decode URL encoding (like %20 or +)
													betterName = decodeURIComponent(betterName.replace(/\+/g, ' '));
													data.payload.fileName = betterName;
													// Update savePath with the better filename
													savePath = path.join(baseDir, category, betterName);
													await db.update(downloads).set({ fileName: betterName, savePath }).where(eq(downloads.id, downloadId));
												}
											} catch(e) {}
										}

										await db.update(downloads).set({ url: finalUrl }).where(eq(downloads.id, downloadId));
									}
								}

								// 5b. Disk Space Check
								try {
									const stat = await statfs(baseDir);
									const availableBytes = stat.bfree * stat.bsize;
									if (availableBytes < 500 * 1024 * 1024) { // 500MB buffer
										console.error('❌ Insufficient disk space!');
										await db.update(downloads).set({ status: 'error' }).where(eq(downloads.id, downloadId));
										// FIX #8: Guard ws.readyState before sending
										if (ws.readyState === 1) {
											ws.send(JSON.stringify({ type: 'DOWNLOAD_ERROR', downloadId, error: 'Insufficient disk space' }));
										}
										return;
									}
								} catch (e) {
									console.error('Failed to check disk space', e);
								}

								// 5c. Spawn Rust Core Engine
								console.log(`🚀 Spawning Rust Core for ID: ${downloadId}`);
								await db.update(downloads).set({ status: 'downloading' }).where(eq(downloads.id, downloadId));
								
								// FIX #1: Spawn the pre-compiled binary directly — not `cargo run`.
								// `cargo run` adds ~2s startup overhead checking if recompile is needed.
								const coreDir   = path.resolve(process.cwd(), '../core_engine');
								const binaryPath = path.join(coreDir, 'target', 'release', 'core_engine');
								const rustProcess = spawn(binaryPath, [
									'--id', downloadId,
									'--url', finalUrl,
									'--save-path', savePath,
									'--threads', threads.toString()
								], {
									// Pass stdout as a pipe so we can parse JSON.
									// Inherit stderr directly to the terminal so `indicatif` detects a true TTY and renders ANSI bars.
									stdio: ['ignore', 'pipe', 'inherit']
								});

								
								// FIX #3: Line buffer — a single `data` event may contain multiple
								// JSON lines OR one JSON object split across two events. Accumulate
								// until we see a full newline before parsing.
								let lineBuffer = '';
								// FIX #2: Track last DB write time — only persist progress every 5s
								// to avoid constant SQLite write-lock contention.
								let lastDbWrite = 0;

								rustProcess.stdout.on('data', async (chunk) => {
									lineBuffer += chunk.toString();
									const lines = lineBuffer.split('\n');
									lineBuffer = lines.pop()!; // keep any incomplete trailing line
									for (const line of lines) {
										if (!line.trim()) continue;
										try {
											const progress = JSON.parse(line);
											if (progress.type === 'progress') {
												// FIX #2: Throttle DB writes — only write once every 5s.
												// Status changes (completed/error) always write immediately.
												const now = Date.now();
												if (now - lastDbWrite > 5000) {
													lastDbWrite = now;
													await db.update(downloads).set({ 
														downloadedBytes: progress.downloaded,
														totalBytes: progress.total
													}).where(eq(downloads.id, downloadId));
												}
												
												// FIX #4: Removed dead renderDashboard — indicatif renders
												// the terminal display directly via stderr passthrough.
												
												if (ws.readyState === 1) {
													ws.send(JSON.stringify({
														type: 'PROGRESS',
														downloadId,
														downloaded: progress.downloaded,
														total: progress.total,
														speedBps: progress.speed_bps || 0,
														etaSecs: progress.eta_secs || 0,
														elapsedSecs: progress.elapsed_secs || 0,
														threads: progress.threads || []
													}));
												}
											} else if (progress.type === 'info') {
												const chunkMb = (progress.chunk_size_bytes / 1024 / 1024).toFixed(2);
												const totalMb = (progress.total_size_bytes / 1024 / 1024).toFixed(2);
												console.log(`\n[Veloce] Starting ${progress.threads} threads | chunk: ${chunkMb} MB | total: ${totalMb} MB`);
											} else if (progress.type === 'already_exists') {
												console.log(`\n[Veloce] File already fully downloaded — skipping!`);
												await db.update(downloads).set({ status: 'completed' }).where(eq(downloads.id, downloadId));
												if (ws.readyState === 1) {
													ws.send(JSON.stringify({ type: 'DOWNLOAD_COMPLETED', downloadId, status: 'completed' }));
												}
											} else if (progress.type === 'done') {
												const totalMb = (progress.total / 1024 / 1024).toFixed(1);
												console.log(`\n✅ [Veloce] Download complete! ${totalMb} MB in ${progress.elapsed_secs?.toFixed(1)}s @ avg ${progress.avg_speed_mbps?.toFixed(2)} MB/s`);
											}
										} catch (e) {
											// Non-JSON output (like cargo build logs)
											console.log(`\n[Rust Core]: ${line}`);
										}
									}
								});

								rustProcess.on('close', async (code) => {
									console.log(`\n[Rust Core] Exited with code ${code}`);
									const finalStatus = code === 0 ? 'completed' : 'error';
									await db.update(downloads).set({ status: finalStatus }).where(eq(downloads.id, downloadId));
									if (ws.readyState === 1) {
										ws.send(JSON.stringify({ type: 'DOWNLOAD_COMPLETED', downloadId, status: finalStatus }));
									}
								});

							} catch (e) {
								console.error('❌ Background processing failed:', e);
							}
						})();
					}
				} else if (data.type === 'REQUEST_DIRECTORY_PICKER') {
					console.log('🔄 Directory picker requested by frontend');
					try {
						const { execSync } = await import('child_process');
						console.log('🔄 Executing zenity command...');
						// Suppress stderr to avoid GTK warnings causing issues, and ensure we get only stdout
						const result = execSync('zenity --file-selection --directory 2>/dev/null').toString().trim();
						console.log('✅ Zenity returned:', result);
						if (result) {
							// Persist to database so it survives popup reloads
							await db.update(devices).set({ 
								settings: { baseDirectory: result } 
							}).where(eq(devices.id, macAddress));

							if (ws.readyState === 1) {
								console.log('📤 Sending DIRECTORY_SELECTED back to frontend');
								ws.send(JSON.stringify({
									type: 'DIRECTORY_SELECTED',
									payload: { path: result }
								}));
							} else {
								console.log('⚠️ WebSocket closed before we could send the directory back');
							}
						}
					} catch (e) {
						console.error('❌ Folder selection error:', e);
					}
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
