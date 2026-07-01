// Veloce content script — finds downloadable resources on the page, shows a
// floating navy badge on each, and opens a format picker that starts a download
// immediately when the user picks one.

(function () {
	if (window.__veloceContentLoaded) return;
	window.__veloceContentLoaded = true;

	const FILE_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|mp3|wav|flac|ogg|m4a|zip|rar|7z|tar|gz|bz2|pdf|png|jpe?g|gif|webp|svg|docx?|xlsx?|pptx?|csv|json|xml|iso)(\?|#|$)/i;
	const VIDEO_SITES = /youtube\.com|youtu\.be|instagram\.com|tiktok\.com|twitter\.com|x\.com|vimeo\.com|facebook\.com|twitch\.tv|mediafire\.com/i;
	const CDN_IMAGE = /fbcdn\.net|cdninstagram\.com/i;

	function isHttpUrl(url) {
		try {
			const p = new URL(url).protocol;
			return p === 'http:' || p === 'https:';
		} catch {
			return false;
		}
	}

	function isBrowserOnlyUrl(url) {
		try {
			const p = new URL(url).protocol;
			return p === 'blob:' || p === 'data:' || p === 'mediastream:';
		} catch {
			return /^blob:|^data:|^mediastream:/i.test(url || '');
		}
	}

	/** Walk up the DOM from a video/card and find the canonical post/reel URL. */
	function findPostUrl(el) {
		let node = el;
		for (let i = 0; i < 25 && node; i++) {
			const link = node.querySelector?.(
				'a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]'
			);
			if (link) {
				try {
					return new URL(link.getAttribute('href') || link.href, location.origin).href.split('?')[0];
				} catch { /* keep walking */ }
			}
			if (node.matches?.('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]')) {
				try {
					return new URL(node.href, location.origin).href.split('?')[0];
				} catch { /* keep walking */ }
			}
			node = node.parentElement;
		}
		return null;
	}

	/**
	 * Map a raw media URL to something the backend / yt-dlp can fetch.
	 * Instagram feed cards play video via blob: — the real target is the post link
	 * (e.g. /p/DaL1ZkHiS29/), NOT location.href (which is just instagram.com/).
	 */
	function resolveDownloadUrl(raw, anchor) {
		if (!raw) return null;

		if (isBrowserOnlyUrl(raw)) {
			if (!VIDEO_SITES.test(location.hostname)) return null;
			const post = anchor ? findPostUrl(anchor) : null;
			if (post) return post;
			if (/\/(p|reel|tv)\//.test(location.pathname)) {
				return location.href.split('?')[0];
			}
			return null;
		}

		if (!isHttpUrl(raw)) return null;

		// Skip CDN still/thumbnail images on social feeds (not the video file).
		if (anchor && /instagram\.com/i.test(location.hostname) && CDN_IMAGE.test(raw)) {
			const tag = anchor.tagName?.toLowerCase();
			if (tag === 'video' || tag === 'audio' || anchor.querySelector?.('video,audio')) {
				return findPostUrl(anchor) || null;
			}
			if (/\.(jpe?g|webp|png|gif)(\?|#|$)/i.test(raw)) return null;
		}

		return raw;
	}

	/** Canonical key so /p/X/, /p/X, and query variants dedupe to one badge. */
	function normalizeBadgeKey(url) {
		try {
			const u = new URL(url);
			u.hash = '';
			if (VIDEO_SITES.test(u.hostname) && /\/(p|reel|tv)\//.test(u.pathname)) {
				const path = u.pathname.replace(/\/+$/, '');
				return `${u.origin}${path}`;
			}
			return `${u.origin}${u.pathname}${u.search}`;
		} catch {
			return url;
		}
	}

	/** One badge per feed card / post — not per carousel slide or nested media node. */
	function findBadgeRoot(anchor) {
		if (!anchor?.closest) return anchor;

		const tag = anchor.tagName?.toLowerCase();
		if (tag === 'a') {
			const href = anchor.href || '';
			if (anchor.hasAttribute('download') || FILE_EXT.test(href)) {
				return anchor;
			}
		}

		const semantic = anchor.closest('article, [role="article"], [data-testid="tweet"]');
		if (semantic) return semantic;

		if (VIDEO_SITES.test(location.hostname)) {
			let node = anchor;
			let candidate = anchor;
			for (let i = 0; i < 18 && node; i++) {
				const postLinks = node.querySelectorAll?.('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]');
				if (postLinks?.length >= 1) candidate = node;
				if (postLinks?.length === 1 && node.offsetHeight > 80) return node;
				node = node.parentElement;
			}
			return candidate;
		}

		return anchor;
	}

	const host = document.createElement('div');
	host.id = 'veloce-host';
	document.documentElement.appendChild(host);
	const shadow = host.attachShadow({ mode: 'closed' });

	const style = document.createElement('style');
	style.textContent = `
		:host { all: initial; }
		* { box-sizing: border-box; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }
		.badge {
			position: fixed;
			z-index: 2147483646;
			display: flex;
			align-items: center;
			gap: 4px;
			padding: 3px 8px;
			background: #001833;
			color: #ffffff;
			border: 1px solid #ffffff;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.02em;
			cursor: pointer;
			user-select: none;
			line-height: 1.2;
			white-space: nowrap;
		}
		.badge:hover { background: #002a55; }
		.badge-loading { opacity: 0.7; }
		.badge-ready { opacity: 1; }
		.badge-ready::after {
			content: '';
			width: 5px;
			height: 5px;
			background: #7ec8ff;
			margin-left: 2px;
		}
		.badge svg { width: 12px; height: 12px; flex-shrink: 0; }
		.menu {
			position: fixed;
			z-index: 2147483647;
			min-width: 220px;
			max-width: min(320px, calc(100vw - 16px));
			max-height: min(280px, calc(100vh - 16px));
			overflow-y: auto;
			background: #001833;
			color: #ffffff;
			border: 1px solid #ffffff;
		}
		.menu-title {
			padding: 8px 10px;
			font-size: 10px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			border-bottom: 1px solid rgba(255,255,255,0.25);
		}
		.menu-item {
			display: block;
			width: 100%;
			padding: 8px 10px;
			background: transparent;
			color: #ffffff;
			border: none;
			border-bottom: 1px solid rgba(255,255,255,0.12);
			text-align: left;
			font-size: 12px;
			cursor: pointer;
		}
		.menu-item:hover { background: #002a55; }
		.menu-item:last-child { border-bottom: none; }
		.menu-status {
			padding: 10px;
			font-size: 11px;
			color: rgba(255,255,255,0.75);
			line-height: 1.4;
		}
		.menu-loading {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.menu-spinner {
			width: 12px;
			height: 12px;
			flex-shrink: 0;
			border: 2px solid rgba(255,255,255,0.25);
			border-top-color: #ffffff;
			animation: veloce-spin 0.65s linear infinite;
		}
		@keyframes veloce-spin {
			to { transform: rotate(360deg); }
		}
		.menu-close {
			display: block;
			width: 100%;
			padding: 6px 10px;
			background: #000d1f;
			color: rgba(255,255,255,0.7);
			border: none;
			border-top: 1px solid rgba(255,255,255,0.25);
			font-size: 10px;
			cursor: pointer;
			text-align: center;
		}
	`;
	shadow.appendChild(style);

	const badges = new Map(); // badgeKey -> { el, anchor, root, rawUrl, resolvedUrl, labelEl }
	const badgeKeys = new Set();
	const localFormatCache = new Map();
	const prefetchStarted = new Set();
	const MAX_PREFETCH_BATCH = 3;
	const BADGE_MARGIN_PX = 200;
	const PREFETCH_MARGIN_PX = 80;
	const SCANNED_ATTR = 'data-veloce-scanned';
	const WATCH_ATTR = 'data-veloce-watch';
	const TAB_PING_MS = 50000;
	let openMenu = null;
	let pendingMenuUrl = null;
	let tabPort = null;
	let tabPingTimer = null;
	// Cached coordinator state so the link-click handler can preventDefault()
	// synchronously — otherwise the native download starts before an async check
	// returns, and chrome.downloads.onCreated would create a second copy.
	let coordinatorOnline = false;

	if (typeof chrome !== 'undefined' && chrome.storage?.local) {
		chrome.storage.local.get('veloce_connected', (r) => {
			coordinatorOnline = r.veloce_connected === true;
		});
		chrome.storage.onChanged?.addListener((changes, area) => {
			if (area === 'local' && changes.veloce_connected) {
				coordinatorOnline = changes.veloce_connected.newValue === true;
			}
		});
	}

	function connectTabPort() {
		try {
			if (tabPort) return;
			tabPort = chrome.runtime.connect({ name: 'veloce-tab' });
			tabPort.onDisconnect.addListener(() => {
				tabPort = null;
				setTimeout(connectTabPort, 800);
			});
		} catch {
			setTimeout(connectTabPort, 1500);
		}
	}

	function startTabPing() {
		if (tabPingTimer || document.hidden) return;
		tabPingTimer = setInterval(() => {
			if (document.hidden) return;
			try {
				if (tabPort) tabPort.postMessage({ type: 'ping' });
				else connectTabPort();
			} catch {
				tabPort = null;
				connectTabPort();
			}
		}, TAB_PING_MS);
	}

	function stopTabPing() {
		if (tabPingTimer) {
			clearInterval(tabPingTimer);
			tabPingTimer = null;
		}
	}

	connectTabPort();
	startTabPing();

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') {
			connectTabPort();
			startTabPing();
			scan();
		} else {
			stopTabPing();
		}
	});
	window.addEventListener('pageshow', () => {
		connectTabPort();
		startTabPing();
	});

	function markBadgeReady(badgeKey) {
		const entry = badges.get(badgeKey);
		if (!entry) return;
		entry.el.classList.remove('badge-loading');
		entry.el.classList.add('badge-ready');
		if (entry.labelEl) entry.labelEl.textContent = 'Veloce';
	}

	function storeFormats(url, formats) {
		if (!formats?.length) return;
		const key = normalizeBadgeKey(url);
		localFormatCache.set(key, formats);
		markBadgeReady(key);
	}

	function isNearViewport(el, margin = BADGE_MARGIN_PX) {
		if (!el?.getBoundingClientRect) return false;
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && r.bottom > -margin && r.top < window.innerHeight + margin;
	}

	function isSocialFeedPage() {
		return VIDEO_SITES.test(location.hostname) &&
			!/\/(p|reel|tv)\/[^/?#]+/.test(location.pathname);
	}

	function eagerPrefetch(url) {
		prefetchPageUrls([{ url, priority: true }]);
	}

	/** Queue format fetch — skips when tab hidden; caps batch size. */
	function prefetchPageUrls(entries) {
		if (document.hidden) return;
		const sorted = [...entries].sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0));
		const batch = [];
		for (const { url, priority } of sorted) {
			const key = normalizeBadgeKey(url);
			if (localFormatCache.has(key) || prefetchStarted.has(key)) continue;
			if (batch.length >= MAX_PREFETCH_BATCH) break;
			prefetchStarted.add(key);
			batch.push({ url, priority: !!priority });
		}
		if (!batch.length) return;
		try {
			chrome.runtime.sendMessage({ type: 'VELOCE_PREFETCH_BATCH', urls: batch });
		} catch { /* ignore */ }
	}

	if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
		chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
			if (msg.type === 'VELOCE_FETCH_BLOB' && msg.url) {
				(async () => {
					try {
						const res = await fetch(msg.url);
						if (!res.ok) throw new Error(`HTTP ${res.status}`);
						const blob = await res.blob();
						const buf = await blob.arrayBuffer();
						const bytes = new Uint8Array(buf);
						let binary = '';
						const chunk = 8192;
						for (let i = 0; i < bytes.length; i += chunk) {
							binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
						}
						sendResponse({
							ok: true,
							base64: btoa(binary),
							mime: blob.type || 'application/octet-stream',
							size: bytes.length
						});
					} catch (e) {
						sendResponse({ ok: false, error: String(e) });
					}
				})();
				return true;
			}
			if (msg.type === 'VELOCE_STATE') {
				coordinatorOnline = msg.connected === true;
			}
			if (msg.type === 'VELOCE_FORMATS_READY' && msg.url && msg.formats?.length) {
				storeFormats(msg.url, msg.formats);
				if (openMenu && pendingMenuUrl === normalizeBadgeKey(msg.url)) {
					const closeBtn = openMenu.querySelector('.menu-close');
					const loading = openMenu.querySelector('.menu-loading');
					if (loading) loading.remove();
					showFormatsInMenu(openMenu, closeBtn, msg.formats, msg.url, null);
					pendingMenuUrl = null;
				}
			}
			if (msg.type === 'VELOCE_FORMATS_FAILED' && msg.url) {
				prefetchStarted.delete(normalizeBadgeKey(msg.url));
			}
		});
	}


	function closeMenu() {
		if (openMenu) {
			openMenu.remove();
			openMenu = null;
		}
		pendingMenuUrl = null;
	}

	document.addEventListener('click', (e) => {
		if (openMenu && !e.composedPath().includes(host)) closeMenu();
	}, true);

	function iconSvg() {
		const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		s.setAttribute('viewBox', '0 0 24 24');
		s.setAttribute('fill', 'none');
		s.setAttribute('stroke', 'currentColor');
		s.setAttribute('stroke-width', '2.5');
		const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		p.setAttribute('d', 'M12 3v12m0 0l4-4m-4 4l-4-4M4 19h16');
		s.appendChild(p);
		return s;
	}

	function removeBadge(key) {
		const entry = badges.get(key);
		if (!entry) return;
		entry.el.remove();
		badges.delete(key);
		badgeKeys.delete(key);
	}

	function pruneBadges() {
		for (const [key, entry] of badges) {
			if (!entry.root?.isConnected) removeBadge(key);
		}
	}

	let badgeLayoutQueued = false;

	function scheduleBadgeLayout() {
		if (badgeLayoutQueued || badges.size === 0) return;
		badgeLayoutQueued = true;
		requestAnimationFrame(() => {
			badgeLayoutQueued = false;
			for (const [, entry] of badges) {
				const { el, root } = entry;
				if (!root?.isConnected) continue;
				const rect = root.getBoundingClientRect();
				if (rect.width === 0 && rect.height === 0) {
					el.style.display = 'none';
					continue;
				}
				el.style.display = 'flex';
				el.style.top = `${Math.max(4, rect.top + 4)}px`;
				el.style.left = `${Math.max(4, Math.min(rect.right - 72, window.innerWidth - 80))}px`;
			}
		});
	}

	window.addEventListener('scroll', scheduleBadgeLayout, { passive: true });
	window.addEventListener('resize', scheduleBadgeLayout, { passive: true });

	function placeBadge(resolvedUrl, anchor, rawUrl, startPrefetch = false) {
		const badgeKey = normalizeBadgeKey(resolvedUrl);
		const root = findBadgeRoot(anchor);

		if (badgeKeys.has(badgeKey)) return;

		const el = document.createElement('div');
		el.className = 'badge badge-loading';
		el.appendChild(iconSvg());
		const label = document.createElement('span');
		label.textContent = 'Veloce';
		el.appendChild(label);

		el.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			openFormatMenu(resolvedUrl, anchor, el);
		});

		shadow.appendChild(el);
		badgeKeys.add(badgeKey);
		badges.set(badgeKey, { el, anchor, root, rawUrl, resolvedUrl, labelEl: label });

		if (localFormatCache.has(badgeKey)) {
			markBadgeReady(badgeKey);
		} else if (startPrefetch) {
			prefetchPageUrls([{ url: resolvedUrl }]);
		}

		scheduleBadgeLayout();
	}

	function positionMenu(menu, badgeEl) {
		const rect = badgeEl.getBoundingClientRect();
		const menuH = Math.min(280, window.innerHeight - 16);
		let top = rect.bottom + 4;
		if (top + menuH > window.innerHeight - 8) {
			top = Math.max(8, rect.top - menuH - 4);
		}
		let left = rect.left;
		if (left + 240 > window.innerWidth - 8) {
			left = window.innerWidth - 248;
		}
		menu.style.top = `${top}px`;
		menu.style.left = `${Math.max(8, left)}px`;
	}

	function showLoadingStatus(menu, closeBtn) {
		const status = document.createElement('div');
		status.className = 'menu-status menu-loading';

		const spinner = document.createElement('div');
		spinner.className = 'menu-spinner';
		status.appendChild(spinner);

		const text = document.createElement('span');
		text.textContent = 'Loading formats…';
		status.appendChild(text);

		menu.insertBefore(status, closeBtn);

		const t0 = Date.now();
		const timer = setInterval(() => {
			const secs = Math.floor((Date.now() - t0) / 1000);
			if (secs > 0) text.textContent = `Loading formats… ${secs}s`;
		}, 400);

		return {
			stop() {
				clearInterval(timer);
				status.remove();
			},
			setInstant() {
				clearInterval(timer);
				text.textContent = 'Ready';
			}
		};
	}

	function renderFormatButtons(menu, closeBtn, formats, url) {
		for (const fmt of formats) {
			const btn = document.createElement('button');
			btn.className = 'menu-item';
			btn.textContent = fmt.label;
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				closeMenu();
				const stem = fmt.label.split(' — ')[0] || 'download';
				const fileName = `${stem}${fmt.ext || '.mp4'}`.replace(/[\\/:*?"<>|]/g, '_');
				chrome.storage.local.get(['veloce_base_dir', 'veloce_intercept'], (cfg) => {
					const payload = {
						url,
						directUrl: fmt.url,
						fileName,
						ext: fmt.ext,
						baseDirectory: cfg.veloce_base_dir || undefined,
						threads: 8
					};
					chrome.runtime.sendMessage({ type: 'VELOCE_NEW_DOWNLOAD', payload });
				});
			});
			menu.insertBefore(btn, closeBtn);
		}
	}

	function showFormatsInMenu(menu, closeBtn, formats, url, loading) {
		if (loading) loading.stop();
		renderFormatButtons(menu, closeBtn, formats, url);
	}

	function openFormatMenu(resolvedUrl, anchor, badgeEl) {
		const url = resolvedUrl || resolveDownloadUrl(anchor?.currentSrc || anchor?.src || anchor?.href, anchor);
		closeMenu();
		const menu = document.createElement('div');
		menu.className = 'menu';

		const title = document.createElement('div');
		title.className = 'menu-title';
		title.textContent = 'Select format';
		menu.appendChild(title);

		const closeBtn = document.createElement('button');
		closeBtn.className = 'menu-close';
		closeBtn.textContent = 'Close';
		closeBtn.addEventListener('click', closeMenu);
		menu.appendChild(closeBtn);

		shadow.appendChild(menu);
		openMenu = menu;
		positionMenu(menu, badgeEl);

		if (!url) {
			const err = document.createElement('div');
			err.className = 'menu-status';
			err.textContent = 'No downloadable URL found for this item.';
			menu.insertBefore(err, closeBtn);
			return;
		}

		const badgeKey = normalizeBadgeKey(url);
		const cached = localFormatCache.get(badgeKey);
		if (cached?.length) {
			showFormatsInMenu(menu, closeBtn, cached, url, null);
			return;
		}

		let busyPort = null;
		try {
			busyPort = chrome.runtime.connect({ name: 'veloce-busy' });
		} catch { /* ignore */ }

		const loading = showLoadingStatus(menu, closeBtn);
		pendingMenuUrl = badgeKey;
		eagerPrefetch(url);

		chrome.runtime.sendMessage({ type: 'VELOCE_LIST_FORMATS', url }, (resp) => {
			if (busyPort) {
				try { busyPort.disconnect(); } catch { /* ignore */ }
				busyPort = null;
			}
			if (!openMenu) return;

			if (resp?.formats?.length) storeFormats(url, resp.formats);
			if (resp?.cached) loading.setInstant();
			loading.stop();

			if (!resp || resp.type === 'FORMATS_ERROR' || !resp.formats?.length) {
				const err = document.createElement('div');
				err.className = 'menu-status';
				err.textContent = resp?.error || 'No formats found. Is the backend running?';
				menu.insertBefore(err, closeBtn);
				return;
			}

			showFormatsInMenu(menu, closeBtn, resp.formats, url, null);
			pendingMenuUrl = null;
		});
	}


	function shouldWatchLink(a) {
		try {
			const href = a.href;
			if (!href || href.startsWith('javascript:') || !isHttpUrl(href)) return false;
			if (CDN_IMAGE.test(href) && /\.(jpe?g|webp|png|gif)(\?|#|$)/i.test(href)) return false;
			// Feed pages: video nodes resolve the same post URL — skip link observers.
			if (VIDEO_SITES.test(location.hostname) && /\/(p|reel|tv)\//.test(href)) {
				return !isSocialFeedPage();
			}
			return a.hasAttribute('download') || FILE_EXT.test(href);
		} catch {
			return false;
		}
	}

	/** Show badge when near viewport; prefetch only when close enough to likely click. */
	function processMediaElement(el) {
		if (!el || el.getAttribute(SCANNED_ATTR) || document.hidden) return null;
		const rawUrl = el.tagName === 'A' ? el.href : (el.currentSrc || el.src);
		if (!rawUrl) return null;
		const url = resolveDownloadUrl(rawUrl, el);
		if (!url) return null;
		el.setAttribute(SCANNED_ATTR, '1');
		try { mediaIo.unobserve(el); } catch { /* ignore */ }
		const startPrefetch = isNearViewport(el, PREFETCH_MARGIN_PX);
		if (!badgeKeys.has(normalizeBadgeKey(url))) placeBadge(url, el, rawUrl, startPrefetch);
		return url;
	}

	let watchBudget = 30;

	function watchElement(el) {
		if (!el || el.getAttribute(WATCH_ATTR) || watchBudget <= 0) return;
		const tag = el.tagName;
		if (tag === 'A') {
			if (!shouldWatchLink(el)) return;
		} else if (tag !== 'VIDEO' && tag !== 'AUDIO') {
			return;
		}
		watchBudget--;
		el.setAttribute(WATCH_ATTR, '1');
		mediaIo.observe(el);
		if (isNearViewport(el, BADGE_MARGIN_PX)) processMediaElement(el);
	}

	function scanSubtree(root) {
		if (!root?.querySelectorAll) return;
		if (root.nodeType === 1) watchElement(root);
		root.querySelectorAll(
			'a[href]:not([data-veloce-watch]), video:not([data-veloce-watch]), audio:not([data-veloce-watch])'
		).forEach(watchElement);
	}

	const mediaIo = new IntersectionObserver(
		(entries) => {
			if (document.hidden) return;
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				processMediaElement(entry.target);
			}
		},
		{ rootMargin: `${BADGE_MARGIN_PX}px`, threshold: 0.01 }
	);

	function scan() {
		pruneBadges();
		watchBudget = 30;
		scanSubtree(document);
	}

	document.addEventListener('click', (e) => {
		const a = e.target.closest?.('a[href]');
		if (!a) return;
		const href = a.href;
		if (!href || !isHttpUrl(href)) return;
		if (!a.hasAttribute('download') && !FILE_EXT.test(href)) return;

		// Only intercept when the coordinator is online. preventDefault MUST run
		// synchronously here — deferring it (e.g. inside a sendMessage callback)
		// lets the browser start a native download, which chrome.downloads.onCreated
		// would then turn into a duplicate of the one the format menu starts.
		if (!coordinatorOnline) return;
		e.preventDefault();
		e.stopPropagation();
		openFormatMenu(resolveDownloadUrl(href, a) || href, a, a);
	}, true);

	let scanTimer = null;
	let pendingMutations = [];

	function scheduleScan() {
		clearTimeout(scanTimer);
		scanTimer = setTimeout(() => {
			scanTimer = null;
			watchBudget = 30;
			const batch = pendingMutations.splice(0);
			for (const m of batch) {
				for (const node of m.addedNodes) {
					if (node.nodeType !== 1) continue;
					scanSubtree(node);
					if (watchBudget <= 0) break;
				}
				if (watchBudget <= 0) break;
			}
		}, 600);
	}

	scan();
	const observer = new MutationObserver((mutations) => {
		pendingMutations.push(...mutations);
		scheduleScan();
	});
	observer.observe(document.documentElement, { childList: true, subtree: true });
	setInterval(pruneBadges, 30000);
})();
