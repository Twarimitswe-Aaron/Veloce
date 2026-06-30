import { writable } from 'svelte/store';

export const isConnected = writable(false);
export const selectedDirectory = writable<string | null>(null);
export const pickerError = writable<string | null>(null);

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'error';

export interface DownloadItem {
	id: string;
	fileName: string;
	status: DownloadStatus;
	downloaded: number;
	total: number;
	speedBps: number;
	etaSecs: number;
	error?: string;
	updatedAt: number;
}

// Map of downloadId -> live download state, surfaced to the popup UI.
export const downloads = writable<Record<string, DownloadItem>>({});

function upsertDownload(id: string, patch: Partial<DownloadItem>) {
	downloads.update((map) => {
		const prev = map[id] ?? {
			id,
			fileName: 'Unknown file',
			status: 'queued' as DownloadStatus,
			downloaded: 0,
			total: 0,
			speedBps: 0,
			etaSecs: 0,
			updatedAt: Date.now()
		};
		return { ...map, [id]: { ...prev, ...patch, updatedAt: Date.now() } };
	});
}

class VeloceWebSocketClient {
	private ws: WebSocket | null = null;
	private url = 'ws://localhost:14921/ws';
	private reconnectInterval = 3000;

	connect() {
		if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
			return;
		}

		console.log('[Veloce Extension] Attempting to connect to Local Coordinator...');
		this.ws = new WebSocket(this.url);

		this.ws.onopen = () => {
			console.log('[Veloce Extension] Connected to Local Coordinator.');
			isConnected.set(true);
		};

		this.ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				console.log('[Veloce Extension] Received message:', data);

				switch (data.type) {
					case 'DOWNLOAD_SNAPSHOT':
						// Rebuild the list from the backend's view (popup reopened).
						if (Array.isArray(data.downloads)) {
							const map: Record<string, DownloadItem> = {};
							for (const d of data.downloads) {
								map[d.downloadId] = {
									id: d.downloadId,
									fileName: d.fileName ?? 'Unknown file',
									status: (d.status as DownloadStatus) ?? 'queued',
									downloaded: d.downloaded ?? 0,
									total: d.total ?? 0,
									speedBps: 0,
									etaSecs: 0,
									updatedAt: Date.now()
								};
							}
							downloads.set(map);
						}
						break;

					case 'DOWNLOAD_ACK':
						upsertDownload(data.downloadId, {
							fileName: data.fileName ?? 'Unknown file',
							status: data.status ?? 'queued'
						});
						break;

					case 'PROGRESS':
						upsertDownload(data.downloadId, {
							status: 'downloading',
							downloaded: data.downloaded ?? 0,
							total: data.total ?? 0,
							speedBps: data.speedBps ?? 0,
							etaSecs: data.etaSecs ?? 0
						});
						break;

					case 'DOWNLOAD_COMPLETED':
						upsertDownload(data.downloadId, {
							status: (data.status as DownloadStatus) ?? 'completed',
							speedBps: 0,
							etaSecs: 0
						});
						break;

					case 'DOWNLOAD_PAUSED':
						upsertDownload(data.downloadId, {
							status: 'paused',
							speedBps: 0,
							etaSecs: 0
						});
						break;

					case 'DOWNLOAD_REMOVED':
						downloads.update((map) => {
							const next = { ...map };
							delete next[data.downloadId];
							return next;
						});
						break;

					case 'DOWNLOAD_ERROR':
						upsertDownload(data.downloadId, {
							status: 'error',
							error: data.error ?? 'Download failed',
							speedBps: 0,
							etaSecs: 0
						});
						break;

					case 'DIRECTORY_SELECTED':
						console.log(`📁 User selected directory: ${data.payload.path}`);
						pickerError.set(null);
						selectedDirectory.set(data.payload.path);
						break;

					case 'DIRECTORY_PICKER_UNAVAILABLE':
						pickerError.set(data.error ?? 'Folder picker unavailable. Type the path manually.');
						break;
				}
			} catch (e) {
				console.error('[Veloce Extension] Failed to parse WebSocket message:', e);
			}
		};

		this.ws.onclose = () => {
			console.log('[Veloce Extension] Disconnected from Local Coordinator. Retrying...');
			isConnected.set(false);
			this.ws = null;
			setTimeout(() => this.connect(), this.reconnectInterval);
		};

		this.ws.onerror = (error) => {
			console.error('[Veloce Extension] WebSocket Error:', error);
			this.ws?.close();
		};
	}

	sendDownloadRequest(url: string, fileName: string, baseDirectory?: string, threads: number = 8) {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({
				type: 'NEW_DOWNLOAD',
				payload: { url, fileName, baseDirectory, threads }
			}));
			console.log(`[Veloce Extension] Sent download request for: ${fileName}`);
		} else {
			console.error('[Veloce Extension] Cannot send request, Local Coordinator is disconnected.');
		}
	}

	private sendControl(type: string, downloadId: string) {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type, downloadId }));
		} else {
			console.error(`[Veloce Extension] Cannot send ${type}, Local Coordinator is disconnected.`);
		}
	}

	pauseDownload(id: string) {
		this.sendControl('PAUSE_DOWNLOAD', id);
	}

	resumeDownload(id: string) {
		this.sendControl('RESUME_DOWNLOAD', id);
	}

	cancelDownload(id: string) {
		this.sendControl('CANCEL_DOWNLOAD', id);
	}

	removeDownload(id: string) {
		this.sendControl('REMOVE_DOWNLOAD', id);
	}

	requestDirectoryPicker() {
		console.log('[Veloce Extension] requestDirectoryPicker called');
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: 'REQUEST_DIRECTORY_PICKER' }));
			console.log('[Veloce Extension] Requested native directory picker');
		} else {
			console.error('[Veloce Extension] Cannot request directory picker, Local Coordinator is disconnected.');
		}
	}
}

export const wsClient = new VeloceWebSocketClient();
