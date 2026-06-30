import { writable } from 'svelte/store';

export const isConnected = writable(false);
export const selectedDirectory = writable<string | null>(null);
export const pickerError = writable<string | null>(null);
export const interceptEnabled = writable(true);

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

const hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

function chromeSend<T>(msg: object): Promise<T> {
	return new Promise((resolve, reject) => {
		if (!hasChrome) {
			reject(new Error('Not in extension context'));
			return;
		}
		chrome.runtime.sendMessage(msg, (resp) => {
			if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
			else resolve(resp as T);
		});
	});
}

/** Popup talks to the coordinator only through the background service worker (single WS). */
class VeloceWebSocketClient {
	private keepalivePort: { disconnect(): void } | null = null;
	private listening = false;

	private handleRuntimeMessage(msg: { type?: string; [key: string]: unknown }) {
		switch (msg.type) {
			case 'VELOCE_STATE':
				isConnected.set(!!msg.connected);
				if (msg.selectedDirectory !== undefined) {
					selectedDirectory.set((msg.selectedDirectory as string | null) ?? null);
				}
				if (msg.downloads && typeof msg.downloads === 'object') {
					const map: Record<string, DownloadItem> = {};
					for (const [id, d] of Object.entries(msg.downloads as Record<string, DownloadItem>)) {
						map[id] = { ...d, id };
					}
					downloads.set(map);
				}
				break;
			case 'VELOCE_DOWNLOAD_UPDATE':
				if (msg.download) {
					const d = msg.download as DownloadItem;
					upsertDownload(d.id, d);
				}
				break;
			case 'VELOCE_DOWNLOAD_REMOVED':
				if (msg.downloadId) {
					downloads.update((m) => {
						const next = { ...m };
						delete next[msg.downloadId as string];
						return next;
					});
				}
				break;
			case 'VELOCE_DIRECTORY':
				pickerError.set(null);
				selectedDirectory.set((msg.path as string | null) ?? null);
				break;
			case 'VELOCE_PICKER_ERROR':
				pickerError.set((msg.error as string) ?? 'Folder picker unavailable.');
				break;
		}
	}

	connect() {
		if (!hasChrome) return;

		if (!this.listening) {
			chrome.runtime.onMessage.addListener((msg) => {
				this.handleRuntimeMessage(msg);
			});
			this.listening = true;
		}

		try {
			this.keepalivePort?.disconnect();
			this.keepalivePort = chrome.runtime.connect({ name: 'veloce-popup' });
		} catch {
			/* ignore */
		}

		chrome.storage.local.get(['veloce_intercept', 'veloce_base_dir', 'veloce_connected'], (r) => {
			interceptEnabled.set(r.veloce_intercept !== false);
			if (r.veloce_base_dir) selectedDirectory.set(r.veloce_base_dir);
			isConnected.set(!!r.veloce_connected);
		});

		void chromeSend<{ connected: boolean; downloads: Record<string, DownloadItem>; selectedDirectory: string | null }>({
			type: 'VELOCE_CONNECT'
		}).then((state) => {
			isConnected.set(!!state?.connected);
			if (state?.selectedDirectory) selectedDirectory.set(state.selectedDirectory);
			if (state?.downloads) {
				const map: Record<string, DownloadItem> = {};
				for (const [id, d] of Object.entries(state.downloads)) {
					map[id] = { ...d, id };
				}
				downloads.set(map);
			}
		}).catch(() => {
			isConnected.set(false);
		});
	}

	sendDownloadRequest(url: string, fileName: string, baseDirectory?: string, threads: number = 8) {
		void chromeSend({ type: 'VELOCE_NEW_DOWNLOAD', payload: { url, fileName, baseDirectory, threads } });
	}

	pauseDownload(id: string) {
		void chromeSend({ type: 'VELOCE_CONTROL', action: 'PAUSE_DOWNLOAD', downloadId: id });
	}
	resumeDownload(id: string) {
		void chromeSend({ type: 'VELOCE_CONTROL', action: 'RESUME_DOWNLOAD', downloadId: id });
	}
	cancelDownload(id: string) {
		void chromeSend({ type: 'VELOCE_CONTROL', action: 'CANCEL_DOWNLOAD', downloadId: id });
	}
	removeDownload(id: string) {
		void chromeSend({ type: 'VELOCE_CONTROL', action: 'REMOVE_DOWNLOAD', downloadId: id });
	}

	requestDirectoryPicker() {
		void chromeSend({ type: 'VELOCE_DIRECTORY_PICKER' });
	}

	setInterceptEnabled(enabled: boolean) {
		interceptEnabled.set(enabled);
		if (hasChrome) chrome.storage.local.set({ veloce_intercept: enabled });
	}
}

export const wsClient = new VeloceWebSocketClient();
