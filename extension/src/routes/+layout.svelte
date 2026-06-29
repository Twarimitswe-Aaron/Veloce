<script lang="ts">
	let { children } = $props();
	import '../app.css';
	import { onMount } from 'svelte';
	import { wsClient } from '$lib/wsClient';

	onMount(() => {
		// Initialize connection when the extension popup opens
		wsClient.connect();
	});
</script>

<div class="min-h-screen bg-gray-950 text-gray-100 flex flex-col font-sans">
	<header class="border-b border-gray-800 bg-gray-900/50 p-4 backdrop-blur">
		<div class="flex items-center justify-between">
			<h1 class="text-lg font-bold text-transparent bg-clip-text bg-linear-to-r from-blue-400 to-emerald-400">
				⚡ Veloce
			</h1>
		</div>
	</header>

	<main class="flex-1 p-4">
		{@render children()}
	</main>
</div>
