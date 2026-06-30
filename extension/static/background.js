// Veloce background service worker — sole owner of the WebSocket to the Local Coordinator.
// Popup and content scripts route through here so only one connection exists.

const WS_URL = 'ws://localhost:14921/ws';
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

let ws = null;
let connected = false;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
const downloads = {};
let selectedDirectory = null;
const pendingFormatRequests = new Map(); // requestId -> { sendResponse, url? }

const FORMAT_CACHE_TTL_MS = 10 * 60 * 1000;
const formatCache = new Map(); // url -> { formats, ts }
const inflightFormatUrls = new Set();

function getFormatCache(url) {
	const hit = formatCache.get(url);
	if (hit && Date.now() - hit.ts < FORMAT_CACHE_TTL_MS) return hit.formats;
	return null;
}

function setFormatCache(url, formats) {
	if (formats?.length) {
		formatCache.set(url, { formats, ts: Date.now() });
		broadcastToExtension({ type: 'VELOCE_FORMATS_READY', url, formats });
	}
}

function prefetchFormats(url) {
	connectWs();
	if (!url || getFormatCache(url) || inflightFormatUrls.has(url)) return;
	void requestFormatsFromCoordinator(url, (data) => {
		if (data.formats?.length) setFormatCache(url, data.formats);
	});
}

async function waitForInflightFormats(url, maxMs = 25000) {
	if (!inflightFormatUrls.has(url)) return getFormatCache(url);
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		const hit = getFormatCache(url);
		if (hit?.length) return hit;
		if (!inflightFormatUrls.has(url)) break;
		await new Promise((r) => setTimeout(r, 200));
	}
	return getFormatCache(url);
}

function broadcastToExtension(msg) {
	chrome.runtime.sendMessage(msg).catch(() => {});
}

function setConnected(val) {
	connected = val;
	chrome.storage.local.set({ veloce_connected: val });
	broadcastToExtension({ type: 'VELOCE_STATE', connected: val, downloads, selectedDirectory });
}

function upsertDownload(id, patch) {
	const prev = downloads[id] ?? {
		id,
		fileName: 'Unknown file',
		status: 'queued',
		downloaded: 0,
		total: 0,
		speedBps: 0,
		etaSecs: 0,
		updatedAt: Date.now()
	};
	downloads[id] = { ...prev, ...patch, updatedAt: Date.now() };
	broadcastToExtension({ type: 'VELOCE_DOWNLOAD_UPDATE', download: downloads[id] });
}

function handleWsMessage(data) {
	switch (data.type) {
		case 'DOWNLOAD_SNAPSHOT':
			if (Array.isArray(data.downloads)) {
				for (const d of data.downloads) {
					upsertDownload(d.downloadId, {
						fileName: d.fileName ?? 'Unknown file',
						status: d.status ?? 'queued',
						downloaded: d.downloaded ?? 0,
						total: d.total ?? 0,
						speedBps: 0,
						etaSecs: 0
					});
				}
			}
			break;
		case 'DOWNLOAD_ACK':
			upsertDownload(data.downloadId, { fileName: data.fileName, status: data.status ?? 'queued' });
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
			upsertDownload(data.downloadId, { status: data.status ?? 'completed', speedBps: 0, etaSecs: 0 });
			break;
		case 'DOWNLOAD_PAUSED':
			upsertDownload(data.downloadId, { status: 'paused', speedBps: 0, etaSecs: 0 });
			break;
		case 'DOWNLOAD_REMOVED':
			delete downloads[data.downloadId];
			broadcastToExtension({ type: 'VELOCE_DOWNLOAD_REMOVED', downloadId: data.downloadId });
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
			selectedDirectory = data.payload?.path ?? null;
			if (selectedDirectory) chrome.storage.local.set({ veloce_base_dir: selectedDirectory });
			broadcastToExtension({ type: 'VELOCE_DIRECTORY', path: selectedDirectory });
			break;
		case 'DIRECTORY_PICKER_UNAVAILABLE':
			broadcastToExtension({ type: 'VELOCE_PICKER_ERROR', error: data.error });
			break;
		case 'FORMATS_LIST':
		case 'FORMATS_ERROR': {
			const pending = pendingFormatRequests.get(data.requestId);
			if (pending) {
				pendingFormatRequests.delete(data.requestId);
				if (pending.url) inflightFormatUrls.delete(pending.url);
				if (data.type === 'FORMATS_LIST' && pending.url && data.formats?.length) {
					setFormatCache(pending.url, data.formats);
				}
				pending.sendResponse(data);
			}
			break;
		}
	}
}

function connectWs() {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
		return;
	}

	ws = new WebSocket(WS_URL);

	ws.onopen = () => {
		reconnectDelay = RECONNECT_BASE_MS;
		setConnected(true);
	};

	ws.onmessage = (event) => {
		try {
			handleWsMessage(JSON.parse(event.data));
		} catch (e) {
			console.error('[Veloce] Bad WS message', e);
		}
	};

	ws.onclose = () => {
		ws = null;
		setConnected(false);
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(() => {
			connectWs();
			reconnectDelay = Math.min(Math.round(reconnectDelay * 1.5), RECONNECT_MAX_MS);
		}, reconnectDelay);
	};

	ws.onerror = () => ws?.close();
}

