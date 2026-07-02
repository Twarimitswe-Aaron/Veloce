// MAIN-world hook — minimal surface for SES-hardened pages (OmniSave mirrors, etc.)
(function () {
	try {
		const root = document.documentElement;
		if (window.__veloceInjectLoaded || root?.dataset?.veloceHookInstalled === '1') return;
		window.__veloceInjectLoaded = true;
		if (root) root.dataset.veloceHookInstalled = '1';
	} catch {
		if (window.__veloceInjectLoaded) return;
		window.__veloceInjectLoaded = true;
	}

	const TAG = '[Veloce page-hook]';
	const STORAGE_KEY = 'veloce_omni_links';
	let coordinatorOnline = false;
	let lastLoggedOnline = null;

	function logImportant(step, detail) {
		if (detail !== undefined) console.log(TAG, step, detail);
		else console.log(TAG, step);
		try {
			window.postMessage({ source: 'veloce-page-hook', type: 'VELOCE_HOOK_LOG', step, detail, important: true }, '*');
		} catch { /* ignore */ }
	}

	function setCoordinatorOnline(online) {
		if (coordinatorOnline === online) return;
		coordinatorOnline = online;
		if (lastLoggedOnline !== online) {
			lastLoggedOnline = online;
			logImportant('coordinator online', { online });
		}
	}

	function readCoordinatorOnline() {
		try {
			if (document.documentElement?.getAttribute('data-veloce-coordinator') === '1') return true;
		} catch { /* ignore */ }
		return coordinatorOnline;
	}

	function storeDownloadLinks(links, movie) {
		if (!Array.isArray(links) || !links.length) return;
		const payload = { links, movie: movie || '', ts: Date.now() };
		try {
			sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
		} catch { /* ignore */ }
		logImportant('stored download links', {
			count: links.length,
			movie,
			qualities: links.map((l) => l.resolution ?? l.res ?? l.quality)
		});
		try {
			window.postMessage({
				source: 'veloce-page-hook',
				type: 'VELOCE_DOWNLOAD_LINKS',
				links,
				movie
			}, '*');
		} catch { /* ignore */ }
	}

	function parseDownloadApiBody(body) {
		if (!body || typeof body !== 'object') return;
		const links = body.downloads || body.downloadLinks || body.data?.downloads || [];
		if (!Array.isArray(links) || !links.length) return;
		const movie = body.title || body.subject?.title || body.data?.title || '';
		storeDownloadLinks(links, movie);
	}

	function isDownloadApiUrl(url) {
		return /subject\/download|video-download|wefeed-h5api|wefeed-seo-bff|h5-api\.aoneroom/i.test(String(url || ''));
	}

	function notifyIntercept(href, download) {
		logImportant('download anchor click', { href, download });
		try {
			window.postMessage({
				source: 'veloce-page-hook',
				type: 'VELOCE_INTERCEPT',
				href,
				download,
				source: 'anchor.click'
			}, '*');
		} catch { /* ignore */ }
	}

	window.addEventListener('message', (e) => {
		if (e.source !== window || !e.data || e.data.source !== 'veloce-extension') return;
		if (e.data.type === 'VELOCE_COORDINATOR') {
			setCoordinatorOnline(e.data.online === true);
		}
	});

	try {
		const obs = new MutationObserver(() => {
			const v = document.documentElement?.getAttribute('data-veloce-coordinator');
			if (v === '1') setCoordinatorOnline(true);
			else if (v === '0') setCoordinatorOnline(false);
		});
		obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-veloce-coordinator'] });
	} catch { /* ignore */ }

	// OmniSave API uses axios/XHR — not window.fetch.
	try {
		const nativeXHROpen = XMLHttpRequest.prototype.open;
		const nativeXHRSend = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.open = function veloceXHROpen(method, url, ...rest) {
			this.__veloceUrl = url;
			return nativeXHROpen.call(this, method, url, ...rest);
		};
		XMLHttpRequest.prototype.send = function veloceXHRSend(...args) {
			this.addEventListener('load', function veloceXHRLoad() {
				const url = this.__veloceUrl || '';
				if (!isDownloadApiUrl(url) || !this.responseText) return;
				try {
					parseDownloadApiBody(JSON.parse(this.responseText));
				} catch { /* ignore */ }
			});
			return nativeXHRSend.apply(this, args);
		};
	} catch (e) {
		logImportant('XHR hook failed (SES?)', String(e));
	}

	// Only intercept programmatic <a download>.click() — do NOT hook createElement (breaks React/GSI).
	try {
		const nativeProtoClick = HTMLAnchorElement.prototype.click;
		HTMLAnchorElement.prototype.click = function veloceProtoAnchorClick() {
			if (readCoordinatorOnline() && this.hasAttribute?.('download')) {
				const href = this.href;
				const download = this.getAttribute('download') || '';
				if (href && /^https?:/i.test(href)) {
					notifyIntercept(href, download);
				}
			}
			return nativeProtoClick.call(this);
		};
	} catch (e) {
		logImportant('anchor.click hook failed (SES?)', String(e));
	}

	logImportant('hooks installed', { href: location.href });
	try {
		document.documentElement.dataset.veloceHookReady = '1';
	} catch { /* ignore */ }
})();
