import { writable } from 'svelte/store';

export const isConnected = writable(false);
export const selectedDirectory = writable<string | null>(null);

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
				
				if (data.type === 'DOWNLOAD_ACK') {
					console.log(`✅ Successfully queued download ID: ${data.downloadId}`);
				} else if (data.type === 'DIRECTORY_SELECTED') {
					console.log(`📁 User selected directory: ${data.payload.path}`);
					selectedDirectory.set(data.payload.path);
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

	sendDownloadRequest(url: string, fileName: string, baseDirectory?: string) {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({
				type: 'NEW_DOWNLOAD',
				payload: { url, fileName, baseDirectory }
			}));
			console.log(`[Veloce Extension] Sent download request for: ${fileName}`);
		} else {
			console.error('[Veloce Extension] Cannot send request, Local Coordinator is disconnected.');
		}
	}

	requestDirectoryPicker() {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({
				type: 'REQUEST_DIRECTORY_PICKER'
			}));
			console.log(`[Veloce Extension] Requested native directory picker`);
		} else {
			console.error('[Veloce Extension] Cannot request directory picker, Local Coordinator is disconnected.');
		}
	}
}

export const wsClient = new VeloceWebSocketClient();