function ensureConnected(maxWaitMs = 3000) {
	return new Promise((resolve) => {
		if (ws?.readyState === WebSocket.OPEN) {
			resolve(true);
			return;
		}
		connectWs();
		const start = Date.now();
		const poll = () => {
			if (ws?.readyState === WebSocket.OPEN) resolve(true);
			else if (Date.now() - start >= maxWaitMs) resolve(false);
			else setTimeout(poll, 80);
		};
		poll();
	});
}

function wsSend(obj) {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(obj));
		return true;
	}
	return false;
}

async function startDownload(payload) {
	const ok = await ensureConnected();
	if (!ok || !wsSend({ type: 'NEW_DOWNLOAD', payload })) {
		console.error('[Veloce] Cannot download — coordinator offline');
		return false;
	}
	return true;
}

async function requestFormatsFromCoordinator(url, sendResponse) {
	const ok = await ensureConnected(2500);
	if (!ok) {
		sendResponse({ type: 'FORMATS_ERROR', error: 'Local Coordinator offline' });
		return;
	}

	const requestId = crypto.randomUUID();
	inflightFormatUrls.add(url);
	pendingFormatRequests.set(requestId, { sendResponse, url });
	if (!wsSend({ type: 'LIST_FORMATS', requestId, payload: { url } })) {
		inflightFormatUrls.delete(url);
		pendingFormatRequests.delete(requestId);
		sendResponse({ type: 'FORMATS_ERROR', error: 'Local Coordinator offline' });
		return;
	}
	setTimeout(() => {
		if (pendingFormatRequests.has(requestId)) {
			inflightFormatUrls.delete(url);
			pendingFormatRequests.delete(requestId);
			sendResponse({ type: 'FORMATS_ERROR', error: 'Format list timed out' });
		}
	}, 50000);
}

async function listFormats(url, sendResponse, sender) {
	let cached = getFormatCache(url);
	if (!cached?.length) {
		cached = await waitForInflightFormats(url);
	}
	if (cached?.length) {
		sendResponse({ type: 'FORMATS_LIST', formats: cached, cached: true });
		return;
	}

	await requestFormatsFromCoordinator(url, sendResponse);
}

function scheduleKeepaliveAlarm() {
	chrome.alarms.create('veloce-keepalive', { periodInMinutes: 1 });
}

// ── Intercept native browser downloads when coordinator is online ─────────────
chrome.downloads.onCreated.addListener(async (item) => {
	if (!connected) return;
	const { veloce_intercept } = await chrome.storage.local.get('veloce_intercept');
	if (veloce_intercept === false) return;

	try {
		await chrome.downloads.cancel(item.id);
	} catch (e) {
		console.warn('[Veloce] Could not cancel native download', e);
	}

	const url = item.url || item.finalUrl;
	if (!url) return;

	let fileName = item.filename || '';
	if (!fileName) {
		try {
			const parts = new URL(url).pathname.split('/').filter(Boolean);
			fileName = parts.pop() || 'download';
		} catch {
			fileName = 'download';
		}
	}

	const { veloce_base_dir } = await chrome.storage.local.get('veloce_base_dir');
	startDownload({
		url,
		fileName,
		baseDirectory: veloce_base_dir || selectedDirectory || undefined,
		threads: 8
	});
});

// ── Messages from popup & content scripts ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	switch (msg.type) {
		case 'VELOCE_CONNECT':
			(async () => {
				await ensureConnected();
				sendResponse({ connected, downloads, selectedDirectory });
			})();
			return true;

		case 'VELOCE_GET_STATE':
			(async () => {
				await ensureConnected(3000);
				sendResponse({ connected, downloads, selectedDirectory });
			})();
			return true;

		case 'VELOCE_NEW_DOWNLOAD':
			(async () => {
				sendResponse({ ok: await startDownload(msg.payload) });
			})();
			return true;

		case 'VELOCE_LIST_FORMATS':
			listFormats(msg.url, sendResponse, _sender);
			return true;

		case 'VELOCE_PREFETCH_FORMATS':
			prefetchFormats(msg.url);
			return false;

		case 'VELOCE_WARMUP':
			connectWs();
			return false;

		case 'VELOCE_CONTROL':
			(async () => {
				await ensureConnected();
				sendResponse({ ok: wsSend({ type: msg.action, downloadId: msg.downloadId }) });
			})();
			return true;

		case 'VELOCE_DIRECTORY_PICKER':
			(async () => {
				await ensureConnected();
				sendResponse({ ok: wsSend({ type: 'REQUEST_DIRECTORY_PICKER' }) });
			})();
			return true;

		default:
			return false;
	}
});

chrome.runtime.onInstalled.addListener(() => {
	chrome.storage.local.set({ veloce_intercept: true });
	scheduleKeepaliveAlarm();
	connectWs();
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === 'veloce-keepalive') connectWs();
});

chrome.runtime.onConnect.addListener((port) => {
	if (port.name === 'veloce-popup' || port.name === 'veloce-busy') {
		connectWs();
	}
});

scheduleKeepaliveAlarm();
connectWs();
