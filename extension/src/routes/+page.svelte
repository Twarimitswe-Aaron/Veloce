<script lang="ts">
	import { isConnected, wsClient, selectedDirectory } from '$lib/wsClient';
	import { onMount } from 'svelte';
	
	let downloadUrl = $state('');
	let fileName = $state('');
	let baseDirectory = $state('');
	
	onMount(() => {
		const saved = localStorage.getItem('veloce_base_dir');
		if (saved) baseDirectory = saved;
	});
	
	$effect(() => {
		localStorage.setItem('veloce_base_dir', baseDirectory);
	});

	$effect(() => {
		if ($selectedDirectory) {
			baseDirectory = $selectedDirectory;
		}
	});

	function handleDownload() {
		if (!downloadUrl) return;
		
		// Basic filename extraction if not provided
		const extractedName = fileName || downloadUrl.split('/').pop()?.split('?')[0] || 'download_file';
		
		wsClient.sendDownloadRequest(downloadUrl, extractedName, baseDirectory);
		
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
					class="shrink-0 bg-gray-800 hover:bg-gray-700 text-gray-300 p-2.5 rounded-lg border border-gray-700 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500/50"
					title="Select Folder"
				>
					<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
				</button>
			</div>
		</div>

		<button 
			disabled={!$isConnected || !downloadUrl}
			onclick={handleDownload}
			class="mt-2 w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-medium py-2.5 px-4 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-900/20"
		>
			<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
			Send to Veloce
		</button>
	</div>
</div>
