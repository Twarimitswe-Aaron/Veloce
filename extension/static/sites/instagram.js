// Instagram — feed articles, post/reel pages, Stories viewer.
(function () {
	function createInstagramSite(ctx) {
		const {
			captureActive,
			placeBadge,
			removeBadge,
			isDismissedBadge,
			shouldAttemptBadge,
			dismissedBadges,
			badges,
			badgeKeys,
			normalizeBadgeKey,
			SCANNED_ATTR,
			CARD_WATCH_ATTR,
			BADGE_MARGIN_PX,
			isNearViewport,
			visibleMediaRect,
			clipRectToViewport,
			mediaVisibleRect,
			closeMenu,
			resetScanStateDeep,
			igCardIo,
			watchElement,
			isSocialFeedPage,
			isDedicatedMediaPage,
			findMediaOverlay,
			cardViewportScore,
			setReelsPrefetchFocus
		} = ctx;

		let lastStoryBadgeKey = null;
		let lastPostBadgeKey = null;
		let lastReelsBadgeKey = null;
		let lastReelsWatchKey = '';
		let lastReelsWatchUrl = '';
		let previousReelsWatchUrl = '';
		let igViewerPoll = null;
		let igScrollTimer = null;

		function isHost() {
			return /instagram\.com/i.test(location.hostname);
		}

		function isStoriesPage() {
			return /\/stories\//i.test(location.pathname);
		}

		function canonicalPostUrl(href) {
			try {
				const u = new URL(href, location.origin);
				if (!/instagram\.com/i.test(u.hostname)) return null;
				const m = u.pathname.match(/^\/(p|reels?|tv)\/([A-Za-z0-9_-]+)/i);
				if (!m) return null;
				u.search = '';
				u.hash = '';
				const segment = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
				u.pathname = `/${segment}/${m[2]}`;
				return u.href.replace(/\/+$/, '');
			} catch {
				return null;
			}
		}

		function parseStoryPath(href = location.href) {
			try {
				const u = new URL(href, location.origin);
				if (!/instagram\.com/i.test(u.hostname)) return null;
				const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
				if (parts[0] !== 'stories' || !parts[1]) return null;
				const username = parts[1];
				const storyId = parts[2] && /^\d+$/.test(parts[2]) ? parts[2] : null;
				const path = storyId ? `/stories/${username}/${storyId}` : `/stories/${username}`;
				return { username, storyId, url: `${u.origin}${path}` };
			} catch {
				return null;
			}
		}

		function findStoryUrlFromDom() {
			const fromLoc = parseStoryPath(location.href);
			const username = fromLoc?.username;
			let best = null;
			for (const a of document.querySelectorAll('a[href*="/stories/"]')) {
				const p = parseStoryPath(a.getAttribute('href') || a.href);
				if (!p?.storyId) continue;
				if (username && p.username !== username) continue;
				best = p.url;
			}
			return best || fromLoc?.url || null;
		}

		function canonicalStoryUrl(href = location.href) {
			const fromLoc = parseStoryPath(href);
			if (!fromLoc) return null;
			if (fromLoc.storyId) return fromLoc.url;
			return findStoryUrlFromDom() || fromLoc.url;
		}

		function isPostPage() {
			return isHost() && !isStoriesPage() && !!canonicalPostUrl(location.href);
		}

		function isReelsViewerPage() {
			return isHost() && !isStoriesPage() && /^\/reels\/?/i.test(location.pathname);
		}

		function isStoryVideoEl(v) {
			if (!v || v.tagName !== 'VIDEO') return false;
			if (v.videoWidth > 0 && v.videoHeight > 0) return true;
			return !!(v.duration && v.duration > 0 && Number.isFinite(v.duration));
		}

		function findStoryVideo() {
			let best = null;
			let bestArea = 0;
			const minArea = Math.max(window.innerWidth * window.innerHeight * 0.1, 32000);
			for (const v of document.querySelectorAll('video')) {
				if (!isStoryVideoEl(v)) continue;
				if (v.closest('header, nav, aside, [role="banner"], [role="navigation"]')) continue;
				const vis = visibleMediaRect(v) || clipRectToViewport(v.getBoundingClientRect());
				if (!vis) continue;
				const area = vis.width * vis.height;
				if (area < minArea) continue;
				if (area > bestArea) {
					bestArea = area;
					best = v;
				}
			}
			return best;
		}

		function findLargestVideo(requireTracks, minSide = 120) {
			let best = null;
			let bestArea = 0;
			for (const v of document.querySelectorAll('video')) {
				if (v.closest('aside, nav, header, [role="banner"], [role="navigation"]')) continue;
				if (requireTracks && !isStoryVideoEl(v)) continue;
				const vis = visibleMediaRect(v) || clipRectToViewport(v.getBoundingClientRect());
				if (!vis || vis.width < minSide || vis.height < minSide) continue;
				const area = vis.width * vis.height;
				if (area > bestArea) {
					bestArea = area;
					best = v;
				}
			}
			return best;
		}

		function findPostVideoEl() {
			return findLargestVideo(true) || findLargestVideo(false);
		}

		function findReelsViewerVideo() {
			return findStoryVideo() || findPostVideoEl();
		}

		function findPostLinkInArticle(article) {
			if (!article?.querySelectorAll) return null;
			let best = null;
			let bestScore = -1;
			for (const a of article.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"], a[href*="/tv/"]')) {
				const url = canonicalPostUrl(a.getAttribute('href') || a.href);
				if (!url) continue;
				let s = 10;
				if (a.querySelector('time') || a.closest('time')) s += 100;
				if (a.querySelector('video')) s += 50;
				const mediaBlock = a.closest('div');
				if (mediaBlock?.querySelector('video, img[srcset], img[src*="cdninstagram"]')) s += 30;
				try {
					const r = a.getBoundingClientRect();
					if (r.width >= 48 && r.height >= 48) s += 15;
				} catch { /* ignore */ }
				if (s > bestScore) {
					bestScore = s;
					best = { anchor: a, url };
				}
			}
			return best;
		}

		function findMediaAnchor(article) {
			const videos = article?.querySelectorAll?.('video') || [];
			let bestVideo = null;
			let bestArea = 0;
			for (const v of videos) {
				const vis = visibleMediaRect(v);
				const area = vis ? vis.width * vis.height : 0;
				if (area > bestArea) {
					bestArea = area;
					bestVideo = v;
				}
			}
			if (bestVideo) return bestVideo;
			const hit = findPostLinkInArticle(article);
			return hit?.anchor || article;
		}

		function isArticleReady(article) {
			if (!article) return false;
			if (findPostLinkInArticle(article)) return true;
			if (article.querySelector('video')) return true;
			return (article.textContent?.trim().length || 0) > 16;
		}

		function findPostUrl(el) {
			let node = el;
			for (let i = 0; i < 25 && node; i++) {
				const link = node.querySelector?.(
					'a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"], a[href*="/tv/"]'
				);
				if (link) {
					const canon = canonicalPostUrl(link.getAttribute('href') || link.href);
					if (canon) return canon;
					try {
						return new URL(link.getAttribute('href') || link.href, location.origin).href.split('?')[0];
					} catch { /* keep walking */ }
				}
				if (node.matches?.('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"], a[href*="/tv/"]')) {
					const canon = canonicalPostUrl(node.href);
					if (canon) return canon;
					try {
						return new URL(node.href, location.origin).href.split('?')[0];
					} catch { /* keep walking */ }
				}
				node = node.parentElement;
			}
			return null;
		}

		function normalizeKey(url) {
			const canon = canonicalPostUrl(url);
			if (canon) return canon;
			try {
				const u = new URL(url);
				if (!/instagram\.com/i.test(u.hostname)) return null;
				u.search = '';
				u.pathname = u.pathname.replace(/\/+$/, '');
				return u.href;
			} catch {
				return null;
			}
		}

		function resolveDownloadUrl(raw, anchor) {
			if (!isHost()) return null;
			if (ctx.isBrowserOnlyUrl(raw)) {
				if (isStoriesPage()) return canonicalStoryUrl();
				const canonPost = canonicalPostUrl(location.href);
				if (canonPost) return canonPost;
				return anchor ? findPostUrl(anchor) : null;
			}
			if (anchor && ctx.CDN_IMAGE?.test(raw)) {
				const tag = anchor.tagName?.toLowerCase();
				if (tag === 'video' || tag === 'audio' || anchor.querySelector?.('video,audio')) {
					return findPostUrl(anchor) || null;
				}
				if (/\.(jpe?g|webp|png|gif)(\?|#|$)/i.test(raw)) return null;
			}
			return null;
		}

		function findBadgeRoot(anchor) {
			const story = anchor.closest('section, [role="presentation"], [role="dialog"]');
			if (story && isStoriesPage()) return story;
			const article = anchor.closest('article');
			if (article) return article;
			return null;
		}

		function shouldBadgeElement(el) {
			if (!isHost()) return null;
			if (isStoriesPage()) {
				const primary = findStoryVideo();
				return !primary || el === primary;
			}
			if (isPostPage()) {
				const primary = findPostVideoEl();
				return !primary || el === primary;
			}
			if (isReelsViewerPage()) {
				const primary = findReelsViewerVideo();
				return !primary || el === primary;
			}
			if (isSocialFeedPage()) {
				const art = el.closest?.('article');
				if (art && el.tagName === 'VIDEO') {
					return findMediaAnchor(art) === el;
				}
			}
			return null;
		}

		function isElementForeground(el) {
			if (!isHost()) return null;
			if (isStoriesPage()) {
				const video = findStoryVideo();
				if (video) {
					const vis = mediaVisibleRect(video);
					return !!(vis && vis.width >= 120 && vis.height >= 120);
				}
			}
			if (isPostPage()) {
				const video = findPostVideoEl();
				if (video) return el === video;
				return true;
			}
			if (isReelsViewerPage()) {
				const video = findReelsViewerVideo();
				if (video) return el === video;
				return true;
			}
			if (el.closest?.('article')) {
				const art = el.closest('article');
				const vis = mediaVisibleRect(findMediaAnchor(art)) || clipRectToViewport(art.getBoundingClientRect());
				return isNearViewport(art, BADGE_MARGIN_PX) && !!(vis && vis.width >= 64 && vis.height >= 64);
			}
			return null;
		}

		function shouldPrefetchUrl(url) {
			try {
				if (!/instagram\.com/i.test(new URL(url).hostname)) return null;
			} catch { return null; }
			if (isReelsViewerPage() || isPostPage()) {
				return !!canonicalPostUrl(url);
			}
			if (isStoriesPage()) {
				return !!canonicalStoryUrl();
			}
			return false;
		}

		function shouldCullOnOverlay() {
			return !isPostPage() && !isStoriesPage() && !isReelsViewerPage();
		}

		function getReelsViewerUrl() {
			const fromLoc = canonicalPostUrl(location.href);
			if (fromLoc) return fromLoc;
			const video = findReelsViewerVideo();
			if (!video) return null;
			const art = video.closest('article');
			if (art) {
				const hit = findPostLinkInArticle(art);
				if (hit?.url) return hit.url;
			}
			return findPostUrl(video);
		}

		function handleReelWatching(url) {
			const canon = canonicalPostUrl(url);
			if (!canon || !setReelsPrefetchFocus) return;
			const key = normalizeBadgeKey(canon);
			if (key === lastReelsWatchKey) return;

			previousReelsWatchUrl = lastReelsWatchUrl || '';
			lastReelsWatchUrl = canon;
			lastReelsWatchKey = key;

			setReelsPrefetchFocus(canon, previousReelsWatchUrl || null);
		}

		function bindReelVideoPrefetch(video, getUrl) {
			if (!video || video.getAttribute('data-veloce-reel-prefetch')) return;
			video.setAttribute('data-veloce-reel-prefetch', '1');
			const onWatch = () => {
				if (video.paused || video.currentTime <= 0) return;
				const u = typeof getUrl === 'function' ? getUrl() : getUrl;
				if (u) handleReelWatching(u);
			};
			video.addEventListener('playing', onWatch, { passive: true });
			video.addEventListener('timeupdate', () => {
				if (!video.paused && video.currentTime > 0.05) onWatch();
			}, { passive: true });
			onWatch();
		}

		function processPostPage() {
			if (!captureActive() || !isPostPage()) return null;

			const url = canonicalPostUrl(location.href);
			if (!url) return null;
			const urlKey = normalizeBadgeKey(url);

			const video = findPostVideoEl();
			if (!video) {
				if (lastPostBadgeKey && badges.has(lastPostBadgeKey)) {
					removeBadge(lastPostBadgeKey);
					lastPostBadgeKey = null;
				}
				return null;
			}

			if (lastPostBadgeKey && lastPostBadgeKey !== urlKey && badges.has(lastPostBadgeKey)) {
				removeBadge(lastPostBadgeKey);
			}
			lastPostBadgeKey = urlKey;

			if (!shouldAttemptBadge?.(urlKey, video)) return null;
			if (video.getAttribute(SCANNED_ATTR) && badges.has(urlKey)) return url;

			const placed = placeBadge(url, video, url, true);
			if (!placed) return null;
			video.setAttribute(SCANNED_ATTR, '1');
			bindReelVideoPrefetch(video, () => canonicalPostUrl(location.href) || getReelsViewerUrl());
			ctx.eagerPrefetch(url);
			return url;
		}

		function scanPostPage() {
			if (!captureActive() || !isPostPage()) return;
			processPostPage();
			for (const v of document.querySelectorAll('video')) {
				if (v.getAttribute('data-veloce-post-watch')) continue;
				v.setAttribute('data-veloce-post-watch', '1');
				v.addEventListener('loadedmetadata', () => processPostPage(), { passive: true });
				v.addEventListener('playing', () => processPostPage(), { passive: true });
				bindReelVideoPrefetch(v, () => canonicalPostUrl(location.href) || getReelsViewerUrl());
			}
		}

		function processReelsViewer() {
			if (!captureActive() || !isReelsViewerPage()) return null;

			const url = getReelsViewerUrl();
			const video = findReelsViewerVideo();
			if (!video) {
				if (lastReelsBadgeKey && badges.has(lastReelsBadgeKey)) {
					removeBadge(lastReelsBadgeKey);
					lastReelsBadgeKey = null;
				}
				return null;
			}
			if (!url) return null;
			const urlKey = normalizeBadgeKey(url);

			if (lastReelsBadgeKey && lastReelsBadgeKey !== urlKey && badges.has(lastReelsBadgeKey)) {
				removeBadge(lastReelsBadgeKey);
			}
			lastReelsBadgeKey = urlKey;

			if (!shouldAttemptBadge?.(urlKey, video)) return null;
			if (video.getAttribute(SCANNED_ATTR) && badges.has(urlKey)) {
				bindReelVideoPrefetch(video, () => getReelsViewerUrl());
				return url;
			}

			const placed = placeBadge(url, video, url, true);
			if (!placed) return null;
			video.setAttribute(SCANNED_ATTR, '1');
			bindReelVideoPrefetch(video, () => getReelsViewerUrl());
			ctx.eagerPrefetch(url);
			return url;
		}

		function scanReelsViewer() {
			if (!captureActive() || !isReelsViewerPage()) return;
			processReelsViewer();
			for (const v of document.querySelectorAll('video')) {
				bindReelVideoPrefetch(v, () => getReelsViewerUrl());
			}
		}

		function processStoryViewer() {
			if (!captureActive() || !isStoriesPage()) return null;

			const video = findStoryVideo();
			if (!video) {
				if (lastStoryBadgeKey && badges.has(lastStoryBadgeKey)) {
					removeBadge(lastStoryBadgeKey);
					lastStoryBadgeKey = null;
				}
				return null;
			}

			const url = canonicalStoryUrl();
			if (!url) return null;
			const urlKey = normalizeBadgeKey(url);

			if (lastStoryBadgeKey && lastStoryBadgeKey !== urlKey && badges.has(lastStoryBadgeKey)) {
				removeBadge(lastStoryBadgeKey);
			}
			lastStoryBadgeKey = urlKey;

			if (!shouldAttemptBadge?.(urlKey, video)) return null;
			if (video.getAttribute(SCANNED_ATTR) && badges.has(urlKey)) return url;

			const placed = placeBadge(url, video, url, true);
			if (!placed) return null;
			video.setAttribute(SCANNED_ATTR, '1');
			ctx.eagerPrefetch(url);
			return url;
		}

		function scanStoryViewer() {
			if (!captureActive() || !isStoriesPage()) return;
			processStoryViewer();
			for (const v of document.querySelectorAll('video')) {
				if (v.getAttribute('data-veloce-story-watch')) continue;
				v.setAttribute('data-veloce-story-watch', '1');
				v.addEventListener('loadedmetadata', () => processStoryViewer(), { passive: true });
				v.addEventListener('playing', () => processStoryViewer(), { passive: true });
			}
		}

		function startViewerPoll() {
			if (igViewerPoll) return;
			if (!isStoriesPage() && !isPostPage() && !isReelsViewerPage()) return;
			igViewerPoll = setInterval(() => {
				if (!captureActive() || !isHost()) {
					stopViewerPoll();
					return;
				}
				if (isStoriesPage()) processStoryViewer();
				else if (isPostPage()) processPostPage();
				else if (isReelsViewerPage()) processReelsViewer();
				else stopViewerPoll();
			}, 500);
		}

		function stopViewerPoll() {
			if (igViewerPoll) {
				clearInterval(igViewerPoll);
				igViewerPoll = null;
			}
		}

		function processFeedArticle(article) {
			if (!captureActive() || !article || isStoriesPage()) return null;

			const hit = findPostLinkInArticle(article);
			let url = hit?.url || null;
			let anchor = findMediaAnchor(article);

			if (!url && isDedicatedMediaPage()) {
				url = canonicalPostUrl(location.href);
			}
			if (!url && anchor) {
				url = findPostUrl(anchor);
			}
			if (!url || !anchor) return null;

			if (!isArticleReady(article) && !isDedicatedMediaPage()) return null;

			const urlKey = normalizeBadgeKey(url);
			if (!shouldAttemptBadge?.(urlKey, article)) return null;
			if (article.getAttribute(SCANNED_ATTR)) {
				if (!badges.has(urlKey)) article.removeAttribute(SCANNED_ATTR);
				else return url;
			}

			const placed = placeBadge(url, anchor, url, false);
			if (!placed) return null;

			article.setAttribute(SCANNED_ATTR, '1');
			for (const v of article.querySelectorAll('video')) v.setAttribute(SCANNED_ATTR, '1');
			// Prefetch formats immediately so badge click shows formats instantly.
			ctx.eagerPrefetch(url);
			return url;
		}

		function processGridTile(anchor) {
			if (!captureActive() || !anchor) return null;
			const url = canonicalPostUrl(anchor.href || anchor.getAttribute('href'));
			if (!url) return null;
			try {
				const r = anchor.getBoundingClientRect();
				if (r.width < 72 || r.height < 72) return null;
			} catch { return null; }

			const urlKey = normalizeBadgeKey(url);
			if (!shouldAttemptBadge?.(urlKey, anchor)) return null;
			if (anchor.getAttribute(SCANNED_ATTR)) {
				if (!badges.has(urlKey)) anchor.removeAttribute(SCANNED_ATTR);
				else return url;
			}

			const placed = placeBadge(url, anchor, url, false);
			if (!placed) return null;
			anchor.setAttribute(SCANNED_ATTR, '1');
			ctx.eagerPrefetch(url);
			return url;
		}

		function queryFeedArticles() {
			const seen = new Set();
			const out = [];
			for (const art of document.querySelectorAll('main article, [role="main"] article, article')) {
				if (seen.has(art)) continue;
				const parentArticle = art.parentElement?.closest('article');
				if (parentArticle && parentArticle !== art) continue;
				seen.add(art);
				out.push(art);
			}
			return out;
		}

		function watchFeedArticle(article) {
			if (!captureActive() || !article || article.getAttribute(CARD_WATCH_ATTR)) return;
			article.setAttribute(CARD_WATCH_ATTR, '1');
			igCardIo.observe(article);
		}

		function scanFeedVisible() {
			if (!captureActive() || !isHost() || isStoriesPage()) return;
			const articles = queryFeedArticles()
				.filter((a) => isNearViewport(a, BADGE_MARGIN_PX))
				.sort((a, b) => cardViewportScore(a) - cardViewportScore(b));
			for (const article of articles) {
				watchFeedArticle(article);
				processFeedArticle(article);
			}
			for (const a of document.querySelectorAll(
				'main a[href*="/p/"], main a[href*="/reel/"], main a[href*="/reels/"], main a[href*="/tv/"], [role="main"] a[href*="/p/"], [role="main"] a[href*="/reel/"], [role="main"] a[href*="/reels/"]'
			)) {
				if (a.closest('article')) continue;
				if (!isNearViewport(a, BADGE_MARGIN_PX)) continue;
				processGridTile(a);
			}
		}

		function scanFeed(watchBudgetRef) {
			for (const article of queryFeedArticles()) {
				watchFeedArticle(article);
				if (watchBudgetRef.value <= 0) continue;
				if (isNearViewport(article, BADGE_MARGIN_PX)) {
					watchBudgetRef.value--;
					processFeedArticle(article);
				}
			}
			scanFeedVisible();
		}

		function scheduleScrollScan() {
			if (!isHost()) return;
			clearTimeout(igScrollTimer);
			igScrollTimer = setTimeout(() => {
				if (isReelsViewerPage()) processReelsViewer();
				else scanFeedVisible();
			}, 80);
		}

		function resetCapture() {
			closeMenu();
			stopViewerPoll();
			lastStoryBadgeKey = null;
			lastPostBadgeKey = null;
			lastReelsBadgeKey = null;
			lastReelsWatchKey = '';
			lastReelsWatchUrl = '';
			previousReelsWatchUrl = '';
			dismissedBadges?.clear?.();
			for (const key of [...badgeKeys]) removeBadge(key);
			resetScanStateDeep(document.documentElement);
		}

		function hookNavigation() {
			if (!isHost() || hookNavigation.done) return;
			hookNavigation.done = true;
			let lastPath = location.pathname + location.search;
			const onRoute = () => {
				const now = location.pathname + location.search;
				if (now === lastPath) return;
				lastPath = now;
				resetCapture();
				if (captureActive()) ctx.invokeScan?.();
			};
			window.addEventListener('popstate', onRoute);
			const push = history.pushState.bind(history);
			const replace = history.replaceState.bind(history);
			history.pushState = (...args) => { push(...args); onRoute(); };
			history.replaceState = (...args) => { replace(...args); onRoute(); };
		}

		function processMediaElement(el) {
			if (!isHost()) return null;
			if (isStoriesPage()) return processStoryViewer();
			if (isPostPage()) return processPostPage();
			if (isReelsViewerPage()) return processReelsViewer();
			if (isSocialFeedPage()) {
				const art = el.closest?.('article');
				if (art) return processFeedArticle(art);
				if (el.tagName === 'A') return processGridTile(el);
			}
			return null;
		}

		function resolveVideoPageUrl(anchor) {
			if (isStoriesPage()) return canonicalStoryUrl();
			return findPostUrl(anchor) ||
				(isDedicatedMediaPage() ? canonicalPostUrl(location.href) : null);
		}

		function scan(watchBudgetRef) {
			if (!isHost()) return false;
			if (isPostPage()) {
				scanPostPage();
				startViewerPoll();
				return true;
			}
			if (isReelsViewerPage()) {
				scanReelsViewer();
				startViewerPoll();
				return true;
			}
			if (!isStoriesPage()) {
				scanFeed(watchBudgetRef);
				return true;
			}
			scanStoryViewer();
			startViewerPoll();
			return true;
		}

		function scanSubtree() {
			if (!isHost() || isStoriesPage()) return false;
			if (isReelsViewerPage()) {
				processReelsViewer();
				return true;
			}
			scanFeedVisible();
			return true;
		}

		function handleMutationNodes(nodes, overlay) {
			if (!isHost()) return false;
			if (isStoriesPage()) {
				scanStoryViewer();
				startViewerPoll();
				return true;
			}
			if (isPostPage()) {
				scanPostPage();
				startViewerPoll();
				return true;
			}
			if (isReelsViewerPage()) {
				scanReelsViewer();
				startViewerPoll();
				return true;
			}
			for (const node of nodes) {
				if (node.nodeType !== 1) continue;
				if (node.matches?.('article')) watchFeedArticle(node);
				if (node.querySelectorAll) {
					for (const art of node.querySelectorAll?.('article') || []) {
						watchFeedArticle(art);
					}
				}
			}
			scanFeedVisible();
			if (overlay) {
				for (const v of overlay.querySelectorAll('video')) watchElement(v);
			}
			return true;
		}

		function getWatchBudget() {
			return isHost() ? 400 : null;
		}

		function getScanDebounceMs() {
			return isHost() ? 100 : null;
		}

		return {
			id: 'instagram',
			isHost,
			isStoriesPage,
			isPostPage,
			isReelsViewerPage,
			canonicalPostUrl,
			canonicalStoryUrl,
			findPostUrl,
			normalizeKey,
			resolveDownloadUrl,
			findBadgeRoot,
			shouldBadgeElement,
			isElementForeground,
			shouldPrefetchUrl,
			shouldCullOnOverlay,
			processMediaElement,
			resolveVideoPageUrl,
			scan,
			scanSubtree,
			handleMutationNodes,
			getWatchBudget,
			getScanDebounceMs,
			scheduleScrollScan,
			resetCapture,
			hookNavigation,
			startViewerPoll,
			scanStoryViewer: scanStoryViewer,
			scanPostPage
		};
	}

	window.__veloceRegisterSite('instagram', createInstagramSite);
})();
