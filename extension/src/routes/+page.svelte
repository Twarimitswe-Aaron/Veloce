<script lang="ts">
	import {
		isConnected,
		wsClient,
		selectedDirectory,
		downloads,
		pickerError,
		interceptEnabled,
		settings,
		type DownloadItem,
		type VeloceSettings
	} from '$lib/wsClient';
	import { onMount } from 'svelte';

	let downloadUrl = $state('');
	let fileName = $state('');
	let baseDirectory = $state('');
	let threadCount = $state(8);
	let asPlaylist = $state(false);
	let showSettings = $state(false);

	// Local editable copies of server settings (synced when the store updates).
	let sMaxConcurrent = $state(10);
	let sDefaultThreads = $state(8);
	let sMaxRateMB = $state(0);
	let sEngineQuiet = $state(true);

	$effect(() => {
		const s = $settings as VeloceSettings | null;
		if (s) {
			sMaxConcurrent = s.maxConcurrentDownloads;
			sDefaultThreads = s.defaultThreads;
			sMaxRateMB = Math.round((s.maxRateBytes / (1024 * 1024)) * 10) / 10;
			sEngineQuiet = s.engineQuiet;
		}
	});

	function saveSettings() {
		wsClient.updateSettings({
			maxConcurrentDownloads: sMaxConcurrent,
			defaultThreads: sDefaultThreads,
			maxRateBytes: Math.round(sMaxRateMB * 1024 * 1024),
			engineQuiet: sEngineQuiet
		});
	}

	// Sort by stable first-seen order so rows keep their position and never reshuffle
	// while multiple downloads report progress concurrently.
	let downloadList = $derived(
		Object.values($downloads).sort((a, b) => a.order - b.order)
	);

	const inputClass =
		'w-full bg-[#000d1f] border border-white/30 px-3 py-2 text-sm text-white placeholder:text-white/35 focus:outline-none focus:border-white';

	function pct(d: DownloadItem): number {
		if (!d.total) return 0;
		return Math.min(100, Math.round((d.downloaded / d.total) * 100));
	}

	function formatBytes(bytes: number): string {
		if (!bytes) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(1024));
		return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
	}

	function formatEta(secs: number): string {
		if (!secs || secs <= 0) return '--';
		if (secs < 60) return `${Math.round(secs)}s`;
		if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
		return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
	}

	onMount(() => {
		const saved = localStorage.getItem('veloce_base_dir');
		if (saved) baseDirectory = saved;
	});

	$effect(() => {
		localStorage.setItem('veloce_base_dir', baseDirectory);
	});

	$effect(() => {
		if ($selectedDirectory) baseDirectory = $selectedDirectory;
	});

	function handleDownload() {
		if (!downloadUrl) return;
		let extractedName = fileName;
		if (!extractedName) {
			try {
				const parts = new URL(downloadUrl).pathname.split('/').filter((p) => p.length > 0);
				extractedName = parts.pop() || 'download_file';
			} catch {
				extractedName = 'download_file';
			}
		}
		wsClient.sendDownloadRequest(downloadUrl, extractedName, baseDirectory, threadCount, asPlaylist);
		downloadUrl = '';
		fileName = '';
	}
</script>

