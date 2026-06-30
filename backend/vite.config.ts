import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { config } from './src/lib/server/config';

const webSocketServer: Plugin = {
	name: 'webSocketServer',
	configureServer(server) {
		const httpServer = server.httpServer;
		if (httpServer) {
			// Dynamically import the WebSocket logic to attach it to Vite's HTTP server
			import('./src/lib/server/ws').then((module) => {
				module.setupWebSocketServer(httpServer as any);
			}).catch((err) => {
				console.error('Failed to load WebSocket server:', err);
			});
		}
	}
};

export default defineConfig({
	plugins: [sveltekit(), webSocketServer],
	server: {
		port: config.port,
		strictPort: true, // Fail if port is already in use
	}
});
