import { a as derived, c as store_get, h as escape_html, i as attr_style, l as stringify, m as clsx, o as ensure_array_like, p as attr, r as attr_class, u as unsubscribe_stores } from "../../chunks/index-server.js";
import { i as pickerError, n as interceptEnabled, r as isConnected, t as downloads } from "../../chunks/wsClient.js";
//#region src/routes/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		var $$store_subs;
		let downloadUrl = "";
		let fileName = "";
		let baseDirectory = "";
		let threadCount = 8;
		let asPlaylist = false;
		let downloadList = derived(() => Object.values(store_get($$store_subs ??= {}, "$downloads", downloads)).sort((a, b) => a.order - b.order));
		const inputClass = "w-full bg-[#000d1f] border border-white/30 px-3 py-2 text-sm text-white placeholder:text-white/35 focus:outline-none focus:border-white";
		function pct(d) {
			if (!d.total) return 0;
			return Math.min(100, Math.round(d.downloaded / d.total * 100));
		}
		function formatBytes(bytes) {
			if (!bytes) return "0 B";
			const units = [
				"B",
				"KB",
				"MB",
				"GB"
			];
			const i = Math.floor(Math.log(bytes) / Math.log(1024));
			return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
		}
		function formatEta(secs) {
			if (!secs || secs <= 0) return "--";
			if (secs < 60) return `${Math.round(secs)}s`;
			if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
			return `${Math.floor(secs / 3600)}h ${Math.floor(secs % 3600 / 60)}m`;
		}
		$$renderer.push(`<div class="flex flex-col gap-5"><div class="flex items-center justify-between border border-white/25 px-3 py-2"><div class="flex items-center gap-2"><span class="inline-block w-2 h-2"${attr_style(`background: ${store_get($$store_subs ??= {}, "$isConnected", isConnected) ? "#fff" : "#ff4444"}`)}></span> <span class="text-xs font-medium">${escape_html(store_get($$store_subs ??= {}, "$isConnected", isConnected) ? "Coordinator online" : "Coordinator offline")}</span></div> <label class="flex items-center gap-2 text-[10px] uppercase tracking-wider opacity-70 cursor-pointer"><input type="checkbox"${attr("checked", store_get($$store_subs ??= {}, "$interceptEnabled", interceptEnabled), true)} class="accent-white"/> Intercept</label></div> `);
		if (!store_get($$store_subs ??= {}, "$isConnected", isConnected)) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<p class="text-xs opacity-60 leading-relaxed">Start the backend (<code class="opacity-80">cd backend &amp;&amp; npm run dev</code>) then reload this popup.
			When online, page badges and native download clicks are routed to Veloce.</p>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <div class="flex flex-col gap-3"><div><label for="url" class="block text-[10px] uppercase tracking-widest opacity-60 mb-1">URL</label> <input id="url" type="url"${attr("value", downloadUrl)} placeholder="https://…"${attr_class(clsx(inputClass))}/></div> <div><label for="filename" class="block text-[10px] uppercase tracking-widest opacity-60 mb-1">Filename</label> <input id="filename" type="text"${attr("value", fileName)} placeholder="optional"${attr_class(clsx(inputClass))}/></div> <div><label for="basedir" class="block text-[10px] uppercase tracking-widest opacity-60 mb-1">Save to</label> <div class="flex gap-2"><input id="basedir" type="text"${attr("value", baseDirectory)} placeholder="~/Downloads/Veloce"${attr_class(clsx(inputClass))}/> <button type="button" class="shrink-0 border border-white/30 px-2 text-white hover:bg-[#002a55] cursor-pointer" title="Pick folder">…</button></div> `);
		if (store_get($$store_subs ??= {}, "$pickerError", pickerError)) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<p class="text-[11px] mt-1 opacity-70">${escape_html(store_get($$store_subs ??= {}, "$pickerError", pickerError))}</p>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div> <div><label for="threads" class="block text-[10px] uppercase tracking-widest opacity-60 mb-1">Connections</label> `);
		$$renderer.select({
			id: "threads",
			value: threadCount,
			class: inputClass
		}, ($$renderer) => {
			$$renderer.option({ value: 1 }, ($$renderer) => {
				$$renderer.push(`1`);
			});
			$$renderer.option({ value: 4 }, ($$renderer) => {
				$$renderer.push(`4`);
			});
			$$renderer.option({ value: 8 }, ($$renderer) => {
				$$renderer.push(`8`);
			});
			$$renderer.option({ value: 16 }, ($$renderer) => {
				$$renderer.push(`16`);
			});
			$$renderer.option({ value: 32 }, ($$renderer) => {
				$$renderer.push(`32`);
			});
		});
		$$renderer.push(`</div> <label class="flex items-center gap-2 text-[11px] opacity-80 cursor-pointer"><input type="checkbox"${attr("checked", asPlaylist, true)} class="accent-white"/> Treat URL as a playlist (one job — format from Settings below)</label> <button${attr("disabled", !store_get($$store_subs ??= {}, "$isConnected", isConnected) || true, true)} class="w-full border border-white py-2 text-sm font-medium hover:bg-[#002a55] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">Download</button></div> <div class="border border-white/20"><button type="button" class="w-full flex items-center justify-between px-3 py-2 text-[10px] uppercase tracking-widest opacity-70 hover:bg-[#002a55] cursor-pointer"><span>Settings</span> <span>${escape_html("▼")}</span></button> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div> `);
		if (downloadList().length > 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="flex flex-col gap-2"><span class="text-[10px] uppercase tracking-widest opacity-60">Queue (${escape_html(downloadList().length)})</span> <!--[-->`);
			const each_array = ensure_array_like(downloadList());
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let d = each_array[$$index];
				$$renderer.push(`<div class="border border-white/20 p-2 flex flex-col gap-1.5"><div class="flex justify-between gap-2 items-start"><span class="text-xs truncate flex-1"${attr("title", d.fileName)}>${escape_html(d.fileName)}</span> <span class="text-[9px] uppercase tracking-wider opacity-70 shrink-0">${escape_html(d.status)}</span></div> `);
				if (d.status === "error" || d.status === "failed") {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<p class="text-[11px] opacity-80">${escape_html(d.error || "Download failed")}</p>`);
				} else {
					$$renderer.push("<!--[-1-->");
					$$renderer.push(`<div class="h-1 w-full bg-white/15"><div class="h-full bg-white transition-[width] duration-200"${attr_style(`width: ${stringify(d.status === "completed" ? 100 : pct(d))}%`)}></div></div> <div class="flex justify-between text-[10px] opacity-60"><span>`);
					if (d.status === "completed") {
						$$renderer.push("<!--[0-->");
						$$renderer.push(`${escape_html(formatBytes(d.total || d.downloaded))}`);
					} else {
						$$renderer.push("<!--[-1-->");
						$$renderer.push(`${escape_html(formatBytes(d.downloaded))}${escape_html(d.total ? ` / ${formatBytes(d.total)}` : "")}`);
					}
					$$renderer.push(`<!--]--></span> `);
					if (d.status === "downloading") {
						$$renderer.push("<!--[0-->");
						$$renderer.push(`<span>${escape_html(formatBytes(d.speedBps))}/s · ${escape_html(formatEta(d.etaSecs))}</span>`);
					} else {
						$$renderer.push("<!--[-1-->");
						$$renderer.push(`<span>${escape_html(d.status === "completed" ? "Done" : `${pct(d)}%`)}</span>`);
					}
					$$renderer.push(`<!--]--></div>`);
				}
				$$renderer.push(`<!--]--> <div class="flex gap-1 flex-wrap">`);
				if (d.status === "downloading" || d.status === "queued") {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<button type="button" class="text-[10px] px-2 py-0.5 border border-white/25 hover:bg-[#002a55] cursor-pointer">Pause</button> <button type="button" class="text-[10px] px-2 py-0.5 border border-white/25 hover:bg-[#002a55] cursor-pointer">Cancel</button>`);
				} else if (d.status === "paused") {
					$$renderer.push("<!--[1-->");
					$$renderer.push(`<button type="button" class="text-[10px] px-2 py-0.5 border border-white hover:bg-[#002a55] cursor-pointer">Resume</button> <button type="button" class="text-[10px] px-2 py-0.5 border border-white/25 hover:bg-[#002a55] cursor-pointer">Cancel</button>`);
				} else if (d.status === "error" || d.status === "failed") {
					$$renderer.push("<!--[2-->");
					if (d.isPlaylist) {
						$$renderer.push("<!--[0-->");
						$$renderer.push(`<button type="button" class="text-[10px] px-2 py-0.5 border border-white/25 hover:bg-[#002a55] cursor-pointer">Remove</button>`);
					} else {
						$$renderer.push("<!--[-1-->");
						$$renderer.push(`<button type="button" class="text-[10px] px-2 py-0.5 border border-white hover:bg-[#002a55] cursor-pointer">Retry</button> <button type="button" class="text-[10px] px-2 py-0.5 border border-white/25 hover:bg-[#002a55] cursor-pointer">Remove</button>`);
					}
					$$renderer.push(`<!--]-->`);
				} else if (d.status === "completed") {
					$$renderer.push("<!--[3-->");
					$$renderer.push(`<button type="button" class="text-[10px] px-2 py-0.5 border border-white hover:bg-[#002a55] cursor-pointer">Open</button> <button type="button" class="text-[10px] px-2 py-0.5 border border-white/25 hover:bg-[#002a55] cursor-pointer">Folder</button> <button type="button" class="text-[10px] px-2 py-0.5 border border-white/25 hover:bg-[#002a55] cursor-pointer">Remove</button>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div></div>`);
			}
			$$renderer.push(`<!--]--></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div>`);
		if ($$store_subs) unsubscribe_stores($$store_subs);
	});
}
//#endregion
export { _page as default };
