// Persistent WebSocket to the local Veloce coordinator.
// MV3 service workers suspend after ~30s; this offscreen document stays alive
// while the browser is open so the link does not flap disconnect/connect.

const WS_URL = 'ws://127.0.0.1:14921/ws';
const RECONNECT_MS = 2000;
const PING_MS = 25000;
/** Delay CLOSE notify so a fast reconnect does not flash "disconnected" in the UI/logs. */
const CLOSE_NOTIFY_MS = 2500;

let ws = null;
let reconnectTimer = null;
let pingTimer = null;
let closeNotifyTimer = null;
let connectGen = 0;

function audit(_event, _detail = '') {
	/* no-op — intercept logs live in background/content */
}

function notify(type, extra = {}) {
	try {
		chrome.runtime.sendMessage({ type, ...extra });
	} catch { /* background may be asleep */ }
}

function cancelCloseNotify() {
	if (closeNotifyTimer) {
		clearTimeout(closeNotifyTimer);
		closeNotifyTimer = null;
	}
}

function scheduleCloseNotify() {
	cancelCloseNotify();
	closeNotifyTimer = setTimeout(() => {
		closeNotifyTimer = null;
		if (ws?.readyState !== WebSocket.OPEN) {
			audit('WS_CLOSE_NOTIFY');
			notify('VELOCE_WS_CLOSE');
		}
	}, CLOSE_NOTIFY_MS);
}

function stopPing() {
	if (pingTimer) {
		clearInterval(pingTimer);
		pingTimer = null;
	}
}

function startPing() {
	stopPing();
	pingTimer = setInterval(() => {
		if (ws?.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify({ type: 'PING' }));
			} catch { /* ignore */ }
		}
	}, PING_MS);
}

function scheduleReconnect() {
	clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(connect, RECONNECT_MS);
}

function connect() {
	if (ws?.readyState === WebSocket.OPEN) return;
	if (ws?.readyState === WebSocket.CONNECTING) return;
	if (ws?.readyState === WebSocket.CLOSING) return;

	const gen = ++connectGen;
	audit('WS_CONNECTING', `gen=${gen}`);

	try {
		ws = new WebSocket(WS_URL);
	} catch (e) {
		audit('WS_CONNECT_ERR', String(e));
		scheduleReconnect();
		return;
	}

	ws.onopen = () => {
		if (gen !== connectGen) return;
		cancelCloseNotify();
		audit('WS_OPEN', `gen=${gen}`);
		notify('VELOCE_WS_OPEN');
		startPing();
	};

	ws.onmessage = (event) => {
		if (gen !== connectGen) return;
		notify('VELOCE_WS_MSG', { data: event.data });
	};

	ws.onclose = (ev) => {
		if (gen !== connectGen) return;
		audit('WS_ONCLOSE', `gen=${gen} code=${ev.code}`);
		ws = null;
		stopPing();
		scheduleCloseNotify();
		scheduleReconnect();
	};

	ws.onerror = () => {
		audit('WS_ERROR', `gen=${gen}`);
		try { ws?.close(); } catch { /* ignore */ }
	};
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (msg.type === 'VELOCE_WS_ENSURE' || msg.type === 'VELOCE_WS_CONNECT') {
		if (ws?.readyState === WebSocket.OPEN) {
			sendResponse({ ok: true, ready: true, skipped: true });
			return true;
		}
		if (ws?.readyState === WebSocket.CONNECTING) {
			sendResponse({ ok: true, ready: false, connecting: true });
			return true;
		}
		connect();
		sendResponse({ ok: true, ready: false });
		return true;
	}
	if (msg.type === 'VELOCE_WS_SEND' && msg.payload) {
		if (ws?.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify(msg.payload));
				sendResponse({ ok: true, ready: true });
			} catch {
				sendResponse({ ok: false, ready: false });
			}
		} else {
			connect();
			sendResponse({ ok: false, ready: false, connecting: ws?.readyState === WebSocket.CONNECTING });
		}
		return true;
	}
	if (msg.type === 'VELOCE_WS_STATUS') {
		sendResponse({
			ok: true,
			ready: ws?.readyState === WebSocket.OPEN,
			state: ws?.readyState ?? 3
		});
		return true;
	}
	return false;
});

connect();
