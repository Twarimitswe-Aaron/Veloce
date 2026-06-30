// Veloce content script — finds downloadable resources on the page, shows a
// floating navy badge on each, and opens a format picker that starts a download
// immediately when the user picks one.

(function () {
	if (window.__veloceContentLoaded) return;
	window.__veloceContentLoaded = true;

	const FILE_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|mp3|wav|flac|ogg|m4a|zip|rar|7z|tar|gz|bz2|pdf|png|jpe?g|gif|webp|svg|docx?|xlsx?|pptx?|csv|json|xml|iso)(\?|#|$)/i;
	const VIDEO_SITES = /youtube\.com|youtu\.be|instagram\.com|tiktok\.com|twitter\.com|x\.com|vimeo\.com|facebook\.com|twitch\.tv|mediafire\.com/i;
	const CDN_IMAGE = /fbcdn\.net|cdninstagram\.com/i;

	let debugOn = true;
	chrome.storage.local.get('veloce_debug', (r) => {
		debugOn = r.veloce_debug !== false;
		if (debugOn) {
			console.log(
				'%c[Veloce]%c Debug logging on — badge clicks, URL resolution, and downloads log here. Disable: chrome.storage.local.set({ veloce_debug: false })',
				'color:#7ec8ff;font-weight:bold',
				'color:inherit'
			);
		}
	});

	function vlog(...args) {
		if (!debugOn) return;
		console.log('%c[Veloce]', 'color:#7ec8ff;font-weight:bold', ...args);
	}

	function vwarn(...args) {
		if (!debugOn) return;
		console.warn('%c[Veloce]', 'color:#ffb347;font-weight:bold', ...args);
	}

	function describeAnchor(anchor) {
		if (!anchor) return null;
		const tag = anchor.tagName?.toLowerCase() || '?';
		const rect = anchor.getBoundingClientRect?.();
		return {
			tag,
			id: anchor.id || undefined,
			class: anchor.className?.toString?.().slice(0, 80) || undefined,
			rect: rect ? { top: Math.round(rect.top), left: Math.round(rect.left), w: Math.round(rect.width), h: Math.round(rect.height) } : undefined
		};
	}

	function logResolution(rawUrl, anchor) {
		const post = anchor ? findPostUrl(anchor) : null;
		const resolved = resolveDownloadUrl(rawUrl, anchor);
		vlog('URL resolution', {
			page: location.href,
			rawUrl,
			rawProtocol: (() => { try { return new URL(rawUrl).protocol; } catch { return '?'; } })(),
			anchor: describeAnchor(anchor),
			foundPostUrl: post,
			resolvedUrl: resolved,
			onVideoSite: VIDEO_SITES.test(location.hostname),
			onPostPage: /\/(p|reel|tv)\//.test(location.pathname)
		});
		return resolved;
	}

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

	const badges = new Map(); // resolvedUrl -> { el, anchor, rawUrl }
	let openMenu = null;

	function closeMenu() {
		if (openMenu) {
			openMenu.remove();
			openMenu = null;
		}
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

	function placeBadge(resolvedUrl, anchor, rawUrl) {
		if (badges.has(resolvedUrl)) return;
		vlog('Badge placed', { resolvedUrl, rawUrl, anchor: describeAnchor(anchor) });
		const el = document.createElement('div');
		el.className = 'badge';
		el.appendChild(iconSvg());
		const label = document.createElement('span');
		label.textContent = 'Veloce';
		el.appendChild(label);

		el.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			console.group('%c[Veloce] Badge clicked', 'color:#7ec8ff;font-weight:bold');
			vlog('Badge click', { rawUrl, resolvedUrl, anchor: describeAnchor(anchor) });
			openFormatMenu(rawUrl, anchor, el);
			console.groupEnd();
		});

		shadow.appendChild(el);
		badges.set(resolvedUrl, { el, anchor, rawUrl });

		const updatePos = () => {
			const rect = anchor.getBoundingClientRect();
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
		ro.observe(anchor);
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

	function openFormatMenu(rawUrl, anchor, badgeEl) {
		const url = debugOn ? logResolution(rawUrl, anchor) : resolveDownloadUrl(rawUrl, anchor);
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
			vwarn('No downloadable URL', { rawUrl, anchor: describeAnchor(anchor) });
			const err = document.createElement('div');
			err.className = 'menu-status';
			err.textContent = isBrowserOnlyUrl(rawUrl)
				? 'This video uses a browser-only blob URL. Veloce will use the Instagram post link — open the post (/p/…) or click the badge on the video card in your feed after reloading the extension.'
				: 'No downloadable URL found for this item.';
			menu.insertBefore(err, closeBtn);
			return;
		}

		const status = document.createElement('div');
		status.className = 'menu-status';
		status.textContent = isBrowserOnlyUrl(rawUrl)
			? 'Resolving via post URL…'
			: 'Loading formats…';
		menu.insertBefore(status, closeBtn);

		vlog('LIST_FORMATS → backend', { requestUrl: url, rawUrl });
		chrome.runtime.sendMessage({ type: 'VELOCE_LIST_FORMATS', url }, (resp) => {
			if (!openMenu) return;
			status.remove();

			vlog('LIST_FORMATS ← response', resp);

			if (!resp || resp.type === 'FORMATS_ERROR' || !resp.formats?.length) {
				vwarn('Format list failed', { url, error: resp?.error, resp });
				const err = document.createElement('div');
				err.className = 'menu-status';
				err.textContent = resp?.error || 'No formats found. Is the backend running?';
				menu.insertBefore(err, closeBtn);
				return;
			}

			vlog(`Formats received (${resp.formats.length})`, resp.formats.map((f) => ({
				label: f.label,
				ext: f.ext,
				url: f.url?.slice?.(0, 120)
			})));

			for (const fmt of resp.formats) {
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
						console.group('%c[Veloce] Format selected → download', 'color:#7ec8ff;font-weight:bold');
						vlog('Download config', {
							selectedFormat: fmt.label,
							payload,
							intercept: cfg.veloce_intercept !== false,
							saveDir: cfg.veloce_base_dir || '(coordinator default)'
						});
						chrome.runtime.sendMessage({ type: 'VELOCE_NEW_DOWNLOAD', payload }, (ack) => {
							vlog('NEW_DOWNLOAD ack', ack);
							console.groupEnd();
						});
					});
				});
				menu.insertBefore(btn, closeBtn);
			}
		});
	}

	function scan() {
		const seen = new Set();

		function tryBadge(rawUrl, anchor) {
			const url = resolveDownloadUrl(rawUrl, anchor);
			if (!url || seen.has(url)) return;
			seen.add(url);
			if (debugOn) {
				vlog('Scan match', { rawUrl, resolvedUrl: url, anchor: describeAnchor(anchor) });
			}
			placeBadge(url, anchor, rawUrl);
		}

		document.querySelectorAll('a[href]').forEach((a) => {
			try {
				const href = a.href;
				if (!href || href.startsWith('javascript:') || !isHttpUrl(href)) return;
				if (CDN_IMAGE.test(href) && /\.(jpe?g|webp|png|gif)(\?|#|$)/i.test(href)) return;
				if (a.hasAttribute('download') || FILE_EXT.test(href)) {
					tryBadge(href, a);
				}
			} catch { /* ignore */ }
		});

		document.querySelectorAll('video, audio').forEach((el) => {
			const src = el.currentSrc || el.src;
			if (src) tryBadge(src, el);
		});

		document.querySelectorAll('video source[src], audio source[src]').forEach((el) => {
			if (el.src) tryBadge(el.src, el.parentElement || el);
		});
	}

	document.addEventListener('click', (e) => {
		const a = e.target.closest?.('a[href]');
		if (!a) return;
		const href = a.href;
		if (!href || !isHttpUrl(href)) return;
		if (!a.hasAttribute('download') && !FILE_EXT.test(href)) return;

		chrome.runtime.sendMessage({ type: 'VELOCE_GET_STATE' }, (state) => {
			vlog('Link intercept click', { href, connected: state?.connected, state });
			if (!state?.connected) return;
			e.preventDefault();
			e.stopPropagation();
			openFormatMenu(href, a, a);
		});
	}, true);

	scan();
	vlog('Content script loaded', { page: location.href, hostname: location.hostname });
	const observer = new MutationObserver(() => scan());
	observer.observe(document.documentElement, { childList: true, subtree: true });
	setInterval(scan, 4000);
})();
