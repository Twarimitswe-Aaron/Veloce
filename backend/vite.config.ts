import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/** @type {import('vite').Plugin} */
const webSocketServer = {
	name: 'webSocketServer',
	configureServer(server) {
		if (server.httpServer) {
			// Dynamically import the WebSocket logic to attach it to Vite's HTTP server
			import('./src/lib/server/ws').then((module) => {
				module.setupWebSocketServer(server.httpServer);
			}).catch((err) => {
				console.error('Failed to load WebSocket server:', err);
			});
		}
	}
};

export default defineConfig({
	plugins: [sveltekit(), webSocketServer]
});
