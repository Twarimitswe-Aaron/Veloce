// Veloce background service worker — sole owner of the WebSocket to the Local Coordinator.
// Popup and content scripts route through here so only one connection exists.

const WS_URL = 'ws://localhost:14921/ws';
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

let ws = null;
let connected = false;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
let wsPingTimer = null;
const livePorts = new Set();
const downloads = {};
let selectedDirectory = null;
let settings = null;
const pendingFormatRequests = new Map(); // requestId -> { sendResponse, url? }
const NOTIF_ICON = 'icons/icon-128.png';

const FORMAT_CACHE_TTL_MS = 10 * 60 * 1000;
const formatCache = new Map(); // url -> { formats, ts }
const inflightFormatUrls = new Set();
const prefetchQueue = [];
const prefetchQueued = new Set();
let prefetchRunning = 0;
const PREFETCH_LIMIT = 1;
const PREFETCH_QUEUE_MAX = 8;
const WS_PING_MS = 50000;

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

function notifyFormatFailed(url) {
	broadcastToExtension({ type: 'VELOCE_FORMATS_FAILED', url });
}

function drainPrefetchQueue() {
	if (!hasLiveClients()) return;
	connectWs();
	while (prefetchRunning < PREFETCH_LIMIT && prefetchQueue.length > 0) {
		const url = prefetchQueue.shift();
		prefetchQueued.delete(url);
		if (!url || getFormatCache(url) || inflightFormatUrls.has(url)) continue;
		prefetchRunning++;
		void requestFormatsFromCoordinator(url, (data) => {
			prefetchRunning--;
			if (data.formats?.length) setFormatCache(url, data.formats);
			else notifyFormatFailed(url);
			drainPrefetchQueue();
		});
	}
}

function enqueuePrefetch(url, front = false) {
	if (!url || getFormatCache(url) || inflightFormatUrls.has(url) || prefetchQueued.has(url)) return;
	if (!front && prefetchQueue.length >= PREFETCH_QUEUE_MAX) return;
	prefetchQueued.add(url);
	if (front) prefetchQueue.unshift(url);
	else prefetchQueue.push(url);
	drainPrefetchQueue();
}

function prefetchFormats(url) {
	enqueuePrefetch(url);
}

