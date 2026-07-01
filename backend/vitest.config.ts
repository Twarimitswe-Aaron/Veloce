import { defineConfig } from 'vitest/config';

// Standalone Vitest config (does NOT load the dev WebSocket plugin from
// vite.config.ts) so unit tests stay fast and side-effect free.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts']
	}
});