<div class="flex flex-col gap-5">
	<!-- Status -->
	<div class="flex items-center justify-between border border-white/25 px-3 py-2">
		<div class="flex items-center gap-2">
			<span
				class="inline-block w-2 h-2"
				style="background: {$isConnected ? '#fff' : '#ff4444'}"
			></span>
			<span class="text-xs font-medium">
				{$isConnected ? 'Coordinator online' : 'Coordinator offline'}
			</span>
		</div>
		<label class="flex items-center gap-2 text-[10px] uppercase tracking-wider opacity-70 cursor-pointer">
			<input
				type="checkbox"
				checked={$interceptEnabled}
				onchange={(e) => wsClient.setInterceptEnabled((e.target as HTMLInputElement).checked)}
				class="accent-white"
			/>
			Intercept
		</label>
	</div>

	{#if !$isConnected}
		<p class="text-xs opacity-60 leading-relaxed">
			Start the backend (<code class="opacity-80">cd backend && npm run dev</code>) then reload this popup.
			When online, page badges and native download clicks are routed to Veloce.
		</p>
	{/if}

	<!-- Form -->
	<div class="flex flex-col gap-3">
		<div>
			<label for="url" class="block text-[10px] uppercase tracking-widest opacity-60 mb-1">URL</label>
			<input id="url" type="url" bind:value={downloadUrl} placeholder="https://…" class={inputClass} />
		</div>

		<div>
			<label for="filename" class="block text-[10px] uppercase tracking-widest opacity-60 mb-1">Filename</label>
			<input id="filename" type="text" bind:value={fileName} placeholder="optional" class={inputClass} />
		</div>

		<div>
			<label for="basedir" class="block text-[10px] uppercase tracking-widest opacity-60 mb-1">Save to</label>
			<div class="flex gap-2">
				<input
					id="basedir"
					type="text"
					bind:value={baseDirectory}
					placeholder="~/Downloads/Veloce"
					class={inputClass}
				/>
				<button
					type="button"
					onclick={() => wsClient.requestDirectoryPicker()}
					class="shrink-0 border border-white/30 px-2 text-white hover:bg-[#002a55] cursor-pointer"
					title="Pick folder"
				>…</button>
			</div>
			{#if $pickerError}
				<p class="text-[11px] mt-1 opacity-70">{$pickerError}</p>
			{/if}
		</div>

		<div>
			<label for="threads" class="block text-[10px] uppercase tracking-widest opacity-60 mb-1">Connections</label>
			<select id="threads" bind:value={threadCount} class={inputClass}>
				<option value={1}>1</option>
				<option value={4}>4</option>
				<option value={8}>8</option>
				<option value={16}>16</option>
				<option value={32}>32</option>
			</select>
		</div>

		<label class="flex items-center gap-2 text-[11px] opacity-80 cursor-pointer">
			<input type="checkbox" bind:checked={asPlaylist} class="accent-white" />
			Treat URL as a playlist (queue every item)
		</label>

		<button
			disabled={!$isConnected || !downloadUrl}
			onclick={handleDownload}
			class="w-full border border-white py-2 text-sm font-medium hover:bg-[#002a55] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
		>
			Download
		</button>
	</div>

	<!-- Settings -->
	<div class="border border-white/20">
		<button
			type="button"
			onclick={() => (showSettings = !showSettings)}
			class="w-full flex items-center justify-between px-3 py-2 text-[10px] uppercase tracking-widest opacity-70 hover:bg-[#002a55] cursor-pointer"
		>
			<span>Settings</span>
			<span>{showSettings ? '▲' : '▼'}</span>
		</button>
		{#if showSettings}
			<div class="flex flex-col gap-3 p-3 border-t border-white/15">
				<div>
					<label for="maxc" class="block text-[10px] uppercase tracking-widest opacity-60 mb-1">Max concurrent downloads</label>
					<input id="maxc" type="number" min="1" max="64" bind:value={sMaxConcurrent} class={inputClass} />
				</div>
				<div>
					<label for="dthreads" class="block text-[10px] uppercase tracking-widest opacity-60 mb-1">Default connections</label>
					<input id="dthreads" type="number" min="1" max="64" bind:value={sDefaultThreads} class={inputClass} />
				</div>
				<div>
					<label for="rate" class="block text-[10px] uppercase tracking-widest opacity-60 mb-1">Speed cap (MB/s, 0 = unlimited)</label>
					<input id="rate" type="number" min="0" step="0.1" bind:value={sMaxRateMB} class={inputClass} />
				</div>
				<label class="flex items-center gap-2 text-[11px] opacity-80 cursor-pointer">
					<input type="checkbox" bind:checked={sEngineQuiet} class="accent-white" />
					Quiet engine (no terminal progress bars)
				</label>
				<button
					type="button"
					disabled={!$isConnected}
					onclick={saveSettings}
					class="w-full border border-white py-1.5 text-xs font-medium hover:bg-[#002a55] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
				>
					Save settings
				</button>
			</div>
		{/if}
	</div>

	<!-- Queue -->
	{#if downloadList.length > 0}
		<div class="flex flex-col gap-2">
			<span class="text-[10px] uppercase tracking-widest opacity-60">Queue ({downloadList.length})</span>
			{#each downloadList as d (d.id)}
				<div class="border border-white/20 p-2 flex flex-col gap-1.5">
					<div class="flex justify-between gap-2 items-start">
						<span class="text-xs truncate flex-1" title={d.fileName}>{d.fileName}</span>
						<span class="text-[9px] uppercase tracking-wider opacity-70 shrink-0">{d.status}</span>
					</div>

					{#if d.status === 'error'}
						<p class="text-[11px] opacity-80">{d.error}</p>
					{:else}
						<div class="h-1 w-full bg-white/15">
							<div
								class="h-full bg-white transition-[width] duration-200"
								style="width: {d.status === 'completed' ? 100 : pct(d)}%"
							></div>
						</div>
						<div class="flex justify-between text-[10px] opacity-60">
							<span>{formatBytes(d.downloaded)}{d.total ? ` / ${formatBytes(d.total)}` : ''}</span>
							{#if d.status === 'downloading'}
								<span>{formatBytes(d.speedBps)}/s · {formatEta(d.etaSecs)}</span>
							{:else}
								<span>{d.status === 'completed' ? 'Done' : `${pct(d)}%`}</span>
							{/if}
						</div>
					{/if}

					<div class="flex gap-1 flex-wrap">
						{#if d.status === 'downloading' || d.status === 'queued'}
							<button type="button" onclick={() => wsClient.pauseDownload(d.id)}
								class="text-[10px] px-2 py-0.5 border border-white/25 hover:bg-[#002a55] cursor-pointer">Pause</button>
							<button type="button" onclick={() => wsClient.cancelDownload(d.id)}
								class="text-[10px] px-2 py-0.5 border border-white/25 hover:bg-[#002a55] cursor-pointer">Cancel</button>
						{:else if d.status === 'paused'}
							<button type="button" onclick={() => wsClient.resumeDownload(d.id)}
								class="text-[10px] px-2 py-0.5 border border-white hover:bg-[#002a55] cursor-pointer">Resume</button>
							<button type="button" onclick={() => wsClient.cancelDownload(d.id)}
								class="text-[10px] px-2 py-0.5 border border-white/25 hover:bg-[#002a55] cursor-pointer">Cancel</button>
						{:else if d.status === 'error'}
							<button type="button" onclick={() => wsClient.resumeDownload(d.id)}
								class="text-[10px] px-2 py-0.5 border border-white hover:bg-[#002a55] cursor-pointer">Retry</button>
							<button type="button" onclick={() => wsClient.removeDownload(d.id)}
								class="text-[10px] px-2 py-0.5 border border-white/25 hover:bg-[#002a55] cursor-pointer">Remove</button>
						{:else if d.status === 'completed'}
							<button type="button" onclick={() => wsClient.openFile(d.id)}
								class="text-[10px] px-2 py-0.5 border border-white hover:bg-[#002a55] cursor-pointer">Open</button>
							<button type="button" onclick={() => wsClient.revealFile(d.id)}
								class="text-[10px] px-2 py-0.5 border border-white/25 hover:bg-[#002a55] cursor-pointer">Folder</button>
							<button type="button" onclick={() => wsClient.removeDownload(d.id)}
								class="text-[10px] px-2 py-0.5 border border-white/25 hover:bg-[#002a55] cursor-pointer">Remove</button>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