function prefetchBatch(urls) {
	connectWs();
	if (!Array.isArray(urls) || !urls.length) return;
	for (const item of urls) {
		const url = typeof item === 'string' ? item : item?.url;
		const front = typeof item === 'object' && item?.priority;
		if (url) enqueuePrefetch(url, front);
	}
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

function notify(id, title, message) {
	if (!chrome.notifications) return;
	try {
		chrome.notifications.create(id, {
			type: 'basic',
			iconUrl: NOTIF_ICON,
			title,
			message: String(message ?? '').slice(0, 300)
		});
	} catch { /* notifications may be unavailable */ }
}

function setConnected(val) {
	if (connected === val) return;
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
		case 'DOWNLOAD_COMPLETED': {
			const name = downloads[data.downloadId]?.fileName ?? 'Download';
			upsertDownload(data.downloadId, { status: data.status ?? 'completed', speedBps: 0, etaSecs: 0 });
			notify(`veloce-done-${data.downloadId}`, 'Download complete', name);
			break;
		}
		case 'DOWNLOAD_PAUSED':
			upsertDownload(data.downloadId, { status: 'paused', speedBps: 0, etaSecs: 0 });
			break;
		case 'DOWNLOAD_REMOVED':
			delete downloads[data.downloadId];
			broadcastToExtension({ type: 'VELOCE_DOWNLOAD_REMOVED', downloadId: data.downloadId });
			break;
		case 'DOWNLOAD_ERROR': {
			const name = downloads[data.downloadId]?.fileName ?? 'Download';
			upsertDownload(data.downloadId, {
				status: 'error',
				error: data.error ?? 'Download failed',
				speedBps: 0,
				etaSecs: 0
			});
			notify(`veloce-err-${data.downloadId ?? Date.now()}`, 'Download failed', `${name}: ${data.error ?? 'Unknown error'}`);
			break;
		}
		case 'SETTINGS':
			settings = data.settings ?? null;
			broadcastToExtension({ type: 'VELOCE_SETTINGS', settings });
			break;
		case 'PLAYLIST_QUEUED':
			notify(`veloce-pl-${Date.now()}`, 'Playlist queued', `${data.count}/${data.total} items added to Veloce.`);
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

function hasLiveClients() {
	return livePorts.size > 0;
}

function stopWsPing() {
	if (wsPingTimer) {
		clearInterval(wsPingTimer);
		wsPingTimer = null;
	}
}

function startWsPing() {
	stopWsPing();
	wsPingTimer = setInterval(() => {
		if (ws?.readyState === WebSocket.OPEN) {
			wsSend({ type: 'PING' });
		}
	}, WS_PING_MS);
}

function scheduleWsReconnect() {
	clearTimeout(reconnectTimer);
	const delay = hasLiveClients() ? 400 : reconnectDelay;
	reconnectTimer = setTimeout(() => {
		connectWs();
		if (!hasLiveClients()) {
			reconnectDelay = Math.min(Math.round(reconnectDelay * 1.5), RECONNECT_MAX_MS);
		}
	}, delay);
}

function connectWs() {
	if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
	if (ws?.readyState === WebSocket.CLOSING) return;

	ws = new WebSocket(WS_URL);

	ws.onopen = () => {
		reconnectDelay = RECONNECT_BASE_MS;
		setConnected(true);
		startWsPing();
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
		stopWsPing();
		setConnected(false);
		scheduleWsReconnect();
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

	// User click — jump the queue for this URL.
	enqueuePrefetch(url, true);
	await waitForInflightFormats(url);
	cached = getFormatCache(url);
	if (cached?.length) {
		sendResponse({ type: 'FORMATS_LIST', formats: cached, cached: true });
		return;
	}

	await requestFormatsFromCoordinator(url, sendResponse);
}

function scheduleKeepaliveAlarm() {
	chrome.alarms.create('veloce-keepalive', { periodInMinutes: 3 });
}

const BROWSER_ONLY_URL = /^(blob:|data:|mediastream:)/i;

function extFromMime(mime) {
	const m = (mime || '').toLowerCase().split(';')[0].trim();
	const map = {
		'image/png': '.png',
		'image/jpeg': '.jpg',
		'image/jpg': '.jpg',
		'image/webp': '.webp',
		'image/gif': '.gif',
		'image/svg+xml': '.svg',
		'application/pdf': '.pdf'
	};
	return map[m] || '.bin';
}

/** Parse a data: URL in the service worker (no tab required). */
function parseDataUrl(url) {
	try {
		const m = url.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
		if (!m) return null;
		const mime = m[1] || 'application/octet-stream';
		const payload = m[3];
		const base64 = m[2] ? payload.replace(/\s/g, '') : btoa(decodeURIComponent(payload));
		return { base64, mime, size: Math.ceil(base64.length * 0.75) };
	} catch {
		return null;
	}
}

/** Fetch blob bytes from the page context (MAIN world can read page blob URLs). */
async function materializeBlobUrl(tabId, blobUrl) {
	if (tabId == null || tabId < 0) return null;

	const fetchInPage = async (u) => {
		const res = await fetch(u);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const blob = await res.blob();
		const buf = await blob.arrayBuffer();
		const bytes = new Uint8Array(buf);
		let binary = '';
		const chunk = 8192;
		for (let i = 0; i < bytes.length; i += chunk) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
		}
		return {
			base64: btoa(binary),
			mime: blob.type || 'application/octet-stream',
			size: bytes.length
		};
	};

	try {
		const results = await chrome.scripting.executeScript({
			target: { tabId },
			world: 'MAIN',
			func: fetchInPage,
			args: [blobUrl]
		});
		if (results?.[0]?.result?.base64) return results[0].result;
	} catch (e) {
		console.warn('[Veloce] MAIN-world blob fetch failed, trying content script', e);
	}

	return new Promise((resolve) => {
		chrome.tabs.sendMessage(tabId, { type: 'VELOCE_FETCH_BLOB', url: blobUrl }, (resp) => {
			if (chrome.runtime.lastError || !resp?.ok) resolve(null);
			else resolve(resp);
		});
	});
}

async function startBlobDownload({ base64, mime, fileName, baseDirectory, sourceUrl, pageUrl }) {
	const ok = await ensureConnected();
	if (!ok) {
		console.error('[Veloce] Cannot save blob — coordinator offline');
		return false;
	}
	let name = fileName || 'download';
	if (!/\.\w{2,5}$/.test(name) && mime) {
		name = name.replace(/\.\w+$/, '') + extFromMime(mime);
	}
	return wsSend({
		type: 'SAVE_BLOB',
		payload: {
			base64,
			mime,
			fileName: name,
			baseDirectory,
			sourceUrl: sourceUrl || pageUrl || 'blob:browser',
			pageUrl
		}
	});
}

// ── Intercept native browser downloads when coordinator is online ─────────────
chrome.downloads.onCreated.addListener(async (item) => {
	if (!connected) return;
	const { veloce_intercept } = await chrome.storage.local.get('veloce_intercept');
	if (veloce_intercept === false) return;

	const url = item.url || item.finalUrl;
	if (!url) return;

	const { veloce_base_dir } = await chrome.storage.local.get('veloce_base_dir');
	const baseDirectory = veloce_base_dir || selectedDirectory || undefined;
	const pageUrl = item.referrer || undefined;

	let fileName = item.filename || '';
	if (!fileName) {
		try {
			const parts = new URL(url).pathname.split('/').filter(Boolean);
			fileName = parts.pop() || 'download';
		} catch {
			fileName = 'download';
		}
	}

	// blob:/data: URLs only exist in the browser — materialize bytes before cancelling.
	if (BROWSER_ONLY_URL.test(url)) {
		let materialized = null;
		if (url.startsWith('data:')) {
			materialized = parseDataUrl(url);
		} else if (url.startsWith('blob:')) {
			materialized = await materializeBlobUrl(item.tabId, url);
		}
		if (!materialized?.base64) {
			console.warn('[Veloce] Could not read blob/data URL — leaving native download alone');
			return; // do not cancel; browser keeps the download
		}
		try {
			await chrome.downloads.cancel(item.id);
		} catch (e) {
			console.warn('[Veloce] Could not cancel native download', e);
		}
		await startBlobDownload({
			base64: materialized.base64,
			mime: materialized.mime,
			fileName,
			baseDirectory,
			sourceUrl: url,
			pageUrl
		});
		return;
	}

	try {
		await chrome.downloads.cancel(item.id);
	} catch (e) {
		console.warn('[Veloce] Could not cancel native download', e);
	}

	startDownload({
		url,
		fileName,
		baseDirectory,
		threads: 8
	});
});

// ── Messages from popup & content scripts ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	switch (msg.type) {
		case 'VELOCE_CONNECT':
			(async () => {
				await ensureConnected();
				sendResponse({ connected, downloads, selectedDirectory, settings });
			})();
			return true;

		case 'VELOCE_GET_STATE':
			(async () => {
				await ensureConnected(3000);
				sendResponse({ connected, downloads, selectedDirectory, settings });
			})();
			return true;

		case 'VELOCE_SET_SETTINGS':
			(async () => {
				await ensureConnected();
				sendResponse({ ok: wsSend({ type: 'SET_SETTINGS', payload: msg.payload }) });
			})();
			return true;

		case 'VELOCE_GET_SETTINGS':
			(async () => {
				await ensureConnected();
				sendResponse({ ok: wsSend({ type: 'GET_SETTINGS' }) });
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

		case 'VELOCE_PREFETCH_BATCH':
			prefetchBatch(msg.urls);
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

function setupContextMenus() {
	if (!chrome.contextMenus) return;
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: 'veloce-download-link',
			title: 'Download link with Veloce',
			contexts: ['link']
		});
		chrome.contextMenus.create({
			id: 'veloce-download-media',
			title: 'Download media with Veloce',
			contexts: ['image', 'video', 'audio']
		});
		chrome.contextMenus.create({
			id: 'veloce-download-page-links',
			title: 'Download all media links on page',
			contexts: ['page']
		});
	});
}

