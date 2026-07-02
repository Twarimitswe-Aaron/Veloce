// MAIN-world hook for sites that programmatically create <a download> (OmniSave, etc.)
(function () {
	if (window.__veloceInjectLoaded) return;
	window.__veloceInjectLoaded = true;

	const TAG = '[Veloce page-hook]';
	let coordinatorOnline = false;

	function log(step, detail) {
		if (detail !== undefined) {
			console.log(TAG, step, detail);
		} else {
			console.log(TAG, step);
		}
		try {
			window.postMessage({ source: 'veloce-page-hook', type: 'VELOCE_HOOK_LOG', step, detail }, '*');
		} catch { /* ignore */ }
	}

	function readCoordinatorOnline() {
		try {
			if (document.documentElement?.getAttribute('data-veloce-coordinator') === '1') return true;
		} catch { /* ignore */ }
		return coordinatorOnline;
	}

	function requestIntercept(href, download, source) {
		log('INTERCEPT request → extension', { href, download, source });
		try {
			window.postMessage({
				source: 'veloce-page-hook',
				type: 'VELOCE_INTERCEPT',
				href,
				download,
				source
			}, '*');
		} catch (e) {
			log('postMessage failed', String(e));
		}
	}

	function tryInterceptAnchor(anchor, source) {
		const href = anchor.href;
		const download = anchor.getAttribute('download') || '';
		const online = readCoordinatorOnline();
		log('anchor check', { source, href, download, coordinatorOnline: online });
		if (!online) {
			log('SKIP — coordinator offline (open Veloce popup / start backend, refresh tab)');
			return false;
		}
		if (!href || !/^https?:/i.test(href)) {
			log('SKIP — not http(s)', { href });
			return false;
		}
		if (!anchor.hasAttribute('download')) {
			log('SKIP — no download attribute');
			return false;
		}
		requestIntercept(href, download, source);
		return true;
	}

	function hookAnchorElement(anchor, source) {
		if (!anchor || anchor.__veloceHooked) return;
		anchor.__veloceHooked = true;
		const nativeClick = anchor.click.bind(anchor);
		anchor.click = function veloceHookedAnchorClick() {
			log('element.click()', { source, href: anchor.href, download: anchor.getAttribute('download') });
			if (tryInterceptAnchor(anchor, source + '/click')) return;
			return nativeClick();
		};
	}

	window.addEventListener('message', (e) => {
		if (e.source !== window || !e.data || e.data.source !== 'veloce-extension') return;
		if (e.data.type === 'VELOCE_COORDINATOR') {
			coordinatorOnline = e.data.online === true;
			log('coordinator state from extension', { online: coordinatorOnline });
		}
	});

	try {
		const obs = new MutationObserver(() => {
			const v = document.documentElement?.getAttribute('data-veloce-coordinator');
			if (v === '1') coordinatorOnline = true;
			else if (v === '0') coordinatorOnline = false;
		});
		obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-veloce-coordinator'] });
	} catch { /* ignore */ }

	const nativeCreate = Document.prototype.createElement;
	Document.prototype.createElement = function veloceCreateElement(tag, options) {
		const el = nativeCreate.call(this, tag, options);
		if (String(tag || '').toLowerCase() === 'a') {
			log('createElement <a>');
			hookAnchorElement(el, 'createElement');
		}
		return el;
	};

	const nativeAppend = Node.prototype.appendChild;
	Node.prototype.appendChild = function veloceAppendChild(child) {
		if (child?.tagName === 'A') hookAnchorElement(child, 'appendChild');
		return nativeAppend.call(this, child);
	};

	const nativeProtoClick = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function veloceProtoAnchorClick() {
		log('HTMLAnchorElement.prototype.click', {
			href: this.href,
			download: this.getAttribute('download')
		});
		if (this.hasAttribute?.('download') && tryInterceptAnchor(this, 'prototype.click')) return;
		return nativeProtoClick.call(this);
	};

	log('MAIN-world hooks installed', { href: location.href });
	try {
		document.documentElement.dataset.veloceHookReady = '1';
	} catch { /* ignore */ }
})();
