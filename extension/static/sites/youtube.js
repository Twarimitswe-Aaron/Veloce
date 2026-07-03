// YouTube — feed cards, watch/Shorts player, playlist menu, blob→watch URL resolution.
(function () {
	const FEED_CARD =
		'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ' +
		'ytd-compact-video-renderer, ytd-playlist-video-renderer, yt-lockup-view-model, ' +
		'ytd-reel-item-renderer, ytd-reel-video-renderer';

	function createYoutubeSite(ctx) {
		const {
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
			shouldStartPrefetch: coreShouldStartPrefetch,
			closeMenu,
			showVeloceToast,
			resetScanStateDeep,
			cardIo,
			watchElement,
			isSocialFeedPage,
			visibleMediaRect,
			clipRectToViewport,
			mediaVisibleRect,
			isDedicatedMediaPage: coreIsDedicatedMediaPage,
			findMediaOverlay,
			cardViewportScore,
			eagerPrefetch
		} = ctx;

		let scrollScanTimer = null;

		function isHost() {
			return /youtube\.com|youtu\.be/i.test(location.hostname);
		}

		function isWatchPage() {
			if (!/youtube\.com/i.test(location.hostname)) return false;
			if (/^\/shorts\/[^/?#]+/.test(location.pathname)) return true;
			return location.pathname === '/watch' && !!new URL(location.href).searchParams.get('v');
		}

		function canonicalUrl(href = location.href) {
			try {
				const u = new URL(href, location.origin);
				const host = u.hostname.toLowerCase();
				if (host === 'youtu.be') {
					const id = u.pathname.split('/').filter(Boolean)[0];
					if (id) return `https://www.youtube.com/watch?v=${id}`;
				}
				if (host.includes('youtube.com')) {
					if (u.pathname.startsWith('/shorts/')) {
						const id = u.pathname.split('/').filter(Boolean)[1];
						if (id) return `https://www.youtube.com/shorts/${id}`;
					}
					if (u.pathname === '/watch') {
						const v = u.searchParams.get('v');
						if (v) return `https://www.youtube.com/watch?v=${v}`;
					}
				}
			} catch { /* ignore */ }
			return null;
		}

		function normalizeKey(url) {
			try {
				const u = new URL(url);
				if (u.hostname.toLowerCase() === 'youtu.be') {
					const id = u.pathname.split('/').filter(Boolean)[0];
					if (id) return `https://www.youtube.com/watch?v=${id}`;
				}
				if (u.hostname.toLowerCase().includes('youtube.com')) {
					return canonicalUrl(u.href);
				}
			} catch { /* ignore */ }
			return null;
		}

		function findFeedCard(el) {
			return el?.closest?.(FEED_CARD) || null;
		}

		function isMainPlayerEl(el) {
			return !!el?.closest?.(
				'#movie_player, #player-container, #player, ytd-watch-flexy #player, ' +
				'.html5-video-player, ytd-shorts[disable-persistence], ytd-shorts #shorts-container, ' +
				'ytd-reel-video-renderer'
			);
		}

		function isHoverPreview(el) {
			if (!el || el.tagName !== 'VIDEO') return false;
			if (el.closest('ytd-video-preview, ytd-miniplayer, #preview, .video-preview')) return true;
			if (!isHost()) return false;
			if (isMainPlayerEl(el)) return false;
			if (findFeedCard(el)) return false;
			return true;
		}

		function walkCardDeep(card, visit) {
			if (!card || typeof visit !== 'function') return;
			function walk(node) {
				if (!node || node.nodeType !== 1) return;
				visit(node);
				for (const child of node.children || []) walk(child);
				if (node.shadowRoot) walk(node.shadowRoot);
			}
			walk(card);
		}

		function findWatchLinkInCard(card) {
			if (!card) return null;
			let best = null;
			let bestScore = -1;
			const scoreLink = (a, url) => {
				let s = 0;
				const id = a.id || '';
				if (id === 'thumbnail-link' || id === 'thumbnail') s += 100;
				if (a.closest?.('ytd-thumbnail')) s += 50;
				if (a.classList?.contains('ytd-reel-item-thumbnail')) s += 40;
				if (url.includes('/shorts/')) s += 10;
				if (a.classList?.contains('yt-simple-endpoint')) s += 5;
				return s;
			};
			walkCardDeep(card, (node) => {
				if (node.tagName !== 'A') return;
				const href = node.getAttribute('href') || node.href;
				if (!href || href.startsWith('#')) return;
				const url = canonicalUrl(href);
				if (!url) return;
				const s = scoreLink(node, url);
				if (s > bestScore) {
					bestScore = s;
					best = { anchor: node, url };
				}
			});
			return best;
		}

		function findLayoutElInCard(card) {
			if (!card) return null;
			let thumb = null;
			walkCardDeep(card, (node) => {
				if (thumb) return;
				if (node.tagName === 'YTD-THUMBNAIL') thumb = node;
				if (node.id === 'thumbnail' || node.id === 'thumbnail-link') thumb = node;
			});
			return thumb || card.querySelector?.('#content') || card;
		}

		function isCardReady(card) {
			if (!card) return false;
			if (findWatchLinkInCard(card)) return true;
			let content = null;
			walkCardDeep(card, (node) => {
				if (content) return;
				if (node.id === 'content') content = node;
			});
			if (!content) content = card.querySelector?.('#content');
			return !!(content && content.textContent?.trim());
		}

		function findWatchUrl(el) {
			if (!el) return null;
			const card = findFeedCard(el);
			if (card) {
				const hit = findWatchLinkInCard(card);
				if (hit) return hit.url;
			}
			if (isMainPlayerEl(el)) return canonicalUrl();
			if (/^\/shorts\/[^/?#]+/.test(location.pathname)) return canonicalUrl();
			let node = el;
			for (let i = 0; i < 10 && node; i++) {
				if (node.matches?.('a[href*="/watch"], a[href*="/shorts/"], a[href*="youtu.be/"]')) {
					return canonicalUrl(node.getAttribute('href') || node.href);
				}
				node = node.parentElement;
			}
			return null;
		}

		function resolveDownloadUrl(raw, anchor) {
			if (!isHost() || !anchor) return null;
			if (ctx.isBrowserOnlyUrl(raw)) {
				return findWatchUrl(anchor);
			}
			if (/googlevideo\.com/i.test(raw)) {
				return findWatchUrl(anchor) || (isMainPlayerEl(anchor) ? canonicalUrl() : null);
			}
			return null;
		}

		function findBadgeRoot(anchor) {
			const card = findFeedCard(anchor);
			if (card) return card;
			const player = anchor.closest('#movie_player, ytd-player, .html5-video-player, ytd-shorts');
			if (player) return player;
			return anchor;
		}

		function shouldBadgeElement(el) {
			if (!isHost()) return true;
			if (el.tagName === 'VIDEO' && isHoverPreview(el)) return false;
			if (!isWatchPage()) return true;
			return isMainPlayerEl(el) || !!findFeedCard(el);
		}

		function isElementForeground(el) {
			if (!isHost()) return null;
			if (findFeedCard(el)) {
				const card = findFeedCard(el);
				const layoutEl = findLayoutElInCard(card) || el;
				const cardVis = mediaVisibleRect(layoutEl) || clipRectToViewport(card.getBoundingClientRect());
				return isNearViewport(card, BADGE_MARGIN_PX) && cardVis && cardVis.width >= 48 && cardVis.height >= 36;
			}
			if (coreIsDedicatedMediaPage() && !findMediaOverlay()) {
				if (isWatchPage() && findFeedCard(el) && !isMainPlayerEl(el)) {
					if (!isNearViewport(el, 0)) return false;
					const vis = visibleMediaRect(el);
					return !!(vis && vis.width >= 64 && vis.height >= 64);
				}
				return true;
			}
			return null;
		}

		function shouldWatchLink(a) {
			if (!isHost()) return null;
			const href = a.href;
			if (canonicalUrl(href)) return !!findFeedCard(a);
			return null;
		}

		function shouldStartPrefetch(resolvedUrl, anchor) {
			if (!isHost()) return null;
			return true;
		}

		function isPlaylistContext(href = location.href) {
			try {
				const u = new URL(href);
				if (u.pathname === '/playlist' && u.searchParams.get('list')) return true;
				return u.pathname === '/watch' && !!u.searchParams.get('list');
			} catch { return false; }
		}

		function playlistTargetUrl(href = location.href) {
			try {
				const u = new URL(href);
				const list = u.searchParams.get('list');
				if (!list) return null;
				if (u.pathname === '/playlist') {
					u.hash = '';
					return u.href;
				}
				const v = u.searchParams.get('v');
				if (u.pathname === '/watch' && v) {
					return `https://www.youtube.com/watch?v=${v}&list=${list}`;
				}
				return `https://www.youtube.com/playlist?list=${list}`;
			} catch { return null; }
		}

		function queuePlaylistDownload(playlistUrl, pageUrl) {
			closeMenu();
			chrome.storage.local.get(['veloce_base_dir'], (cfg) => {
				const payload = {
					url: playlistUrl,
					pageUrl,
					referer: pageUrl,
					fileName: 'playlist',
					baseDirectory: cfg.veloce_base_dir || undefined,
					threads: 8,
					playlist: true
				};
				chrome.runtime.sendMessage({ type: 'VELOCE_NEW_DOWNLOAD', payload }, (resp) => {
					if (chrome.runtime.lastError || !resp?.ok) {
						showVeloceToast('Veloce: could not start playlist — is the backend running?', true);
						return;
					}
					showVeloceToast('Veloce: playlist job started (uses Settings → Playlist downloads)', false);
				});
			});
		}

		function appendPlaylistDownloadOption(menu, closeBtn, pageUrl) {
			if (!/youtube\.com/i.test(location.hostname)) return;
			if (!isPlaylistContext(pageUrl)) return;
			const playlistUrl = playlistTargetUrl(pageUrl);
			if (!playlistUrl) return;
			const btn = document.createElement('button');
			btn.className = 'menu-item menu-item-playlist';
			btn.textContent = 'Download entire playlist (uses Settings)';
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				closeMenu();
				queuePlaylistDownload(playlistUrl, pageUrl);
			});
			menu.insertBefore(btn, closeBtn);
		}

		function processFeedCard(card) {
			if (!captureActive() || !card) return null;
			if (!isCardReady(card)) return null;

			const hit = findWatchLinkInCard(card);
			if (!hit) return null;

			const { anchor, url } = hit;
			const urlKey = normalizeBadgeKey(url);
			if (anchor.getAttribute(SCANNED_ATTR)) {
				if (!badges.has(urlKey)) anchor.removeAttribute(SCANNED_ATTR);
				else return url;
			}

			if (!shouldBadgeElement(anchor)) return null;

			const startPrefetch = coreShouldStartPrefetch(url, anchor);
			const placed = placeBadge(url, anchor, url, startPrefetch);
			if (!placed) return null;

			anchor.setAttribute(SCANNED_ATTR, '1');
			return url;
		}

		function processMediaElement(el) {
			const card = findFeedCard(el);
			if (card) return processFeedCard(card);
			return null;
		}

		function queryFeedCards() {
			const cards = [];
			function walk(node) {
				if (!node || node.nodeType !== 1) return;
				if (node.matches?.(FEED_CARD)) cards.push(node);
				for (const child of node.children || []) walk(child);
				if (node.shadowRoot) walk(node.shadowRoot);
			}
			walk(document.documentElement);
			return cards;
		}

		function watchFeedCard(card) {
			if (!captureActive() || !card || card.getAttribute(CARD_WATCH_ATTR)) return;
			card.setAttribute(CARD_WATCH_ATTR, '1');
			cardIo.observe(card);
		}

		function scanFeedCardsVisible() {
			if (!captureActive() || !isHost()) return;
			const cards = queryFeedCards()
				.filter((card) => isNearViewport(card, BADGE_MARGIN_PX))
				.sort((a, b) => cardViewportScore(a) - cardViewportScore(b));
			for (const card of cards) {
				watchFeedCard(card);
				processFeedCard(card);
			}
		}

		function scanFeedCards(watchBudgetRef) {
			for (const card of queryFeedCards()) {
				watchFeedCard(card);
				if (watchBudgetRef.value <= 0) continue;
				if (isNearViewport(card, BADGE_MARGIN_PX)) {
					watchBudgetRef.value--;
					processFeedCard(card);
				}
			}
		}

		function scheduleScrollScan() {
			if (!isHost()) return;
			clearTimeout(scrollScanTimer);
			scrollScanTimer = setTimeout(scanFeedCardsVisible, 120);
		}

		function resetCapture() {
			closeMenu();
			for (const key of [...badgeKeys]) removeBadge(key);
			resetScanStateDeep(document.documentElement);
		}

		function scan(watchBudgetRef) {
			if (!isHost()) return false;
			for (const sel of [
				'#movie_player video',
				'ytd-watch-flexy #player video',
				'#player video',
				'ytd-shorts video',
				'ytd-reel-video-renderer video',
				'video.html5-main-video'
			]) {
				document.querySelectorAll(sel).forEach((player) => watchElement(player));
			}
			if (isWatchPage()) {
				const watchUrl = canonicalUrl();
				if (watchUrl) eagerPrefetch(watchUrl);
			}
			scanFeedCards(watchBudgetRef);
			scanFeedCardsVisible();
			return true;
		}

		function scanSubtree() {
			if (!isHost()) return false;
			scanFeedCardsVisible();
			return true;
		}

		function handleMutationNodes(nodes) {
			if (!isHost()) return false;
			for (const node of nodes) {
				if (node.nodeType !== 1) continue;
				if (node.matches?.(FEED_CARD)) watchFeedCard(node);
				if (node.querySelectorAll) {
					for (const card of node.querySelectorAll?.(FEED_CARD) || []) {
						watchFeedCard(card);
					}
				}
			}
			scanFeedCardsVisible();
			return true;
		}

		function getWatchBudget() {
			return isHost() ? 600 : null;
		}

		function getScanDebounceMs() {
			return isHost() ? 200 : null;
		}

		function onSpaNavigation() {
			resetCapture();
		}

		return {
			id: 'youtube',
			feedCardSelector: FEED_CARD,
			isHost,
			isWatchPage,
			canonicalUrl,
			normalizeKey,
			findFeedCard,
			findWatchUrl,
			resolveDownloadUrl,
			findBadgeRoot,
			shouldBadgeElement,
			isElementForeground,
			shouldWatchLink,
			shouldStartPrefetch,
			appendPlaylistDownloadOption,
			processFeedCard,
			processMediaElement,
			watchFeedCard,
			scan,
			scanSubtree,
			handleMutationNodes,
			getWatchBudget,
			getScanDebounceMs,
			scheduleScrollScan,
			resetCapture,
			onSpaNavigation
		};
	}

	window.__veloceRegisterSite('youtube', createYoutubeSite);
})();
