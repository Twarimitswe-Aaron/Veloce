import { writable } from 'svelte/store';

export const isConnected = writable(false);

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
}

export const wsClient = new VeloceWebSocketClient();