async function downloadFromContext(url) {
	if (!url) return;
	let fileName = 'download';
	try {
		const parts = new URL(url).pathname.split('/').filter(Boolean);
		fileName = parts.pop() || 'download';
	} catch { /* keep default */ }
	const { veloce_base_dir } = await chrome.storage.local.get('veloce_base_dir');
	startDownload({ url, fileName, baseDirectory: veloce_base_dir || selectedDirectory || undefined, threads: 8 });
}

if (chrome.contextMenus) {
	chrome.contextMenus.onClicked.addListener(async (info, tab) => {
		if (info.menuItemId === 'veloce-download-link') {
			await downloadFromContext(info.linkUrl);
		} else if (info.menuItemId === 'veloce-download-media') {
			await downloadFromContext(info.srcUrl || info.linkUrl);
		} else if (info.menuItemId === 'veloce-download-page-links' && tab?.id != null) {
			try {
				const results = await chrome.scripting.executeScript({
					target: { tabId: tab.id },
					func: () => {
						const re = /\.(mp4|mkv|webm|avi|mov|m4v|mp3|wav|flac|ogg|m4a|zip|rar|7z|tar|gz|bz2|pdf|iso)(\?|#|$)/i;
						return Array.from(document.querySelectorAll('a[href]'))
							.map((a) => a.href)
							.filter((h) => /^https?:/i.test(h) && re.test(h));
					}
				});
				const urls = [...new Set((results?.[0]?.result) || [])];
				for (const u of urls) await downloadFromContext(u);
				notify(`veloce-pagelinks-${Date.now()}`, 'Veloce', `Queued ${urls.length} link(s) from the page.`);
			} catch (e) {
				console.warn('[Veloce] page-links scan failed', e);
			}
		}
	});
}

chrome.runtime.onInstalled.addListener(() => {
	chrome.storage.local.set({ veloce_intercept: true });
	scheduleKeepaliveAlarm();
	setupContextMenus();
	connectWs();
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === 'veloce-keepalive' && hasLiveClients()) connectWs();
});

chrome.runtime.onConnect.addListener((port) => {
	if (!['veloce-popup', 'veloce-busy', 'veloce-tab'].includes(port.name)) return;

	livePorts.add(port);
	connectWs();
	drainPrefetchQueue();

	port.onMessage.addListener((msg) => {
		if (msg?.type === 'ping') {
			try { port.postMessage({ type: 'pong', connected }); } catch { /* ignore */ }
		}
	});

	port.onDisconnect.addListener(() => {
		livePorts.delete(port);
		if (hasLiveClients()) connectWs();
	});
});

chrome.tabs.onRemoved.addListener(() => {
	// Ports disconnect asynchronously; ensure WS stays up for remaining tabs.
	if (hasLiveClients()) connectWs();
});

scheduleKeepaliveAlarm();
connectWs();
