import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

const webSocketServer: Plugin = {
	name: 'webSocketServer',
	configureServer(server) {
		const httpServer = server.httpServer;
		if (httpServer) {
			// Dynamically import the WebSocket logic to attach it to Vite's HTTP server
			import('./src/lib/server/ws').then((module) => {
				module.setupWebSocketServer(httpServer);
			}).catch((err) => {
				console.error('Failed to load WebSocket server:', err);
			});
		}
	}
};

export default defineConfig({
	plugins: [sveltekit(), webSocketServer],
	server: {
		port: 14921,
		strictPort: true, // Fail if port is already in use
	}
});
