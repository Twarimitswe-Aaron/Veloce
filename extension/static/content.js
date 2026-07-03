// Veloce content script — finds downloadable resources on the page, shows a
// floating navy badge on each, and opens a format picker that starts a download
// immediately when the user picks one.

(function () {
	if (window.__veloceContentLoaded) return;
	window.__veloceContentLoaded = true;

	console.log('%c[Veloce] content script active', 'color:#00ff9d;font-weight:bold', location.href);

	// Page hook is injected via manifest MAIN-world content_script — no backup <script> tag.

	const FILE_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|mp3|wav|flac|ogg|m4a|zip|rar|7z|tar|gz|bz2|pdf|png|jpe?g|gif|webp|svg|docx?|xlsx?|pptx?|csv|json|xml|iso)(\?|#|$)/i;
	const VIDEO_SITES = /youtube\.com|youtu\.be|instagram\.com|tiktok\.com|twitter\.com|x\.com|vimeo\.com|facebook\.com|twitch\.tv|mediafire\.com/i;
	const CDN_IMAGE = /fbcdn\.net|cdninstagram\.com/i;
	const CARD_WATCH_ATTR = 'data-veloce-card-watch';

	/** Site handlers — see extension/static/sites/*.js */
	let siteHandlers = [];
	let yt = null;
	let ig = null;
	let omni = null;

	function initSiteHandlers(ctx) {
		siteHandlers = window.__veloceCreateSiteHandlers?.(ctx) || [];
		yt = siteHandlers.find((h) => h.id === 'youtube') || null;
		ig = siteHandlers.find((h) => h.id === 'instagram') || null;
		omni = siteHandlers.find((h) => h.id === 'omnisave') || null;
	}

	function isYoutubeHost() { return !!yt?.isHost?.(); }
	function isInstagramHost() { return !!ig?.isHost?.(); }
	function isInstagramStoriesPage() { return !!ig?.isStoriesPage?.(); }
	function isInstagramPostPage() { return !!ig?.isPostPage?.(); }
	function isYoutubeWatchPage() { return !!yt?.isWatchPage?.(); }
	function canonicalYoutubeUrl(href) { return yt?.canonicalUrl?.(href) ?? null; }
	function canonicalInstagramPostUrl(href) { return ig?.canonicalPostUrl?.(href) ?? null; }
	function canonicalInstagramStoryUrl(href) { return ig?.canonicalStoryUrl?.(href) ?? null; }
	function findYoutubeFeedCard(el) { return yt?.findFeedCard?.(el) ?? null; }
	function findYoutubeWatchUrl(el) { return yt?.findWatchUrl?.(el) ?? null; }
	function findYoutubeLayoutElInCard(card) { return yt?.findLayoutElInCard?.(card) ?? null; }
	function findPostUrl(el) { return ig?.findPostUrl?.(el) ?? null; }

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

	function resolveInterceptListUrl(pageUrl, interceptUrl) {
		if (interceptUrl && isInterceptableMediaUrl(interceptUrl) && !isInterceptTrapUrl(interceptUrl)) {
			return interceptUrl;
		}
		if (pageUrl && isHttpUrl(pageUrl)) return pageUrl;
		return interceptUrl || pageUrl || '';
	}

	function formatsFromDownloadAnchor(anchor) {
		const href = anchor?.href;
		if (!href || !isHttpUrl(href)) return null;
		let fileName = anchor.getAttribute('download') || '';
		if (!fileName) {
			try {
				fileName = decodeURIComponent(new URL(href).pathname.split('/').filter(Boolean).pop() || 'download');
			} catch {
				fileName = 'download';
			}
		}
		const dot = fileName.lastIndexOf('.');
		const ext = dot > 0 ? fileName.slice(dot) : (
			/\.(srt|vtt|ass|ssa)(\?|#|$)/i.test(href) ? '.srt' : '.mp4'
		);
		let formats = [{ id: 'intercept', label: dot > 0 ? fileName.slice(0, dot).replace(/_/g, ' ') : fileName, url: href, ext, fileName }];
		if (omni?.patchDownloadAnchorFormats) {
			formats = omni.patchDownloadAnchorFormats(formats, fileName, href);
		}
		return formats;
	}

	const INTERCEPT_MEDIA_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|mp3|wav|flac|ogg|m4a|zip|rar|7z|tar|gz|bz2|pdf|png|jpe?g|gif|webp|svg|iso)(\?|#|$)/i;

	function isInterceptableMediaUrl(url) {
		try {
			const u = new URL(url);
			if (!/^https?:$/i.test(u.protocol)) return false;
			return INTERCEPT_MEDIA_EXT.test(u.pathname);
		} catch {
			return false;
		}
	}

	function isInterceptTrapUrl(url) {
		try {
			const u = new URL(url);
			const path = u.pathname.toLowerCase();
			if (/\/redirect|\/pkg\/|\/api\/|\/graphql|\/download\?/i.test(path)) return true;
			if (/redirect|download/i.test(u.searchParams.get('a') || '')) return true;
			if (isInterceptableMediaUrl(url)) return false;
			return !INTERCEPT_MEDIA_EXT.test(u.pathname);
		} catch {
			return false;
		}
	}



	/**
	 * Map a raw media URL to something the backend / yt-dlp can fetch.
	 * Instagram feed cards play video via blob: — the real target is the post link
	 * (e.g. /p/DaL1ZkHiS29/), NOT location.href (which is just instagram.com/).
	 */
	function resolveDownloadUrl(raw, anchor) {
		if (!raw) return null;

		for (const h of siteHandlers) {
			if (!h.isHost?.() || !h.resolveDownloadUrl) continue;
			const resolved = h.resolveDownloadUrl(raw, anchor);
			if (resolved) return resolved;
		}

		if (isBrowserOnlyUrl(raw)) {
			if (!VIDEO_SITES.test(location.hostname)) return null;
			const post = anchor ? findPostUrl(anchor) : null;
			if (post) return post;
			const ytUrl = canonicalYoutubeUrl();
			if (ytUrl) return ytUrl;
			if (/\/(p|reel|tv)\//.test(location.pathname)) {
				return canonicalInstagramPostUrl(location.href) || location.href.split('?')[0];
			}
			return null;
		}

		if (!isHttpUrl(raw)) return null;
		return raw;
	}

	/** Canonical cache key — must match backend/background normalizeFormatUrl. */
	function normalizeBadgeKey(url) {
		for (const h of siteHandlers) {
			if (!h.normalizeKey) continue;
			const key = h.normalizeKey(url);
			if (key) return key;
		}
		try {
			const u = new URL(url);
			u.hash = '';
			if (VIDEO_SITES.test(u.hostname) && /\/(p|reels?|tv)\//.test(u.pathname)) {
				const p = u.pathname.replace(/\/reels\//i, '/reel/').replace(/\/+$/, '');
				return `${u.origin}${p}`;
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

		for (const h of siteHandlers) {
			if (!h.isHost?.() || !h.findBadgeRoot) continue;
			const root = h.findBadgeRoot(anchor);
			if (root) return root;
		}

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
		:host {
			all: initial;
			position: fixed !important;
			inset: 0 !important;
			width: 100vw !important;
			height: 100vh !important;
			z-index: 2147483647 !important;
			pointer-events: none !important;
			overflow: visible !important;
		}
		* { box-sizing: border-box; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }
		.badge {
			position: fixed;
			z-index: 2147483647;
			pointer-events: auto;
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
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
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
			pointer-events: auto;
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
		.menu-item-playlist {
			font-weight: 600;
			background: rgba(0, 255, 157, 0.08);
			border-bottom: 1px solid rgba(0, 255, 157, 0.25);
		}
		.menu-item-playlist:hover { background: rgba(0, 255, 157, 0.16); }
		.menu-item-recommended { font-weight: 600; }
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
	const MAX_PREFETCH_BATCH = 8;
	const BADGE_MARGIN_PX = 200;
	/** Prefetch uses same margin as badges — start loading formats when the badge appears. */
	const PREFETCH_MARGIN_PX = BADGE_MARGIN_PX;
	const SCANNED_ATTR = 'data-veloce-scanned';
	const WATCH_ATTR = 'data-veloce-watch';
	const TAB_PING_MS = 25000;
	let openMenu = null;
	let pendingMenuUrl = null;
	let tabPort = null;
	let tabPingTimer = null;
	// Cached coordinator state so the link-click handler can preventDefault()
	// synchronously — otherwise the native download starts before an async check
	// returns, and chrome.downloads.onCreated would create a second copy.
	let coordinatorOnline = false;
	/** Only the active tab in the focused window may show badges or prefetch. */
	let isForegroundTab = !document.hidden;
	let suspendTimer = null;

	function captureActive() {
		return isForegroundTab && !document.hidden;
	}

	function suspendCapture() {
		closeMenu();
		for (const key of [...badgeKeys]) removeBadge(key);
		document.querySelectorAll(`[${WATCH_ATTR}], [${SCANNED_ATTR}]`).forEach((el) => {
			try { mediaIo.unobserve(el); } catch { /* ignore */ }
			el.removeAttribute(WATCH_ATTR);
			el.removeAttribute(SCANNED_ATTR);
		});
		// Keep the tab port alive — pings wake the service worker for message routing.
		if (!tabPort) connectTabPort();
		if (!tabPingTimer) startTabPing();
	}

	function resumeCapture() {
		if (!captureActive()) return;
		connectTabPort();
		startTabPing();
		scan();
	}

	function syncForegroundState(active) {
		const was = isForegroundTab;
		if (suspendTimer) {
			clearTimeout(suspendTimer);
			suspendTimer = null;
		}
		if (active === true) {
			isForegroundTab = true;
			if (ensureForegroundPolling.timer) {
				clearInterval(ensureForegroundPolling.timer);
				ensureForegroundPolling.timer = null;
			}
			if (!was || document.visibilityState === 'visible') {
				resumeCapture();
			}
			return;
		}
		// Debounce suspend — SW can report false once before foregroundTabId is ready.
		suspendTimer = setTimeout(() => {
			suspendTimer = null;
			if (document.hidden) return;
			isForegroundTab = false;
			suspendCapture();
			ensureForegroundPolling();
		}, 450);
	}

	function queryForegroundState() {
		if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
		chrome.runtime.sendMessage({ type: 'VELOCE_AM_I_FOREGROUND' }, (r) => {
			if (chrome.runtime.lastError) return;
			syncForegroundState(!!r?.active);
		});
	}

	function ensureForegroundPolling() {
		if (ensureForegroundPolling.timer) return;
		ensureForegroundPolling.timer = setInterval(() => {
			if (document.hidden) return;
			if (isForegroundTab) {
				clearInterval(ensureForegroundPolling.timer);
				ensureForegroundPolling.timer = null;
				return;
			}
			queryForegroundState();
		}, 1500);
	}
	ensureForegroundPolling.timer = null;

	if (typeof chrome !== 'undefined' && chrome.storage?.local) {
		chrome.storage.local.get('veloce_connected', (r) => {
			coordinatorOnline = r.veloce_connected === true;
			coordinatorStateReady = true;
			syncInjectCoordinatorState();
		});
		chrome.storage.onChanged?.addListener((changes, area) => {
			if (area === 'local' && changes.veloce_connected) {
				coordinatorOnline = changes.veloce_connected.newValue === true;
				syncInjectCoordinatorState();
			}
		});
	}

	function connectTabPort() {
		try {
			if (tabPort) return;
			tabPort = chrome.runtime.connect({ name: 'veloce-tab' });
			tabPort.onMessage.addListener((msg) => {
				if (msg?.type === 'VELOCE_FOREGROUND_STATE') {
					syncForegroundState(msg.active === true);
				}
			});
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

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') {
			queryForegroundState();
		} else {
			suspendCapture();
		}
	});
	window.addEventListener('pageshow', () => queryForegroundState());
	window.addEventListener('focus', () => queryForegroundState());

	queryForegroundState();

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
		if (!VIDEO_SITES.test(location.hostname)) return false;
		if (isDedicatedMediaPage()) return false;
		return !/\/(p|reel|tv)\/[^/?#]+/.test(location.pathname);
	}

	function isDedicatedMediaPage() {
		if (!VIDEO_SITES.test(location.hostname)) return false;
		if (isYoutubeWatchPage()) return true;
		if (/youtu\.be/i.test(location.hostname) && location.pathname.length > 1) return true;
		if (isInstagramHost() && isInstagramStoriesPage()) return true;
		return /\/(p|reel|tv)\/[^/?#]+/.test(location.pathname);
	}

	function shouldBadgeMediaElement(el) {
		for (const h of siteHandlers) {
			if (!h.isHost?.() || !h.shouldBadgeElement) continue;
			const ok = h.shouldBadgeElement(el);
			if (ok === false) return false;
		}
		return true;
	}

	/** Primary modal player — largest visible video dialog (main reel, not DM sidebar). */
	function findMediaOverlay() {
		let best = null;
		let bestArea = 0;
		for (const d of document.querySelectorAll('[role="dialog"], [aria-modal="true"]')) {
			try {
				const st = getComputedStyle(d);
				if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
			} catch { /* ignore */ }
			const dr = d.getBoundingClientRect();
			if (dr.width < 160 || dr.height < 160) continue;
			const video = d.querySelector('video');
			if (!video) continue;
			const vis = visibleMediaRect(video) || clipRectToViewport(video.getBoundingClientRect());
			if (!vis || vis.width < 80 || vis.height < 80) continue;
			const area = vis.width * vis.height;
			if (area > bestArea) {
				bestArea = area;
				best = d;
			}
		}
		return best;
	}

	/**
	 * Painted video/audio bounds inside the element box (object-fit letterboxing).
	 * Instagram reel players often use a viewport-sized <video> with pillarboxed content.
	 */
	function visibleMediaRect(el) {
		if (!el?.getBoundingClientRect) return null;
		const box = el.getBoundingClientRect();
		if (box.width <= 0 || box.height <= 0) return null;

		const tag = el.tagName?.toLowerCase();
		if (tag !== 'video' && tag !== 'audio') {
			return clipRectToViewport(box);
		}

		const vw = el.videoWidth;
		const vh = el.videoHeight;
		if (!vw || !vh) {
			// Full-viewport element before metadata — don't pin badge to window corner yet.
			if (box.width >= window.innerWidth * 0.9 && box.height >= window.innerHeight * 0.5) {
				return null;
			}
			return clipRectToViewport(box);
		}

		let fit = 'contain';
		try {
			fit = getComputedStyle(el).objectFit || 'contain';
		} catch { /* ignore */ }

		const cw = box.width;
		const ch = box.height;
		let rw = cw;
		let rh = ch;
		let ox = 0;
		let oy = 0;

		if (fit === 'fill') {
			// use full box
		} else if (fit === 'cover') {
			// cropped to fill — badge on element box is fine
		} else if (fit === 'none') {
			rw = Math.min(vw, cw);
			rh = Math.min(vh, ch);
			ox = (cw - rw) / 2;
			oy = (ch - rh) / 2;
		} else {
			// contain / scale-down
			const arEl = cw / ch;
			const arVid = vw / vh;
			if (arVid > arEl) {
				rw = cw;
				rh = cw / arVid;
				ox = 0;
				oy = (ch - rh) / 2;
			} else {
				rh = ch;
				rw = ch * arVid;
				ox = (cw - rw) / 2;
				oy = 0;
			}
		}

		return clipRectToViewport({
			left: box.left + ox,
			top: box.top + oy,
			right: box.left + ox + rw,
			bottom: box.top + oy + rh,
			width: rw,
			height: rh
		});
	}

	function mediaDisplayScore(el) {
		const vis = visibleMediaRect(el);
		return vis ? vis.width * vis.height : 0;
	}

	function clipRectToViewport(rect) {
		if (!rect || rect.width <= 0 || rect.height <= 0) return null;
		const left = Math.max(rect.left, 0);
		const top = Math.max(rect.top, 0);
		const right = Math.min(rect.right, window.innerWidth);
		const bottom = Math.min(rect.bottom, window.innerHeight);
		if (right - left < 24 || bottom - top < 16) return null;
		return { left, top, right, bottom, width: right - left, height: bottom - top };
	}

	function mediaVisibleRect(el) {
		return visibleMediaRect(el) || clipRectToViewport(el.getBoundingClientRect());
	}

	function hitTestMedia(el, cx, cy) {
		if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) return false;
		let hit = document.elementFromPoint(cx, cy);
		const root = findBadgeRoot(el);
		for (let i = 0; i < 14 && hit; i++) {
			if (hit === el || el.contains(hit)) return true;
			if (root && (hit === root || root.contains(hit))) return true;
			if (hit.id === 'veloce-host') break;
			hit = hit.parentElement;
		}
		return false;
	}

	/** True when the element is the media the user is actually looking at (not feed behind a modal). */
	function isElementForeground(el) {
		if (!el?.isConnected) return false;
		const tag = el.tagName?.toLowerCase();
		if (tag !== 'video' && tag !== 'audio' && tag !== 'a') return false;

		const overlay = findMediaOverlay();
		if (overlay) {
			if (!overlay.contains(el)) return false;
		} else if (isSocialFeedPage()) {
			if (!isNearViewport(el, 0)) return false;
		}

		const vis = mediaVisibleRect(el);
		if (!vis || vis.width < 48 || vis.height < 48) return false;

		for (const h of siteHandlers) {
			if (!h.isHost?.() || !h.isElementForeground) continue;
			const siteFg = h.isElementForeground(el);
			if (siteFg !== null && siteFg !== undefined) return siteFg;
		}

		if (isDedicatedMediaPage() && !overlay) return true;

		// Modal player: visible in-viewport video inside the dialog counts as foreground.
		if (overlay && overlay.contains(el)) return true;

		// Feed tiles: hit-test when possible; fall back to visible size (IG/TikTok overlays block center).
		if (isSocialFeedPage()) {
			return vis.width >= 64 && vis.height >= 64;
		}
		const points = [
			[vis.left + vis.width * 0.5, vis.top + vis.height * 0.38],
			[vis.left + vis.width * 0.82, vis.top + vis.height * 0.18],
			[vis.left + vis.width * 0.18, vis.top + vis.height * 0.22]
		];
		for (const [cx, cy] of points) {
			if (hitTestMedia(el, cx, cy)) return true;
		}
		return false;
	}

	function shouldReanchorBadge(entry, newAnchor) {
		if (!newAnchor?.isConnected) return false;
		if (!entry.anchor?.isConnected) return true;
		const newScore = mediaDisplayScore(newAnchor);
		const oldScore = mediaDisplayScore(entry.anchor);
		if (newScore > oldScore * 1.15) return true;
		if (isElementForeground(newAnchor) && !isElementForeground(entry.anchor)) return true;
		const overlay = findMediaOverlay();
		if (overlay && overlay.contains(newAnchor) && !overlay.contains(entry.anchor)) return true;
		return false;
	}

	/** Drop badges tied to feed tiles when a modal/overlay player is open. */
	function cullBackgroundBadges() {
		const overlay = findMediaOverlay();
		for (const [key, entry] of [...badges]) {
			if (!entry.anchor?.isConnected) {
				removeBadge(key);
				continue;
			}
			const keepOnOverlay = ig?.shouldCullOnOverlay?.() === false;
			if (overlay && !overlay.contains(entry.anchor) && !keepOnOverlay) {
				removeBadge(key);
				continue;
			}
			if (!isElementForeground(entry.anchor)) {
				entry.el.style.display = 'none';
			} else {
				entry.el.style.display = '';
			}
		}
	}

	function eagerPrefetch(url) {
		prefetchPageUrls([{ url, priority: true }]);
	}

	function shouldPrefetchUrl(url) {
		for (const h of siteHandlers) {
			if (!h.shouldPrefetchUrl) continue;
			const r = h.shouldPrefetchUrl(url);
			if (r === false) return false;
		}
		return true;
	}

	/** Start format prefetch when a badge is placed — YouTube always (badge is already near viewport). */
	function shouldStartPrefetch(resolvedUrl, anchor) {
		if (!shouldPrefetchUrl(resolvedUrl)) return false;
		for (const h of siteHandlers) {
			if (!h.isHost?.() || !h.shouldStartPrefetch) continue;
			const r = h.shouldStartPrefetch(resolvedUrl, anchor);
			if (r === true) return true;
		}
		return isNearViewport(anchor, PREFETCH_MARGIN_PX);
	}

	function cardViewportScore(card) {
		const r = card?.getBoundingClientRect?.();
		if (!r) return Infinity;
		const cardCy = r.top + r.height / 2;
		return Math.abs(cardCy - window.innerHeight / 2);
	}

	/** Queue format fetch — skips when tab hidden; caps batch size. */
	function prefetchPageUrls(entries) {
		if (!captureActive() || document.hidden) return;
		const sorted = [...entries].sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0));
		const batch = [];
		for (const { url, priority } of sorted) {
			if (!shouldPrefetchUrl(url)) continue;
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

	/**
	 * Focus prefetch on active (+ optional previous) URLs; drop other queued prefetches.
	 * Used by Instagram Reels and YouTube watch SPA navigation.
	 */
	function setPrefetchFocus(activeUrl, previousUrl) {
		if (!captureActive() || document.hidden) return;
		const activeKey = activeUrl ? normalizeBadgeKey(activeUrl) : '';
		const previousKey = previousUrl ? normalizeBadgeKey(previousUrl) : '';
		const keep = new Set([activeKey, previousKey].filter(Boolean));

		for (const key of [...prefetchStarted]) {
			if (!keep.has(key)) prefetchStarted.delete(key);
		}

		if (activeUrl && shouldPrefetchUrl(activeUrl)) {
			eagerPrefetch(activeUrl);
		}
		if (previousUrl && previousKey !== activeKey && shouldPrefetchUrl(previousUrl)) {
			prefetchPageUrls([{ url: previousUrl, priority: false }]);
		}

		try {
			chrome.runtime.sendMessage({ type: 'VELOCE_PREFETCH_FOCUS', keep: [...keep] });
		} catch { /* ignore */ }
	}

	function interceptLog(step, detail) {
		const ts = new Date().toISOString();
		if (detail !== undefined) {
			console.log(`[Veloce intercept] ${ts} ${step}`, detail);
		} else {
			console.log(`[Veloce intercept] ${ts} ${step}`);
		}
	}

	let coordinatorStateReady = false;

	function syncInjectCoordinatorState() {
		// Avoid flashing offline to page hook before chrome.storage.local has loaded.
		if (!coordinatorStateReady && !coordinatorOnline) return;
		if (syncInjectCoordinatorState.lastOnline === coordinatorOnline) return;
		syncInjectCoordinatorState.lastOnline = coordinatorOnline;
		try {
			document.documentElement?.setAttribute('data-veloce-coordinator', coordinatorOnline ? '1' : '0');
			window.postMessage({
				source: 'veloce-extension',
				type: 'VELOCE_COORDINATOR',
				online: coordinatorOnline
			}, '*');
			interceptLog('coordinator → page hook', { online: coordinatorOnline });
		} catch { /* ignore */ }
	}
	syncInjectCoordinatorState.lastOnline = null;

	function setupInjectBridge() {
		window.addEventListener('message', (e) => {
			if (e.source !== window || !e.data) return;
			const data = e.data;
			if (data.source === 'veloce-page-hook' && data.type === 'VELOCE_HOOK_LOG') {
				if (data.important) interceptLog(`page hook: ${data.step}`, data.detail);
				return;
			}
			if (data.source === 'veloce-page-hook' && data.type === 'VELOCE_DOWNLOAD_LINKS') {
				omni?.onDownloadLinksMessage?.(data);
				return;
			}
			if (data.source === 'veloce-page-hook' && data.type === 'VELOCE_INTERCEPT') {
				if (!omni?.handleInterceptRequest?.(data)) {
					handleGenericInterceptRequest(data);
				}
			}
		});
	}

	function handleGenericInterceptRequest(detail) {
		const { href, download, source } = detail || {};
		interceptLog('step 4: page hook → content script', { href, download, source, coordinatorOnline });
		if (!coordinatorOnline) {
			interceptLog('step 4b: ABORT — coordinator offline (pnpm dev + open Veloce popup, refresh tab)');
			return;
		}
		const fake = {
			href,
			getAttribute: (k) => (k === 'download' ? (download || '') : null)
		};
		let formats = formatsFromDownloadAnchor(fake);
		if (omni?.renameInterceptFormats) formats = omni.renameInterceptFormats(formats);
		if (!formats) {
			interceptLog('step 4b: ABORT — could not build format', { href, download });
			return;
		}
		interceptLog('step 5: opening Veloce format menu', formats[0]);
		if (openMenu) closeMenu();
		openFormatMenu(location.href.split('#')[0], document.body, document.body, formats);
	}

	setupInjectBridge();

	function refreshCoordinatorState(cb) {
		if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
			cb?.();
			return;
		}
		chrome.runtime.sendMessage({ type: 'VELOCE_GET_STATE' }, (r) => {
			if (!chrome.runtime.lastError && r) {
				coordinatorOnline = r.connected === true;
				syncInjectCoordinatorState();
			}
			cb?.();
		});
	}

	if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
		chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
			if (msg.type === 'VELOCE_INTERCEPT_OPEN_MENU') {
				const listUrl = msg.listUrl || msg.url || msg.pageUrl || msg.interceptUrl;
				const pageUrl = msg.pageUrl || location.href.split('#')[0];
				const interceptUrl = msg.interceptUrl || msg.url;
				interceptLog('format menu requested', {
					listUrl,
					pageUrl,
					interceptUrl,
					fileName: msg.fileName
				});
				if (!listUrl) {
					interceptLog('abort — no list url');
					return;
				}
				const anchor = document.querySelector('video, audio') || document.body;
				const badge = host || anchor;
				const preloaded = Array.isArray(msg.preloadedFormats) && msg.preloadedFormats.length
					? msg.preloadedFormats
					: (msg.interceptUrl && msg.fileName
						? formatsFromDownloadAnchor({ href: msg.interceptUrl, getAttribute: (k) => (k === 'download' ? msg.fileName : null) })
						: null);
				openFormatMenu(listUrl, anchor, badge, preloaded || undefined);
				interceptLog('format menu shown — pick a format to download');
			}
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
			if (msg.type === 'VELOCE_FOREGROUND_STATE') {
				syncForegroundState(msg.active === true);
			}
			if (msg.type === 'VELOCE_STATE') {
				coordinatorOnline = msg.connected === true;
				syncInjectCoordinatorState();
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

	/** Use the painted media box — not a full-viewport <video> letterbox wrapper. */
	function layoutRectForEntry(entry) {
		const anchor = entry.anchor;
		if (!anchor?.isConnected) return null;
		const tag = anchor.tagName?.toLowerCase();
		if (tag === 'video' || tag === 'audio') {
			return mediaVisibleRect(anchor);
		}
		if (tag === 'a') {
			const card = findYoutubeFeedCard(anchor);
			if (card) {
				const layoutEl = findYoutubeLayoutElInCard(card) || anchor;
				return clipRectToViewport(layoutEl.getBoundingClientRect());
			}
			return clipRectToViewport(anchor.getBoundingClientRect());
		}
		return clipRectToViewport(entry.root?.getBoundingClientRect?.() ?? null);
	}

	function layoutBadge(el, rect) {
		const pad = 6;
		const w = el.offsetWidth || 72;
		const h = el.offsetHeight || 28;
		// Pin top-right inside the visible media rectangle — never outside it.
		let top = rect.top + pad;
		let left = rect.right - w - pad;
		top = Math.max(rect.top + 2, Math.min(top, rect.bottom - h - 2));
		left = Math.max(rect.left + 2, Math.min(left, rect.right - w - 2));
		top = Math.max(4, Math.min(top, window.innerHeight - h - 4));
		left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
		el.style.display = 'flex';
		el.style.top = `${top}px`;
		el.style.left = `${left}px`;
		el.style.right = 'auto';
		el.style.bottom = 'auto';
	}

	function scheduleBadgeLayout() {
		if (badgeLayoutQueued || badges.size === 0) return;
		badgeLayoutQueued = true;
		requestAnimationFrame(() => {
			badgeLayoutQueued = false;
			cullBackgroundBadges();
			for (const [, entry] of badges) {
				const { el } = entry;
				if (!entry.anchor?.isConnected) continue;
				if (!isElementForeground(entry.anchor)) {
					el.style.display = 'none';
					continue;
				}
				const rect = layoutRectForEntry(entry);
				if (!rect) {
					el.style.display = 'none';
					continue;
				}
				layoutBadge(el, rect);
			}
		});
	}

	window.addEventListener('scroll', () => {
		scheduleBadgeLayout();
		yt?.scheduleScrollScan?.();
		ig?.scheduleScrollScan?.();
	}, { passive: true });
	window.addEventListener('resize', scheduleBadgeLayout, { passive: true });

	function placeBadge(resolvedUrl, anchor, rawUrl, startPrefetch = false) {
		const badgeKey = normalizeBadgeKey(resolvedUrl);
		const root = findBadgeRoot(anchor);

		const existing = badges.get(badgeKey);
		if (existing) {
			if (shouldReanchorBadge(existing, anchor)) {
				existing.anchor = anchor;
				existing.root = root;
				scheduleBadgeLayout();
			}
			return true;
		}

		// Don't create badges for feed tiles that aren't the foreground media.
		if (!isElementForeground(anchor)) return false;

		const el = document.createElement('div');
		el.className = 'badge badge-ready';
		el.appendChild(iconSvg());
		const label = document.createElement('span');
		label.textContent = 'Veloce';
		el.appendChild(label);

		el.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			const pageUrl = location.href.split('#')[0];
			try {
				const u = new URL(pageUrl);
				if (/youtube\.com/i.test(location.hostname) && u.pathname === '/playlist' && u.searchParams.get('list')) {
					openPlaylistOnlyMenu(pageUrl, el);
					return;
				}
			} catch { /* ignore */ }
			openFormatMenu(resolvedUrl, anchor, el);
		});
		el.addEventListener('mouseenter', () => {
			if (shouldPrefetchUrl(resolvedUrl)) eagerPrefetch(resolvedUrl);
		}, { passive: true });

		shadow.appendChild(el);
		badgeKeys.add(badgeKey);
		badges.set(badgeKey, { el, anchor, root, rawUrl, resolvedUrl, labelEl: label });

		if (localFormatCache.has(badgeKey)) {
			markBadgeReady(badgeKey);
		} else if (startPrefetch) {
			el.classList.add('badge-loading');
			prefetchPageUrls([{ url: resolvedUrl }]);
		}

		scheduleBadgeLayout();

		// Video dimensions often start at 0×0 until metadata loads — relayout then.
		const tag = anchor?.tagName?.toLowerCase();
		if (tag === 'video' || tag === 'audio') {
			anchor.addEventListener('loadedmetadata', () => scheduleBadgeLayout(), { once: true });
			anchor.addEventListener('loadeddata', () => scheduleBadgeLayout(), { once: true });
			anchor.addEventListener('playing', () => scheduleBadgeLayout());
		}
		return true;
	}

	function positionMenu(menu, badgeEl) {
		// Intercept menu from download modal — center on screen (modal is z-80, we are z-max)
		if (!badgeEl || badgeEl === document.body || badgeEl.closest?.('#download-modal-title, [aria-labelledby="download-modal-title"]')) {
			menu.style.top = '50%';
			menu.style.left = '50%';
			menu.style.transform = 'translate(-50%, -50%)';
			menu.style.position = 'fixed';
			return;
		}
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

	function showVeloceToast(message, isError) {
		interceptLog(isError ? 'ERROR toast' : 'OK toast', message);
		const t = document.createElement('div');
		t.textContent = message;
		t.style.cssText = [
			'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
			'z-index:2147483647', 'padding:12px 20px', 'border-radius:12px',
			'font:600 14px system-ui,sans-serif', 'color:#fff', 'max-width:90vw',
			isError ? 'background:#c0392b' : 'background:#0d6b4d',
			'box-shadow:0 8px 32px rgba(0,0,0,.45)', 'pointer-events:none'
		].join(';');
		document.body.appendChild(t);
		setTimeout(() => t.remove(), isError ? 6000 : 3500);
	}

	function appendPlaylistDownloadOption(menu, closeBtn, pageUrl) {
		yt?.appendPlaylistDownloadOption?.(menu, closeBtn, pageUrl);
	}

	function isManifestFormat(fmt) {
		return fmt.kind === 'manifest' ||
			/\.m3u8(\?|$)/i.test(fmt.url || '') ||
			/\.mpd(\?|$)/i.test(fmt.url || '');
	}

	function renderFormatButtons(menu, closeBtn, formats, url) {
		for (const fmt of formats) {
			const btn = document.createElement('button');
			btn.className = 'menu-item';
			if (fmt.id === 'best') btn.classList.add('menu-item-recommended');
			btn.textContent = fmt.label;
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				closeMenu();
				const stem = fmt.label.split(' — ')[0] || 'download';
				const fileName = (fmt.fileName || `${stem}${fmt.ext || '.mp4'}`).replace(/[\\/:*?"<>|]/g, '_');
				const pageUrl = location.href.split('#')[0];
				const sourceUrl = url && url !== fmt.url ? url : pageUrl;
				const manifest = isManifestFormat(fmt);
				const useDirect = fmt.url && fmt.id !== 'best' && !manifest;
				chrome.storage.local.get(['veloce_base_dir', 'veloce_intercept'], (cfg) => {
					const payload = {
						url: sourceUrl,
						directUrl: useDirect ? fmt.url : undefined,
						pageUrl,
						referer: pageUrl,
						fileName,
						ext: fmt.ext,
						baseDirectory: cfg.veloce_base_dir || undefined,
						threads: 8
					};
				chrome.runtime.sendMessage({ type: 'VELOCE_NEW_DOWNLOAD', payload }, (resp) => {
					if (chrome.runtime.lastError) {
						const err = chrome.runtime.lastError.message || 'extension error';
						interceptLog('step 7: FAILED — sendMessage', { err });
						showVeloceToast(`Veloce: ${err}`, true);
						return;
					}
					if (!resp?.ok) {
						interceptLog('step 7: FAILED — coordinator not reached', { resp });
						showVeloceToast('Veloce: backend offline — run: cd backend && pnpm dev', true);
						return;
					}
					interceptLog('step 7: download queued OK', { fileName, directUrl: fmt.url });
					showVeloceToast(`Veloce: downloading ${fileName}`, false);
				});
				});
			});
			menu.insertBefore(btn, closeBtn);
		}
	}

	function showFormatsInMenu(menu, closeBtn, formats, url, loading) {
		if (loading) loading.stop();
		const pageUrl = location.href.split('#')[0];
		appendPlaylistDownloadOption(menu, closeBtn, pageUrl);
		renderFormatButtons(menu, closeBtn, formats, url);
	}

	/** Playlist pages: settings-driven download only — no per-track format list. */
	function openPlaylistOnlyMenu(pageUrl, badgeEl) {
		closeMenu();
		const menu = document.createElement('div');
		menu.className = 'menu';
		const title = document.createElement('div');
		title.className = 'menu-title';
		title.textContent = 'Playlist';
		menu.appendChild(title);
		const closeBtn = document.createElement('button');
		closeBtn.className = 'menu-close';
		closeBtn.textContent = 'Close';
		closeBtn.addEventListener('click', closeMenu);
		menu.appendChild(closeBtn);
		shadow.appendChild(menu);
		openMenu = menu;
		positionMenu(menu, badgeEl);
		const hint = document.createElement('div');
		hint.className = 'menu-status';
		hint.textContent = 'Format rules come from Veloce Settings → Playlist downloads (audio / 720p / etc.).';
		menu.insertBefore(hint, closeBtn);
		appendPlaylistDownloadOption(menu, closeBtn, pageUrl);
	}

	function openFormatMenu(resolvedUrl, anchor, badgeEl, preloadedFormats) {
		const pageUrl = location.href.split('#')[0];
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

		if (!url && !preloadedFormats?.length) {
			const err = document.createElement('div');
			err.className = 'menu-status';
			err.textContent = 'No downloadable URL found for this item.';
			menu.insertBefore(err, closeBtn);
			return;
		}

		if (preloadedFormats?.length) {
			interceptLog('step 6: showing preloaded format(s)', { count: preloadedFormats.length, labels: preloadedFormats.map((f) => f.label) });
			showFormatsInMenu(menu, closeBtn, preloadedFormats, url || pageUrl);
			return;
		}

		const badgeKey = normalizeBadgeKey(url);
		const cached = localFormatCache.get(badgeKey);
		if (cached?.length) {
			showFormatsInMenu(menu, closeBtn, cached, url, null);
			return;
		}

		const loading = showLoadingStatus(menu, closeBtn);
		pendingMenuUrl = badgeKey;
		eagerPrefetch(url);

		const finishWithFormats = (formats, fromCache = false) => {
			if (!openMenu || pendingMenuUrl !== badgeKey) return;
			if (formats?.length) storeFormats(url, formats);
			if (fromCache) loading.setInstant();
			loading.stop();
			if (!formats?.length) {
				const err = document.createElement('div');
				err.className = 'menu-status';
				err.textContent = 'No formats found. Is the backend running?';
				menu.insertBefore(err, closeBtn);
				pendingMenuUrl = null;
				return;
			}
			showFormatsInMenu(menu, closeBtn, formats, url, null);
			pendingMenuUrl = null;
		};

		const finishWithError = (error) => {
			if (!openMenu || pendingMenuUrl !== badgeKey) return;
			loading.stop();
			const err = document.createElement('div');
			err.className = 'menu-status';
			err.textContent = error || 'No formats found. Is the backend running?';
			menu.insertBefore(err, closeBtn);
			pendingMenuUrl = null;
		};

		let busyPort = null;
		try {
			busyPort = chrome.runtime.connect({ name: 'veloce-busy' });
		} catch { /* ignore */ }

		// Background SW may already have formats from prefetch — show instantly without a new yt-dlp run.
		chrome.runtime.sendMessage({ type: 'VELOCE_PEEK_FORMATS', url: badgeKey }, (peek) => {
			if (chrome.runtime.lastError) { /* fall through */ }
			else if (peek?.formats?.length) {
				if (busyPort) {
					try { busyPort.disconnect(); } catch { /* ignore */ }
					busyPort = null;
				}
				finishWithFormats(peek.formats, true);
				return;
			}

			chrome.runtime.sendMessage({ type: 'VELOCE_LIST_FORMATS', url: badgeKey, force: true }, (resp) => {
				if (busyPort) {
					try { busyPort.disconnect(); } catch { /* ignore */ }
					busyPort = null;
				}
				if (!openMenu || pendingMenuUrl !== badgeKey) return;

				if (resp?.type === 'FORMATS_ERROR' || !resp?.formats?.length) {
					finishWithError(resp?.error);
					return;
				}
				finishWithFormats(resp.formats, !!resp?.cached);
			});
		});
	}


	function shouldWatchLink(a) {
		try {
			const href = a.href;
			if (!href || href.startsWith('javascript:') || !isHttpUrl(href)) return false;
			if (CDN_IMAGE.test(href) && /\.(jpe?g|webp|png|gif)(\?|#|$)/i.test(href)) return false;
			if (yt?.shouldWatchLink) {
				const ytWatch = yt.shouldWatchLink(a);
				if (ytWatch !== null && ytWatch !== undefined) return ytWatch;
			}
			// Feed pages: video nodes resolve the same post URL — skip link observers.
			if (VIDEO_SITES.test(location.hostname) && /\/(p|reel|tv)\//.test(href)) {
				return !isSocialFeedPage();
			}
			return a.hasAttribute('download') || FILE_EXT.test(href);
		} catch {
			return false;
		}
	}

	function resetScanStateDeep(root) {
		function walk(node) {
			if (!node || node.nodeType !== 1) return;
			if (node.hasAttribute?.(WATCH_ATTR) || node.hasAttribute?.(SCANNED_ATTR) || node.hasAttribute?.(CARD_WATCH_ATTR)) {
				try { mediaIo.unobserve(node); } catch { /* ignore */ }
				try { cardIo.unobserve(node); } catch { /* ignore */ }
				try { igCardIo.unobserve(node); } catch { /* ignore */ }
				node.removeAttribute(WATCH_ATTR);
				node.removeAttribute(SCANNED_ATTR);
				node.removeAttribute(CARD_WATCH_ATTR);
			}
			for (const child of node.children || []) walk(child);
			if (node.shadowRoot) walk(node.shadowRoot);
		}
		if (root?.nodeType === 1) walk(root);
	}

	const cardIo = new IntersectionObserver(
		(entries) => {
			if (!captureActive()) return;
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				yt?.processFeedCard?.(entry.target);
			}
		},
		{ rootMargin: `${BADGE_MARGIN_PX}px`, threshold: 0.01 }
	);

	const igCardIo = new IntersectionObserver(
		(entries) => {
			if (!captureActive()) return;
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				if (entry.target.tagName === 'ARTICLE') {
					ig?.processFeedArticle?.(entry.target);
				}
			}
		},
		{ rootMargin: `${BADGE_MARGIN_PX}px`, threshold: 0.01 }
	);

	function processMediaElement(el) {
		if (!captureActive() || !el || el.getAttribute(SCANNED_ATTR)) return null;
		if (!shouldBadgeMediaElement(el)) return null;

		for (const h of siteHandlers) {
			if (!h.isHost?.() || !h.processMediaElement) continue;
			const siteResult = h.processMediaElement(el);
			if (siteResult) return siteResult;
		}

		const tag = el.tagName;
		let anchor = el;
		let rawUrl = tag === 'A' ? el.href : (el.currentSrc || el.src || '');
		let url = rawUrl ? resolveDownloadUrl(rawUrl, anchor) : null;

		if (!url && tag === 'A' && isYoutubeHost()) {
			url = canonicalYoutubeUrl(el.href);
		}

		if (!url && (tag === 'VIDEO' || tag === 'AUDIO')) {
			if (isYoutubeHost()) {
				url = findYoutubeWatchUrl(anchor);
			} else if (ig?.resolveVideoPageUrl) {
				url = ig.resolveVideoPageUrl(anchor);
			} else {
				url = canonicalYoutubeUrl() || (isDedicatedMediaPage() ? location.href.split('#')[0] : null);
			}
			rawUrl = rawUrl || url || '';
		}
		if (!url) return null;

		const overlay = findMediaOverlay();
		if (overlay && !overlay.contains(el) && !overlay.contains(anchor)) return null;

		const startPrefetch = shouldStartPrefetch(url, anchor);
		const placed = placeBadge(url, anchor, rawUrl || url, startPrefetch);
		if (!placed) return null;

		anchor.setAttribute(SCANNED_ATTR, '1');
		if (el !== anchor) el.setAttribute(SCANNED_ATTR, '1');
		try { mediaIo.unobserve(el); } catch { /* ignore */ }
		return url;
	}

	let watchBudget = 80;

	function watchElement(el) {
		if (!captureActive() || !el || el.getAttribute(WATCH_ATTR) || watchBudget <= 0) return;
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
		if (!captureActive() || !root) return;
		for (const h of siteHandlers) {
			if (h.isHost?.() && h.scanSubtree?.()) return;
		}
		if (root.nodeType === 1) watchElement(root);
		root.querySelectorAll?.(
			'a[href]:not([data-veloce-watch]), video:not([data-veloce-watch]), audio:not([data-veloce-watch])'
		).forEach(watchElement);
	}

	const mediaIo = new IntersectionObserver(
		(entries) => {
			if (!captureActive()) return;
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				processMediaElement(entry.target);
			}
		},
		{ rootMargin: `${BADGE_MARGIN_PX}px`, threshold: 0.01 }
	);

	function scan() {
		if (!captureActive()) return;
		pruneBadges();
		watchBudget = 80;
		for (const h of siteHandlers) {
			const budget = h.getWatchBudget?.();
			if (budget != null) watchBudget = budget;
		}
		const budgetRef = { value: watchBudget };
		for (const h of siteHandlers) {
			if (h.isHost?.() && h.scan?.(budgetRef)) return;
		}
		scanSubtree(document.documentElement);
	}

	document.addEventListener('click', (e) => {
		try {
			document.documentElement.setAttribute('data-veloce-coordinator', coordinatorOnline ? '1' : '0');
			window.postMessage({
				source: 'veloce-extension',
				type: 'VELOCE_COORDINATOR',
				online: coordinatorOnline
			}, '*');
		} catch { /* ignore */ }

		if (omni?.handleDocumentClick?.(e)) return;

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
		interceptLog('step 1: <a> link click intercepted', { href, download: a.hasAttribute('download'), isTrusted: e.isTrusted });
		e.preventDefault();
		e.stopPropagation();
		const pageUrl = location.href.split('#')[0];
		const preloaded = a.hasAttribute('download')
			? (omni?.renameInterceptFormats?.(formatsFromDownloadAnchor(a)) || formatsFromDownloadAnchor(a))
			: null;
		const listUrl = resolveInterceptListUrl(pageUrl, resolveDownloadUrl(href, a) || href);
		interceptLog('step 2: opening format menu from link click', { listUrl, preloaded: !!preloaded });
		openFormatMenu(listUrl, a, a, preloaded || undefined);
	}, true);

	let scanTimer = null;
	let pendingMutations = [];

	function scheduleScan() {
		if (!captureActive()) return;
		clearTimeout(scanTimer);
		let debounceMs = 200;
		for (const h of siteHandlers) {
			const ms = h.getScanDebounceMs?.();
			if (ms != null) debounceMs = ms;
		}
		scanTimer = setTimeout(() => {
			if (!captureActive()) return;
			scanTimer = null;
			cullBackgroundBadges();
			watchBudget = 80;
			for (const h of siteHandlers) {
				const budget = h.getWatchBudget?.();
				if (budget != null) watchBudget = budget;
			}
			const batch = pendingMutations.splice(0);
			const overlay = findMediaOverlay();
			const addedNodes = [];
			for (const m of batch) {
				for (const node of m.addedNodes) {
					if (node.nodeType === 1) addedNodes.push(node);
				}
			}
			let handled = false;
			for (const h of siteHandlers) {
				if (h.isHost?.() && h.handleMutationNodes?.(addedNodes, overlay)) {
					handled = true;
					break;
				}
			}
			if (!handled) {
				for (const node of addedNodes) {
					if (overlay && !overlay.contains(node) && node !== overlay) continue;
					scanSubtree(node);
					if (watchBudget <= 0) break;
				}
				if (overlay) scanSubtree(overlay);
			}
			scheduleBadgeLayout();
		}, debounceMs);
	}

	// Re-scan when SPA navigates or a modal player opens/closes.
	window.addEventListener('popstate', () => {
		cullBackgroundBadges();
		if (captureActive()) scan();
	});
	window.addEventListener('yt-navigate-finish', () => {
		if (isYoutubeHost()) {
			if (isYoutubeWatchPage()) {
				yt?.onWatchVideoChanged?.();
				return;
			}
			yt?.resetCapture?.();
		} else {
			cullBackgroundBadges();
		}
		if (captureActive()) scan();
	});
	setInterval(() => {
		if (!captureActive()) return;
		cullBackgroundBadges();
		scheduleBadgeLayout();
	}, 800);

	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			if (suspendTimer) {
				clearTimeout(suspendTimer);
				suspendTimer = null;
			}
			isForegroundTab = false;
			suspendCapture();
		} else {
			isForegroundTab = true;
			queryForegroundState();
			connectTabPort();
			startTabPing();
			scan();
		}
	});
	queryForegroundState();
	setTimeout(queryForegroundState, 200);
	connectTabPort();
	startTabPing();

	initSiteHandlers({
		captureActive,
		placeBadge,
		removeBadge,
		badges,
		badgeKeys,
		normalizeBadgeKey,
		SCANNED_ATTR,
		CARD_WATCH_ATTR,
		BADGE_MARGIN_PX,
		isNearViewport,
		shouldStartPrefetch,
		closeMenu,
		showVeloceToast,
		resetScanStateDeep,
		cardIo,
		igCardIo,
		watchElement,
		isSocialFeedPage,
		isDedicatedMediaPage,
		visibleMediaRect,
		clipRectToViewport,
		mediaVisibleRect,
		findMediaOverlay,
		cardViewportScore,
		eagerPrefetch,
		isHttpUrl,
		isBrowserOnlyUrl,
		CDN_IMAGE,
		setPrefetchFocus,
		setReelsPrefetchFocus: setPrefetchFocus,
		interceptLog,
		openFormatMenu,
		formatsFromDownloadAnchor,
		get coordinatorOnline() { return coordinatorOnline; },
		invokeScan: () => scan()
	});
	omni?.onInit?.();
	ig?.hookNavigation?.();
	yt?.hookNavigation?.();

	if (!document.hidden) scan();
	const observer = new MutationObserver((mutations) => {
		if (!captureActive()) return;
		pendingMutations.push(...mutations);
		scheduleScan();
	});
	observer.observe(document.documentElement, { childList: true, subtree: true });
	setInterval(pruneBadges, 30000);
	refreshCoordinatorState();
	setInterval(() => {
		if (!document.hidden) refreshCoordinatorState();
	}, 12000);
})();
