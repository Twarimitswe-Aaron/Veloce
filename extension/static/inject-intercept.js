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

	function storeDownloadPayload(links, captions, movie) {
		const hasLinks = Array.isArray(links) && links.length;
		const hasCaptions = Array.isArray(captions) && captions.length;
		if (!hasLinks && !hasCaptions) return;
		const payload = {
			links: hasLinks ? links : [],
			captions: hasCaptions ? captions : [],
			movie: movie || '',
			ts: Date.now()
		};
		try {
			sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
		} catch { /* ignore */ }
		logImportant('stored download links', {
			count: payload.links.length,
			captions: payload.captions.length,
			movie,
			qualities: payload.links.map((l) => l.resolution ?? l.res ?? l.quality)
		});
		try {
			window.postMessage({
				source: 'veloce-page-hook',
				type: 'VELOCE_DOWNLOAD_LINKS',
				links: payload.links,
				captions: payload.captions,
				movie
			}, '*');
		} catch { /* ignore */ }
	}

	function normalizeMediaLinks(raw) {
		if (!Array.isArray(raw)) return [];
		return raw.map((item) => ({
			url: item.url || item.downloadUrl || item.href || item.resourceLink || '',
			resolution: item.resolution ?? item.res ?? item.quality ?? item.label,
			format: item.format || item.codecName || 'mp4',
			label: item.title || item.label || ''
		})).filter((item) => item.url);
	}

	function normalizeCaptionLinks(raw) {
		if (!Array.isArray(raw)) return [];
		return raw.map((item) => ({
			url: item.url || item.downloadUrl || item.href || '',
			lan: item.lan || item.lang || item.language || '',
			lanName: item.lanName || item.languageName || item.label || item.name || item.lan || 'subtitle'
		})).filter((item) => item.url);
	}

	function parseDownloadApiBody(body) {
		if (!body || typeof body !== 'object') return;
		const rawLinks = body.downloads || body.downloadLinks || body.data?.downloads
			|| body.list || body.data?.list || [];
		const rawCaptions = body.captions || body.extCaptions || body.data?.captions
			|| body.data?.extCaptions || [];
		const embeddedCaptions = [];
		if (Array.isArray(rawLinks)) {
			for (const item of rawLinks) {
				if (Array.isArray(item?.extCaptions)) embeddedCaptions.push(...item.extCaptions);
			}
		}
		const links = normalizeMediaLinks(rawLinks);
		const captions = normalizeCaptionLinks([].concat(rawCaptions, embeddedCaptions));
		if (!links.length && !captions.length) return;
		const movie = body.title || body.subject?.title || body.data?.title || '';
		storeDownloadPayload(links, captions, movie);
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

	function inspectDownloadApiResponse(url, text) {
		if (!isDownloadApiUrl(url) || !text) return;
		try {
			parseDownloadApiBody(JSON.parse(text));
		} catch { /* ignore */ }
	}

	// MovieBox / OmniSave API uses axios/XHR; some mirrors also use fetch.
	try {
		const nativeXHROpen = XMLHttpRequest.prototype.open;
		const nativeXHRSend = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.open = function veloceXHROpen(method, url, ...rest) {
			this.__veloceUrl = url;
			return nativeXHROpen.call(this, method, url, ...rest);
		};
		XMLHttpRequest.prototype.send = function veloceXHRSend(...args) {
			this.addEventListener('load', function veloceXHRLoad() {
				inspectDownloadApiResponse(this.__veloceUrl || '', this.responseText);
			});
			return nativeXHRSend.apply(this, args);
		};
	} catch (e) {
		logImportant('XHR hook failed (SES?)', String(e));
	}

	try {
		const nativeFetch = window.fetch;
		if (typeof nativeFetch === 'function') {
			window.fetch = function veloceFetch(input, init) {
				const url = typeof input === 'string' ? input : input?.url || '';
				return nativeFetch.call(this, input, init).then((res) => {
					if (isDownloadApiUrl(url)) {
						res.clone().text().then((text) => inspectDownloadApiResponse(url, text)).catch(() => {});
					}
					return res;
				});
			};
		}
	} catch (e) {
		logImportant('fetch hook failed (SES?)', String(e));
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
