// Site-handler registry — each sites/*.js registers a factory via __veloceRegisterSite(id, factory).
(function () {
	const factories = Object.create(null);

	window.__veloceRegisterSite = function registerSite(id, factory) {
		if (!id || typeof factory !== 'function') return;
		factories[id] = factory;
	};

	window.__veloceCreateSiteHandlers = function createSiteHandlers(ctx) {
		const handlers = [];
		for (const id of Object.keys(factories)) {
			try {
				const handler = factories[id](ctx);
				if (handler) handlers.push(handler);
			} catch (e) {
				console.warn('[Veloce] site handler failed to init:', id, e);
			}
		}
		return handlers;
	};
})();
