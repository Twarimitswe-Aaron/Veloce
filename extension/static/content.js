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
	const badgeRoots = new WeakSet();
	const localFormatCache = new Map(); // badgeKey -> formats[]
	const prefetchStarted = new Set(); // badgeKey
	let openMenu = null;
	let pendingMenuUrl = null;

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

	function eagerPrefetch(url) {
		const key = normalizeBadgeKey(url);
		if (localFormatCache.has(key) || prefetchStarted.has(key)) return;
		prefetchStarted.add(key);
		try {
			chrome.runtime.sendMessage({ type: 'VELOCE_PREFETCH_FORMATS', url });
		} catch { /* ignore */ }
	}

	// Prefetch as media scrolls near the viewport — before the user clicks.
	const viewportPrefetch = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			const el = entry.target;
			const tag = el.tagName?.toLowerCase();
			const raw = tag === 'a' ? el.href : (el.currentSrc || el.src);
			if (!raw) continue;
			const resolved = resolveDownloadUrl(raw, el);
			if (resolved) eagerPrefetch(resolved);
		}
	}, { rootMargin: '240px', threshold: 0.05 });

	function observeForPrefetch(el) {
		if (!el || el.__velocePrefetchObserved) return;
		el.__velocePrefetchObserved = true;
		viewportPrefetch.observe(el);
	}

	if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
		chrome.runtime.onMessage.addListener((msg) => {
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
		});
	}

	try {
		chrome.runtime.sendMessage({ type: 'VELOCE_WARMUP' });
	} catch { /* ignore */ }

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

	function placeBadge(resolvedUrl, anchor, rawUrl) {
		const badgeKey = normalizeBadgeKey(resolvedUrl);
		const root = findBadgeRoot(anchor);

		if (badgeKeys.has(badgeKey) || badgeRoots.has(root)) return;

		const el = document.createElement('div');
		el.className = 'badge badge-loading';
		el.appendChild(iconSvg());
		const label = document.createElement('span');
		label.textContent = '…';
		el.appendChild(label);

		el.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			openFormatMenu(rawUrl, anchor, el);
		});

		shadow.appendChild(el);
		badgeKeys.add(badgeKey);
		badgeRoots.add(root);
		badges.set(badgeKey, { el, anchor, root, rawUrl, resolvedUrl, labelEl: label });

		if (localFormatCache.has(badgeKey)) {
			markBadgeReady(badgeKey);
		}

		const updatePos = () => {
			const rect = root.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) {
				el.style.display = 'none';
				return;
			}
			el.style.display = 'flex';
			el.style.top = `${Math.max(4, rect.top + 4)}px`;
			el.style.left = `${Math.max(4, Math.min(rect.right - 72, window.innerWidth - 80))}px`;
		};
		updatePos();
		const ro = new ResizeObserver(updatePos);
		ro.observe(root);
		window.addEventListener('scroll', updatePos, { passive: true });
		window.addEventListener('resize', updatePos, { passive: true });
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

	function showLoadingStatus(menu, closeBtn, rawUrl) {
		const status = document.createElement('div');
		status.className = 'menu-status menu-loading';

		const spinner = document.createElement('div');
		spinner.className = 'menu-spinner';
		status.appendChild(spinner);

		const text = document.createElement('span');
		text.textContent = isBrowserOnlyUrl(rawUrl) ? 'Resolving post URL…' : 'Loading formats…';
		status.appendChild(text);

		menu.insertBefore(status, closeBtn);

		const t0 = Date.now();
		const timer = setInterval(() => {
			const secs = Math.floor((Date.now() - t0) / 1000);
			if (secs > 0) {
				text.textContent = isBrowserOnlyUrl(rawUrl)
					? `Resolving post URL… ${secs}s`
					: `Loading formats… ${secs}s`;
			}
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
			});
			menu.insertBefore(btn, closeBtn);
		}
	}

	function showFormatsInMenu(menu, closeBtn, formats, url, loading) {
		if (loading) loading.stop();
		renderFormatButtons(menu, closeBtn, formats, url);
	}

	function openFormatMenu(rawUrl, anchor, badgeEl) {
		const url = resolveDownloadUrl(rawUrl, anchor);
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
			err.textContent = isBrowserOnlyUrl(rawUrl)
				? 'This video uses a browser-only blob URL. Veloce will use the Instagram post link — open the post (/p/…) or click the badge on the video card in your feed after reloading the extension.'
				: 'No downloadable URL found for this item.';
			menu.insertBefore(err, closeBtn);
			return;
		}

		const badgeKey = normalizeBadgeKey(url);
		const cached = localFormatCache.get(badgeKey);
		if (cached?.length) {
			showFormatsInMenu(menu, closeBtn, cached, url, null);
			return;
		}

		// Still loading from eager prefetch — keep menu open with spinner briefly.
		let busyPort = null;
		try {
			busyPort = chrome.runtime.connect({ name: 'veloce-busy' });
		} catch { /* ignore */ }

		const loading = showLoadingStatus(menu, closeBtn, rawUrl);
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

	function scan() {
		pruneBadges();

		function tryBadge(rawUrl, anchor) {
			const url = resolveDownloadUrl(rawUrl, anchor);
			if (!url) return;
			const badgeKey = normalizeBadgeKey(url);
			const root = findBadgeRoot(anchor);

			observeForPrefetch(anchor);
			eagerPrefetch(url);

			if (badgeKeys.has(badgeKey) || badgeRoots.has(root)) return;
			placeBadge(url, anchor, rawUrl);
		}

		document.querySelectorAll('a[href]').forEach((a) => {
			try {
				const href = a.href;
				if (!href || href.startsWith('javascript:') || !isHttpUrl(href)) return;
				if (CDN_IMAGE.test(href) && /\.(jpe?g|webp|png|gif)(\?|#|$)/i.test(href)) return;
				if (a.hasAttribute('download') || FILE_EXT.test(href)) {
					observeForPrefetch(a);
					const resolved = resolveDownloadUrl(href, a);
					if (resolved) eagerPrefetch(resolved);
					tryBadge(href, a);
				}
			} catch { /* ignore */ }
		});

		document.querySelectorAll('video, audio').forEach((el) => {
			const src = el.currentSrc || el.src;
			if (src) {
				observeForPrefetch(el);
				tryBadge(src, el);
			}
		});
	}

	document.addEventListener('click', (e) => {
		const a = e.target.closest?.('a[href]');
		if (!a) return;
		const href = a.href;
		if (!href || !isHttpUrl(href)) return;
		if (!a.hasAttribute('download') && !FILE_EXT.test(href)) return;

		chrome.runtime.sendMessage({ type: 'VELOCE_GET_STATE' }, (state) => {
			if (!state?.connected) return;
			e.preventDefault();
			e.stopPropagation();
			openFormatMenu(href, a, a);
		});
	}, true);

	scan();
	const observer = new MutationObserver(() => scan());
	observer.observe(document.documentElement, { childList: true, subtree: true });
	setInterval(scan, 2000);
})();
