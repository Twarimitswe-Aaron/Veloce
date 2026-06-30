<script lang="ts">
	import { isConnected, wsClient, selectedDirectory, downloads, pickerError, type DownloadItem } from '$lib/wsClient';
	import { onMount } from 'svelte';
	
	let downloadUrl = $state('');
	let fileName = $state('');
	let baseDirectory = $state('');
	let threadCount = $state(8);

	// Newest downloads first.
	let downloadList = $derived(
		Object.values($downloads).sort((a, b) => b.updatedAt - a.updatedAt)
	);

	function pct(d: DownloadItem): number {
		if (!d.total) return 0;
		return Math.min(100, Math.round((d.downloaded / d.total) * 100));
	}

	function formatBytes(bytes: number): string {
		if (!bytes) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
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

		const savedUrl = localStorage.getItem('veloce_last_url');
		if (savedUrl) downloadUrl = savedUrl;
	});
	
	$effect(() => {
		localStorage.setItem('veloce_base_dir', baseDirectory);
	});

	$effect(() => {
		localStorage.setItem('veloce_last_url', downloadUrl);
	});

	$effect(() => {
		if ($selectedDirectory) {
			baseDirectory = $selectedDirectory;
		}
	});

	function handleDownload() {
		if (!downloadUrl) return;
		
		// Basic filename extraction if not provided
		let extractedName = fileName;
		if (!extractedName && downloadUrl) {
			try {
				const u = new URL(downloadUrl);
				const parts = u.pathname.split('/').filter(p => p.length > 0);
				extractedName = parts.pop() || 'download_file';
			} catch (e) {
				extractedName = 'download_file';
			}
		}
		
		wsClient.sendDownloadRequest(downloadUrl, extractedName, baseDirectory, threadCount);
		
		// Reset form
		downloadUrl = '';
		fileName = '';
	}
</script>

<div class="flex flex-col gap-6">
	<!-- Connection Status -->
	<div class="flex items-center gap-3 p-3 rounded-xl bg-gray-900 border {$isConnected ? 'border-emerald-500/30' : 'border-red-500/30'}">
		<div class="relative flex h-3 w-3">
			{#if $isConnected}
				<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
				<span class="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
			{:else}
				<span class="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
			{/if}
		</div>
		<div class="flex flex-col">
			<span class="text-sm font-medium text-gray-200">Local Coordinator</span>
			<span class="text-xs text-gray-500">{$isConnected ? 'Connected & Ready' : 'Offline - Start Backend'}</span>
		</div>
	</div>

	<!-- Manual Download Form -->
	<div class="flex flex-col gap-4">
		<div class="flex flex-col gap-1.5">
			<label for="url" class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Resource URL</label>
			<input 
				id="url"
				type="url" 
				bind:value={downloadUrl} 
				placeholder="https://example.com/video.mp4" 
				class="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all placeholder:text-gray-600"
			/>
		</div>

		<div class="flex flex-col gap-1.5">
			<label for="filename" class="text-xs font-semibold text-gray-400 uppercase tracking-wider">File Name (Optional)</label>
			<input 
				id="filename"
				type="text" 
				bind:value={fileName} 
				placeholder="video.mp4" 
				class="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all placeholder:text-gray-600"
			/>
		</div>

		<div class="flex flex-col gap-1.5">
			<label for="basedir" class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Base Save Directory</label>
			<div class="flex items-center gap-2">
				<input 
					id="basedir"
					type="text" 
					bind:value={baseDirectory} 
					placeholder="Default: ~/Downloads/Veloce" 
					class="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all placeholder:text-gray-600"
				/>
				<button 
					type="button"
					onclick={() => wsClient.requestDirectoryPicker()}
					class="shrink-0 bg-gray-800 hover:bg-gray-700 text-gray-300 p-2.5 rounded-lg border border-gray-700 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500/50 cursor-pointer"
					title="Select Folder"
				>
					<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
				</button>
			</div>
			{#if $pickerError}
				<span class="text-xs text-amber-400">{$pickerError}</span>
			{/if}
		</div>

		<div class="flex flex-col gap-1.5">
			<label for="threads" class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Concurrent Threads</label>
			<select 
				id="threads"
				bind:value={threadCount} 
				class="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all text-gray-300 appearance-none"
			>
				<option value={1}>1 Thread (Safest)</option>
				<option value={2}>2 Threads</option>
				<option value={4}>4 Threads</option>
				<option value={8}>8 Threads (Recommended)</option>
				<option value={16}>16 Threads</option>
				<option value={32}>32 Threads</option>
				<option value={64}>64 Threads (Maximum)</option>
			</select>
		</div>

		<button 
			disabled={!$isConnected || !downloadUrl}
			onclick={handleDownload}
			class="mt-2 w-full flex items-center justify-center gap-2 bg-linear-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-medium py-2.5 px-4 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shadow-lg shadow-blue-900/20"
		>
			<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
			Send to Veloce
		</button>
	</div>

	<!-- Live Downloads -->
	{#if downloadList.length > 0}
		<div class="flex flex-col gap-3">
			<span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Downloads</span>
			{#each downloadList as d (d.id)}
				<div class="flex flex-col gap-2 p-3 rounded-xl bg-gray-900 border border-gray-800">
					<div class="flex items-center justify-between gap-2">
						<span class="text-sm text-gray-200 truncate" title={d.fileName}>{d.fileName}</span>
						<span
							class="shrink-0 text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full
							{d.status === 'completed' ? 'bg-emerald-500/15 text-emerald-400'
							: d.status === 'error' ? 'bg-red-500/15 text-red-400'
							: d.status === 'downloading' ? 'bg-blue-500/15 text-blue-400'
							: 'bg-gray-700/40 text-gray-400'}"
						>
							{d.status}
						</span>
					</div>

					{#if d.status === 'error'}
						<span class="text-xs text-red-400">{d.error}</span>
					{:else}
						<div class="h-2 w-full overflow-hidden rounded-full bg-gray-800">
							<div
								class="h-full rounded-full transition-all duration-300
								{d.status === 'completed' ? 'bg-emerald-500' : 'bg-linear-to-r from-blue-500 to-indigo-500'}"
								style="width: {d.status === 'completed' ? 100 : pct(d)}%"
							></div>
						</div>
						<div class="flex items-center justify-between text-[11px] text-gray-500">
							<span>{formatBytes(d.downloaded)} / {d.total ? formatBytes(d.total) : '—'}</span>
							{#if d.status === 'downloading'}
								<span>{formatBytes(d.speedBps)}/s · ETA {formatEta(d.etaSecs)}</span>
							{:else}
								<span>{d.status === 'completed' ? 'Done' : `${pct(d)}%`}</span>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
