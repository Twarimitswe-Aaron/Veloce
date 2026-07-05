import { v as writable } from "./index-server.js";
import "./index-server2.js";
//#region src/lib/wsClient.ts
var isConnected = writable(false);
var selectedDirectory = writable(null);
var pickerError = writable(null);
var interceptEnabled = writable(true);
var settings = writable(null);
var downloads = writable({});
var orderSeq = 0;
var orderById = /* @__PURE__ */ new Map();
function orderFor(id) {
	let o = orderById.get(id);
	if (o === void 0) {
		o = orderSeq++;
		orderById.set(id, o);
	}
	return o;
}
/** Rebuild the store from a backend snapshot while preserving stable per-id order. */
function setDownloadsFromSnapshot(entries) {
	const map = {};
	for (const [id, d] of Object.entries(entries)) map[id] = {
		...d,
		id,
		order: orderFor(id)
	};
	downloads.set(map);
}
function upsertDownload(id, patch) {
	downloads.update((map) => {
		const prev = map[id] ?? {
			id,
			fileName: "Unknown file",
			status: "queued",
			downloaded: 0,
			total: 0,
			speedBps: 0,
			etaSecs: 0,
			updatedAt: Date.now(),
			order: orderFor(id)
		};
		return {
			...map,
			[id]: {
				...prev,
				...patch,
				order: prev.order,
				updatedAt: Date.now()
			}
		};
	});
}
var hasChrome = typeof chrome !== "undefined" && !!chrome.runtime?.id;
function chromeSend(msg) {
	return new Promise((resolve, reject) => {
		if (!hasChrome) {
			reject(/* @__PURE__ */ new Error("Not in extension context"));
			return;
		}
		chrome.runtime.sendMessage(msg, (resp) => {
			if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
			else resolve(resp);
		});
	});
}
/** Popup talks to the coordinator only through the background service worker (single WS). */
var VeloceWebSocketClient = class {
	keepalivePort = null;
	listening = false;
	handleRuntimeMessage(msg) {
		switch (msg.type) {
			case "VELOCE_STATE":
				isConnected.set(!!msg.connected);
				if (msg.selectedDirectory !== void 0) selectedDirectory.set(msg.selectedDirectory ?? null);
				if (msg.downloads && typeof msg.downloads === "object") setDownloadsFromSnapshot(msg.downloads);
				break;
			case "VELOCE_DOWNLOAD_UPDATE":
				if (msg.download) {
					const d = msg.download;
					upsertDownload(d.id, d);
				}
				break;
			case "VELOCE_DOWNLOAD_REMOVED":
				if (msg.downloadId) downloads.update((m) => {
					const next = { ...m };
					delete next[msg.downloadId];
					return next;
				});
				break;
			case "VELOCE_DIRECTORY":
				pickerError.set(null);
				selectedDirectory.set(msg.path ?? null);
				break;
			case "VELOCE_PICKER_ERROR":
				pickerError.set(msg.error ?? "Folder picker unavailable.");
				break;
			case "VELOCE_SETTINGS":
				if (msg.settings) settings.set(msg.settings);
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
			this.keepalivePort = chrome.runtime.connect({ name: "veloce-popup" });
		} catch {}
		chrome.storage.local.get([
			"veloce_intercept",
			"veloce_base_dir",
			"veloce_connected"
		], (r) => {
			interceptEnabled.set(r.veloce_intercept !== false);
			if (r.veloce_base_dir) selectedDirectory.set(r.veloce_base_dir);
			isConnected.set(!!r.veloce_connected);
		});
		chromeSend({ type: "VELOCE_CONNECT" }).then((state) => {
			isConnected.set(!!state?.connected);
			if (state?.selectedDirectory) selectedDirectory.set(state.selectedDirectory);
			if (state?.downloads) setDownloadsFromSnapshot(state.downloads);
			if (state?.settings) settings.set(state.settings);
		}).catch(() => {
			isConnected.set(false);
		});
	}
	sendDownloadRequest(url, fileName, baseDirectory, threads = 8, playlist = false) {
		chromeSend({
			type: "VELOCE_NEW_DOWNLOAD",
			payload: {
				url,
				fileName,
				baseDirectory,
				threads,
				playlist
			}
		});
	}
	pauseDownload(id) {
		chromeSend({
			type: "VELOCE_CONTROL",
			action: "PAUSE_DOWNLOAD",
			downloadId: id
		});
	}
	resumeDownload(id) {
		chromeSend({
			type: "VELOCE_CONTROL",
			action: "RESUME_DOWNLOAD",
			downloadId: id
		});
	}
	cancelDownload(id) {
		chromeSend({
			type: "VELOCE_CONTROL",
			action: "CANCEL_DOWNLOAD",
			downloadId: id
		});
	}
	removeDownload(id) {
		chromeSend({
			type: "VELOCE_CONTROL",
			action: "REMOVE_DOWNLOAD",
			downloadId: id
		});
	}
	openFile(id) {
		chromeSend({
			type: "VELOCE_CONTROL",
			action: "OPEN_FILE",
			downloadId: id
		});
	}
	revealFile(id) {
		chromeSend({
			type: "VELOCE_CONTROL",
			action: "REVEAL_FILE",
			downloadId: id
		});
	}
	requestDirectoryPicker() {
		chromeSend({ type: "VELOCE_DIRECTORY_PICKER" });
	}
	setInterceptEnabled(enabled) {
		interceptEnabled.set(enabled);
		if (hasChrome) chrome.storage.local.set({ veloce_intercept: enabled });
	}
	updateSettings(patch) {
		chromeSend({
			type: "VELOCE_SET_SETTINGS",
			payload: patch
		});
	}
};
var wsClient = new VeloceWebSocketClient();
//#endregion
export { wsClient as a, pickerError as i, interceptEnabled as n, isConnected as r, downloads as t };
