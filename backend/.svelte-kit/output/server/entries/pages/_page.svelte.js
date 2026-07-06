import { n as onDestroy } from "../../chunks/index-server.js";
import { b as attr, i as ensure_array_like, n as attr_style, r as derived, s as stringify, t as attr_class, x as escape_html } from "../../chunks/server.js";
//#region src/routes/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let connected = false;
		let baseDir = "";
		let items = {};
		let orderSeq = 0;
		let url = "";
		let fileName = "";
		let asPlaylist = false;
		let sMaxConcurrent = 10;
		let sDefaultThreads = 8;
		let sMaxRateMB = 0;
		let sEngineQuiet = true;
		let plMediaType = "audio";
		let plVideoQuality = "720";
		let plAudioFallback = "video";
		let ws = null;
		let reconnectTimer = null;
		const list = derived(() => Object.values(items).sort((a, b) => a.order - b.order));
		function upsert(id, patch) {
			const prev = items[id] ?? {
				id,
				fileName: "Unknown",
				status: "queued",
				downloaded: 0,
				total: 0,
				speedBps: 0,
				etaSecs: 0,
				order: orderSeq++
			};
			items = {
				...items,
				[id]: {
					...prev,
					...patch,
					order: prev.order
				}
			};
		}
		function handle(data) {
			switch (data.type) {
				case "DIRECTORY_SELECTED":
					baseDir = data.payload?.path ?? baseDir;
					break;
				case "SETTINGS":
					if (data.settings) {
						sMaxConcurrent = data.settings.maxConcurrentDownloads;
						sDefaultThreads = data.settings.defaultThreads;
						sMaxRateMB = Math.round(data.settings.maxRateBytes / 1048576 * 10) / 10;
						sEngineQuiet = data.settings.engineQuiet;
						if (data.settings.baseDirectory) baseDir = data.settings.baseDirectory;
						if (data.settings.playlistFormats) {
							plMediaType = data.settings.playlistFormats.mediaType;
							plVideoQuality = data.settings.playlistFormats.videoQuality;
							plAudioFallback = data.settings.playlistFormats.audioMissingFallback;
						}
					}
					break;
				case "DOWNLOAD_SNAPSHOT":
					for (const d of data.downloads ?? []) upsert(d.downloadId, {
						fileName: d.fileName,
						status: d.status,
						downloaded: d.downloaded ?? 0,
						total: d.total ?? 0
					});
					break;
				case "DOWNLOAD_ACK":
					upsert(data.downloadId, {
						fileName: data.fileName,
						status: data.status ?? "queued"
					});
					break;
				case "PROGRESS":
					upsert(data.downloadId, {
						status: "downloading",
						downloaded: data.downloaded ?? 0,
						total: data.total ?? 0,
						speedBps: data.speedBps ?? 0,
						etaSecs: data.etaSecs ?? 0
					});
					break;
				case "DOWNLOAD_COMPLETED":
					upsert(data.downloadId, {
						status: "completed",
						speedBps: 0,
						etaSecs: 0
					});
					break;
				case "DOWNLOAD_PAUSED":
					upsert(data.downloadId, {
						status: "paused",
						speedBps: 0,
						etaSecs: 0
					});
					break;
				case "DOWNLOAD_ERROR":
					upsert(data.downloadId, {
						status: "error",
						error: data.error,
						speedBps: 0,
						etaSecs: 0
					});
					break;
				case "DOWNLOAD_REMOVED": {
					const next = { ...items };
					delete next[data.downloadId];
					items = next;
					break;
				}
				case "PLAYLIST_QUEUED":
					if (data.playlistId) upsert(data.playlistId, {
						fileName: `${data.title || "Playlist"} (0/${data.total} tracks)`,
						status: "queued"
					});
					break;
				case "PLAYLIST_UPDATE":
					if (data.playlistId) upsert(data.playlistId, {
						fileName: data.fileName || "Playlist",
						status: data.status === "cancelled" ? "error" : data.status || "downloading",
						downloaded: data.downloaded ?? 0,
						total: data.totalBytes ?? 0,
						speedBps: data.speedBps ?? 0,
						etaSecs: data.etaSecs ?? 0,
						error: data.error
					});
					break;
				case "PLAYLIST_REMOVED": {
					const next = { ...items };
					delete next[data.playlistId];
					items = next;
					break;
				}
			}
		}
		function connect() {
			try {
				ws = new WebSocket(`ws://${location.host}/ws`);
			} catch {
				scheduleReconnect();
				return;
			}
			ws.onopen = () => {
				connected = true;
			};
			ws.onmessage = (e) => {
				try {
					handle(JSON.parse(e.data));
				} catch {}
			};
			ws.onclose = () => {
				connected = false;
				ws = null;
				scheduleReconnect();
			};
			ws.onerror = () => ws?.close();
		}
		function scheduleReconnect() {
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = setTimeout(connect, 2e3);
		}
		function pct(d) {
			return d.total ? Math.min(100, Math.round(d.downloaded / d.total * 100)) : 0;
		}
		function fmtBytes(n) {
			if (!n) return "0 B";
			const u = [
				"B",
				"KB",
				"MB",
				"GB"
			];
			const i = Math.floor(Math.log(n) / Math.log(1024));
			return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
		}
		function fmtEta(s) {
			if (!s || s <= 0) return "--";
			if (s < 60) return `${Math.round(s)}s`;
			if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
			return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
		}
		onDestroy(() => {
			if (reconnectTimer) clearTimeout(reconnectTimer);
			ws?.close();
		});
		$$renderer.push(`<div class="page svelte-1uha8ag"><header class="svelte-1uha8ag"><h1 class="svelte-1uha8ag">⚡ Veloce Dashboard</h1> <span${attr_class("status svelte-1uha8ag", void 0, { "online": connected })}>${escape_html(connected ? "Coordinator online" : "Coordinator offline")}</span></header> <section class="card svelte-1uha8ag"><h2 class="svelte-1uha8ag">New download</h2> <input placeholder="https://…"${attr("value", url)} class="svelte-1uha8ag"/> <input placeholder="Filename (optional)"${attr("value", fileName)} class="svelte-1uha8ag"/> <label class="chk svelte-1uha8ag"><input type="checkbox"${attr("checked", asPlaylist, true)} class="svelte-1uha8ag"/> Treat URL as a playlist (one job, uses settings below)</label> <button class="primary svelte-1uha8ag"${attr("disabled", !connected || true, true)}>Download</button> <p class="hint svelte-1uha8ag">Saving to <code class="svelte-1uha8ag">${escape_html(baseDir || "~/Downloads/Veloce")}</code></p></section> <section class="card svelte-1uha8ag"><h2 class="svelte-1uha8ag">Settings</h2> <div class="grid svelte-1uha8ag"><label class="svelte-1uha8ag">Max concurrent<input type="number" min="1" max="64"${attr("value", sMaxConcurrent)} class="svelte-1uha8ag"/></label> <label class="svelte-1uha8ag">Default connections<input type="number" min="1" max="64"${attr("value", sDefaultThreads)} class="svelte-1uha8ag"/></label> <label class="svelte-1uha8ag">Speed cap (MB/s, 0 = ∞)<input type="number" min="0" step="0.1"${attr("value", sMaxRateMB)} class="svelte-1uha8ag"/></label> <label class="chk svelte-1uha8ag"><input type="checkbox"${attr("checked", sEngineQuiet, true)} class="svelte-1uha8ag"/> Quiet engine</label></div> <div class="playlist-settings svelte-1uha8ag"><h3 class="svelte-1uha8ag">Playlist downloads</h3> <label class="svelte-1uha8ag">Media type `);
		$$renderer.select({
			value: plMediaType,
			class: ""
		}, ($$renderer) => {
			$$renderer.option({ value: "audio" }, ($$renderer) => {
				$$renderer.push(`Audio only (preferred)`);
			});
			$$renderer.option({ value: "video" }, ($$renderer) => {
				$$renderer.push(`Video with audio`);
			});
		}, "svelte-1uha8ag");
		$$renderer.push(`</label> <label class="svelte-1uha8ag">Video quality (when video or fallback) `);
		$$renderer.select({
			value: plVideoQuality,
			class: ""
		}, ($$renderer) => {
			$$renderer.option({ value: "1080" }, ($$renderer) => {
				$$renderer.push(`1080p (step down if missing)`);
			});
			$$renderer.option({ value: "720" }, ($$renderer) => {
				$$renderer.push(`720p (step down if missing)`);
			});
			$$renderer.option({ value: "480" }, ($$renderer) => {
				$$renderer.push(`480p (step down if missing)`);
			});
			$$renderer.option({ value: "360" }, ($$renderer) => {
				$$renderer.push(`360p`);
			});
			$$renderer.option({ value: "best" }, ($$renderer) => {
				$$renderer.push(`Best available`);
			});
		}, "svelte-1uha8ag");
		$$renderer.push(`</label> <label class="svelte-1uha8ag">If audio-only and no audio stream `);
		$$renderer.select({
			value: plAudioFallback,
			class: ""
		}, ($$renderer) => {
			$$renderer.option({ value: "video" }, ($$renderer) => {
				$$renderer.push(`Download video at quality above`);
			});
			$$renderer.option({ value: "skip" }, ($$renderer) => {
				$$renderer.push(`Skip track`);
			});
		}, "svelte-1uha8ag");
		$$renderer.push(`</label></div> <button class="primary svelte-1uha8ag"${attr("disabled", !connected, true)}>Save settings</button></section> <section class="card svelte-1uha8ag"><h2 class="svelte-1uha8ag">Queue (${escape_html(list().length)})</h2> `);
		if (list().length === 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<p class="hint svelte-1uha8ag">No downloads yet.</p>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <!--[-->`);
		const each_array = ensure_array_like(list());
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let d = each_array[$$index];
			$$renderer.push(`<div class="row svelte-1uha8ag"><div class="row-top svelte-1uha8ag"><span class="name svelte-1uha8ag"${attr("title", d.fileName)}>${escape_html(d.fileName)}</span> <span class="badge svelte-1uha8ag">${escape_html(d.status)}</span></div> `);
			if (d.status === "error") {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<p class="err svelte-1uha8ag">${escape_html(d.error)}</p>`);
			} else {
				$$renderer.push("<!--[-1-->");
				$$renderer.push(`<div class="bar svelte-1uha8ag"><div class="fill svelte-1uha8ag"${attr_style(`width:${stringify(d.status === "completed" ? 100 : pct(d))}%`)}></div></div> <div class="row-meta svelte-1uha8ag"><span>${escape_html(fmtBytes(d.downloaded))}${escape_html(d.total ? ` / ${fmtBytes(d.total)}` : "")}</span> `);
				if (d.status === "downloading") {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span>${escape_html(fmtBytes(d.speedBps))}/s · ${escape_html(fmtEta(d.etaSecs))}</span>`);
				} else {
					$$renderer.push("<!--[-1-->");
					$$renderer.push(`<span>${escape_html(d.status === "completed" ? "Done" : `${pct(d)}%`)}</span>`);
				}
				$$renderer.push(`<!--]--></div>`);
			}
			$$renderer.push(`<!--]--> <div class="actions svelte-1uha8ag">`);
			if (d.status === "downloading" || d.status === "queued") {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<button class="svelte-1uha8ag">Pause</button> <button class="svelte-1uha8ag">Cancel</button>`);
			} else if (d.status === "paused") {
				$$renderer.push("<!--[1-->");
				$$renderer.push(`<button class="svelte-1uha8ag">Resume</button> <button class="svelte-1uha8ag">Cancel</button>`);
			} else if (d.status === "error") {
				$$renderer.push("<!--[2-->");
				$$renderer.push(`<button class="svelte-1uha8ag">Retry</button> <button class="svelte-1uha8ag">Remove</button>`);
			} else if (d.status === "completed") {
				$$renderer.push("<!--[3-->");
				$$renderer.push(`<button class="svelte-1uha8ag">Open</button> <button class="svelte-1uha8ag">Folder</button> <button class="svelte-1uha8ag">Remove</button>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--></div></div>`);
		}
		$$renderer.push(`<!--]--></section></div>`);
	});
}
//#endregion
export { _page as default };
