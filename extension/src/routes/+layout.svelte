<script lang="ts">
	let { children } = $props();
	import '../app.css';
	import { onMount } from 'svelte';
	import { wsClient } from '$lib/wsClient';

	onMount(() => {
		wsClient.connect();
	});
</script>

<div class="min-h-screen flex flex-col" style="background:#001833;color:#fff">
	<header class="border-b border-white/25 px-4 py-3">
		<h1 class="text-base font-semibold tracking-wide">Veloce</h1>
		<p class="text-[10px] uppercase tracking-widest opacity-60 mt-0.5">Download Manager</p>
	</header>

	<main class="flex-1 p-4 overflow-y-auto">
		{@render children()}
	</main>
</div>
