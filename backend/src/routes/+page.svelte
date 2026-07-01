<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	type Status = 'queued' | 'downloading' | 'paused' | 'completed' | 'error';
	interface Item {
		id: string;
		fileName: string;
		status: Status;
		downloaded: number;
		total: number;
		speedBps: number;
		etaSecs: number;
		error?: string;
		order: number;
	}

	let connected = $state(false);
	let baseDir = $state('');
	let items = $state<Record<string, Item>>({});
	let orderSeq = 0;

	// New-download form
	let url = $state('');
	let fileName = $state('');
	let asPlaylist = $state(false);

	// Settings
	let sMaxConcurrent = $state(10);
	let sDefaultThreads = $state(8);
	let sMaxRateMB = $state(0);
	let sEngineQuiet = $state(true);

	let ws: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	const list = $derived(Object.values(items).sort((a, b) => a.order - b.order));

	function upsert(id: string, patch: Partial<Item>) {
		const prev = items[id] ?? {
			id, fileName: 'Unknown', status: 'queued' as Status,
			downloaded: 0, total: 0, speedBps: 0, etaSecs: 0, order: orderSeq++
		};
		items = { ...items, [id]: { ...prev, ...patch, order: prev.order } };
	}

	function send(obj: unknown) {
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
	}

	function handle(data: any) {
		switch (data.type) {
			case 'DIRECTORY_SELECTED':
				baseDir = data.payload?.path ?? baseDir;
				break;
			case 'SETTINGS':
				if (data.settings) {
					sMaxConcurrent = data.settings.maxConcurrentDownloads;
					sDefaultThreads = data.settings.defaultThreads;
					sMaxRateMB = Math.round((data.settings.maxRateBytes / 1048576) * 10) / 10;
					sEngineQuiet = data.settings.engineQuiet;
					if (data.settings.baseDirectory) baseDir = data.settings.baseDirectory;
				}
				break;
			case 'DOWNLOAD_SNAPSHOT':
				for (const d of data.downloads ?? []) {
					upsert(d.downloadId, {
						fileName: d.fileName, status: d.status,
						downloaded: d.downloaded ?? 0, total: d.total ?? 0
					});
				}
				break;
			case 'DOWNLOAD_ACK':
				upsert(data.downloadId, { fileName: data.fileName, status: data.status ?? 'queued' });
				break;
			case 'PROGRESS':
				upsert(data.downloadId, {
					status: 'downloading', downloaded: data.downloaded ?? 0, total: data.total ?? 0,
					speedBps: data.speedBps ?? 0, etaSecs: data.etaSecs ?? 0
				});
				break;
			case 'DOWNLOAD_COMPLETED':
				upsert(data.downloadId, { status: 'completed', speedBps: 0, etaSecs: 0 });
				break;
			case 'DOWNLOAD_PAUSED':
				upsert(data.downloadId, { status: 'paused', speedBps: 0, etaSecs: 0 });
				break;
			case 'DOWNLOAD_ERROR':
				upsert(data.downloadId, { status: 'error', error: data.error, speedBps: 0, etaSecs: 0 });
				break;
			case 'DOWNLOAD_REMOVED': {
				const next = { ...items };
				delete next[data.downloadId];
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
		ws.onopen = () => { connected = true; };
		ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch { /* ignore */ } };
		ws.onclose = () => { connected = false; ws = null; scheduleReconnect(); };
		ws.onerror = () => ws?.close();
	}

	function scheduleReconnect() {
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(connect, 2000);
	}

	function startDownload() {
		if (!url) return;
		let name = fileName;
		if (!name) {
			try { name = new URL(url).pathname.split('/').filter(Boolean).pop() || 'download_file'; }
			catch { name = 'download_file'; }
		}
		send({ type: 'NEW_DOWNLOAD', payload: { url, fileName: name, playlist: asPlaylist } });
		url = ''; fileName = '';
	}

	function saveSettings() {
		send({ type: 'SET_SETTINGS', payload: {
			maxConcurrentDownloads: sMaxConcurrent,
			defaultThreads: sDefaultThreads,
			maxRateBytes: Math.round(sMaxRateMB * 1048576),
			engineQuiet: sEngineQuiet
		}});
	}

	function pct(d: Item) { return d.total ? Math.min(100, Math.round((d.downloaded / d.total) * 100)) : 0; }
	function fmtBytes(n: number) {
		if (!n) return '0 B';
		const u = ['B', 'KB', 'MB', 'GB']; const i = Math.floor(Math.log(n) / Math.log(1024));
		return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
	}
	function fmtEta(s: number) {
		if (!s || s <= 0) return '--';
		if (s < 60) return `${Math.round(s)}s`;
		if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
		return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
	}

	onMount(connect);
	onDestroy(() => { if (reconnectTimer) clearTimeout(reconnectTimer); ws?.close(); });
</script>

<div class="page">
	<header>
		<h1>⚡ Veloce Dashboard</h1>
		<span class="status" class:online={connected}>{connected ? 'Coordinator online' : 'Coordinator offline'}</span>
	</header>

	<section class="card">
		<h2>New download</h2>
		<input placeholder="https://…" bind:value={url} />
		<input placeholder="Filename (optional)" bind:value={fileName} />
		<label class="chk"><input type="checkbox" bind:checked={asPlaylist} /> Treat URL as a playlist</label>
		<button class="primary" disabled={!connected || !url} onclick={startDownload}>Download</button>
		<p class="hint">Saving to <code>{baseDir || '~/Downloads/Veloce'}</code></p>
	</section>

	<section class="card">
		<h2>Settings</h2>
		<div class="grid">
			<label>Max concurrent<input type="number" min="1" max="64" bind:value={sMaxConcurrent} /></label>
			<label>Default connections<input type="number" min="1" max="64" bind:value={sDefaultThreads} /></label>
			<label>Speed cap (MB/s, 0 = ∞)<input type="number" min="0" step="0.1" bind:value={sMaxRateMB} /></label>
			<label class="chk"><input type="checkbox" bind:checked={sEngineQuiet} /> Quiet engine</label>
		</div>
		<button class="primary" disabled={!connected} onclick={saveSettings}>Save settings</button>
	</section>

	<section class="card">
		<h2>Queue ({list.length})</h2>
		{#if list.length === 0}
			<p class="hint">No downloads yet.</p>
		{/if}
		{#each list as d (d.id)}
			<div class="row">
				<div class="row-top">
					<span class="name" title={d.fileName}>{d.fileName}</span>
					<span class="badge">{d.status}</span>
				</div>
				{#if d.status === 'error'}
					<p class="err">{d.error}</p>
				{:else}
					<div class="bar"><div class="fill" style="width:{d.status === 'completed' ? 100 : pct(d)}%"></div></div>
					<div class="row-meta">
						<span>{fmtBytes(d.downloaded)}{d.total ? ` / ${fmtBytes(d.total)}` : ''}</span>
						{#if d.status === 'downloading'}
							<span>{fmtBytes(d.speedBps)}/s · {fmtEta(d.etaSecs)}</span>
						{:else}
							<span>{d.status === 'completed' ? 'Done' : `${pct(d)}%`}</span>
						{/if}
					</div>
				{/if}
				<div class="actions">
					{#if d.status === 'downloading' || d.status === 'queued'}
						<button onclick={() => send({ type: 'PAUSE_DOWNLOAD', downloadId: d.id })}>Pause</button>
						<button onclick={() => send({ type: 'CANCEL_DOWNLOAD', downloadId: d.id })}>Cancel</button>
					{:else if d.status === 'paused'}
						<button onclick={() => send({ type: 'RESUME_DOWNLOAD', downloadId: d.id })}>Resume</button>
						<button onclick={() => send({ type: 'CANCEL_DOWNLOAD', downloadId: d.id })}>Cancel</button>
					{:else if d.status === 'error'}
						<button onclick={() => send({ type: 'RESUME_DOWNLOAD', downloadId: d.id })}>Retry</button>
						<button onclick={() => send({ type: 'REMOVE_DOWNLOAD', downloadId: d.id })}>Remove</button>
					{:else if d.status === 'completed'}
						<button onclick={() => send({ type: 'OPEN_FILE', downloadId: d.id })}>Open</button>
						<button onclick={() => send({ type: 'REVEAL_FILE', downloadId: d.id })}>Folder</button>
						<button onclick={() => send({ type: 'REMOVE_DOWNLOAD', downloadId: d.id })}>Remove</button>
					{/if}
				</div>
			</div>
		{/each}
	</section>
</div>

<style>
	:global(body) { margin: 0; background: #000d1f; color: #fff; font-family: system-ui, sans-serif; }
	.page { max-width: 720px; margin: 0 auto; padding: 24px 16px 60px; }
	header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
	h1 { font-size: 20px; margin: 0; }
	h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 2px; opacity: 0.6; margin: 0 0 12px; }
	.status { font-size: 12px; padding: 4px 10px; border: 1px solid #ff4444; color: #ff9999; }
	.status.online { border-color: #fff; color: #fff; }
	.card { border: 1px solid rgba(255,255,255,0.2); padding: 16px; margin-bottom: 16px; }
	input[type="number"], input:not([type]) {
		width: 100%; box-sizing: border-box; background: #001028; border: 1px solid rgba(255,255,255,0.3);
		color: #fff; padding: 8px 10px; font-size: 14px; margin-bottom: 10px;
	}
	.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; margin-bottom: 12px; }
	.grid label { display: flex; flex-direction: column; font-size: 11px; opacity: 0.7; gap: 4px; }
	.chk { display: flex; align-items: center; gap: 8px; font-size: 13px; opacity: 0.85; margin-bottom: 10px; }
	.chk input { width: auto; margin: 0; }
	button { background: transparent; border: 1px solid rgba(255,255,255,0.25); color: #fff; padding: 4px 10px; font-size: 12px; cursor: pointer; }
	button:hover { background: #002a55; }
	button.primary { border-color: #fff; padding: 8px 14px; font-size: 13px; }
	button:disabled { opacity: 0.4; cursor: not-allowed; }
	.hint { font-size: 12px; opacity: 0.6; }
	code { background: rgba(255,255,255,0.1); padding: 1px 5px; }
	.row { border: 1px solid rgba(255,255,255,0.15); padding: 10px; margin-bottom: 8px; }
	.row-top { display: flex; justify-content: space-between; gap: 8px; }
	.name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.badge { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; }
	.bar { height: 4px; background: rgba(255,255,255,0.15); margin: 8px 0 6px; }
	.fill { height: 100%; background: #fff; transition: width 0.2s; }
	.row-meta { display: flex; justify-content: space-between; font-size: 11px; opacity: 0.6; }
	.err { font-size: 12px; opacity: 0.8; margin: 6px 0; }
	.actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
</style>
