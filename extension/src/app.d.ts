// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	interface Port {
		disconnect: () => void;
		onDisconnect: { addListener: (cb: () => void) => void };
	}

	// Minimal Chrome extension API surface used by Veloce popup.
	const chrome: {
		runtime: {
			id?: string;
			lastError?: { message?: string };
			onMessage: {
				addListener: (cb: (msg: any, sender: any, sendResponse: (r?: any) => void) => void) => void;
			};
			sendMessage: (msg: object, cb?: (response: any) => void) => void;
			connect: (info: { name: string }) => Port;
		};
		storage: {
			local: {
				get: (keys: string | string[] | object, cb: (r: Record<string, any>) => void) => void;
				set: (obj: Record<string, any>, cb?: () => void) => void;
			};
		};
	};
}

export {};
