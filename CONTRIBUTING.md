# Contributing to Veloce

Thanks for helping improve Veloce. Most real-world issues are **site-specific** — a page layout changed, a CDN needs a referer, or a new streaming site uses a different API. This guide explains how to report problems and how to fix them in the right layer.

---

## What you need running locally

```bash
./scripts/linux/setup.sh

# Terminal 1 — coordinator + dashboard
cd backend && npm run dev

# Terminal 2 — after changing extension code
cd extension && npm run build
# Then reload the extension in chrome://extensions and refresh open tabs
```

**Prerequisites:** Rust, Node.js, `yt-dlp` (for YouTube/Instagram/TikTok), Chrome or Chromium.

---

## Before you open an issue

Please include:

1. **URL** (or example page type — e.g. “YouTube watch page”, “MediaFire file page”)
2. **What you expected** — badge appears, format menu opens, download completes
3. **What happened** — no badge, wrong format, HTML saved instead of video, stuck “Loading formats…”
4. **Layer** if you know it — extension badge vs backend extraction vs engine download
5. **Browser + extension version** — from `chrome://extensions` (e.g. 1.8.1)
6. **Coordinator log** — terminal running `npm run dev`, or dashboard at `http://localhost:14921`

Screenshots or a short screen recording of DevTools → Console (`[Veloce]` lines) are very helpful.

---

## Where to fix what

Veloce has three layers. Put your change in the **smallest** layer that can solve the problem.

| Symptom | Likely layer | Start here |
|--------|--------------|------------|
| No Veloce badge on a video/link | Extension | `extension/static/sites/` or `content.js` |
| Badge works but format list empty / wrong error | Backend extractor | `backend/src/lib/server/extractor.ts`, `formatSources.ts` |
| Format picked but download corrupt / slow / 403 | Rust engine | `core_engine/` |
| Link click doesn’t show menu / browser downloads anyway | Extension intercept | `content.js`, `inject-intercept.js` |
| Site loads qualities in a modal (MovieBox, etc.) | Extension intercept + XHR hook | `sites/omnisave.js`, `inject-intercept.js` |
| GitHub blob / repo page wrong file | Backend | `backend/src/lib/server/github.ts`, `extractor.ts` |

**Rule of thumb:** If the page **looks different** or **navigates without reload** (SPA), it is almost always an **extension site handler** issue. If the badge works but listing fails, it is usually **backend + yt-dlp**. If listing works but bytes are wrong, it is **engine**.

---

## Fixing a site that “behaves differently”

Modern sites fall into a few patterns. Match yours before coding.

### A — Social video (YouTube, Instagram, TikTok)

- The `<video>` tag often uses `blob:` URLs; the **page URL** is what yt-dlp needs.
- **Fix:** Extension finds the correct card/watch URL and badges the right element.
- **Files:** `extension/static/sites/youtube.js`, `instagram.js`, or new `sites/<name>.js`
- **Backend:** `detectMediaSource()` in `formatSources.ts`, listing in `extractor.ts`

**YouTube SPA:** When `watch?v=` changes without a full reload, handlers must listen for `yt-navigate-finish` and reset badges — see `youtube.js` → `onWatchVideoChanged()`.

**Instagram Reels:** Prefetch only the playing reel; normalize `/reels/` → `/reel/`.

### B — Direct file / CDN link

- Plain `.mp4`, `.zip`, GitHub `raw.githubusercontent.com`, etc.
- **Fix:** Often backend `isDirectFileUrl` or extension `FILE_EXT` / link intercept.
- **Files:** `extractor.ts`, `content.js`

### C — Host with expiring token (MediaFire)

- Page URL is stable; CDN URL expires in minutes.
- **Fix:** Backend scrapes fresh CDN URL on **every** download, not only on format list.
- **Files:** `extractor.ts` (`resolveMediafireDownload`), `ws.ts` (`runDownloadJob`)

### D — Site exposes formats via its own API (OmniSave, MovieBox)

- Qualities come from XHR/fetch, not yt-dlp.
- **Fix:** Hook network in `inject-intercept.js`, cache in `sessionStorage`, open menu with preloaded formats.
- **Files:** `sites/omnisave.js`, `inject-intercept.js`

### E — New site entirely

1. Add backend signature in `formatSources.ts` → `detectMediaSource()`
2. Add listing path in `extractor.ts` → `listFormatsBySource()`
3. If the DOM is non-trivial, add `extension/static/sites/<site>.js`
4. Register the script in `extension/static/manifest.json` **before** `content.js`
5. Document the site in **`AGENTS.md`** (site registry table)
6. Add tests in `backend/tests/formatSources.test.ts` (and `extractor.test.ts` if listing logic is new)

Copy an existing handler (`youtube.js`, `mediafire.js`) and implement the methods `content.js` calls: `isHost()`, `scan()`, `processMediaElement()`, `hookNavigation()`, etc.

---

## Extension development notes

- **Build output:** Chrome loads `extension/build/`, not `extension/static/`. Always `npm run build` after edits.
- **Reload workflow:** `chrome://extensions` → Reload Veloce → **F5 on each open tab** (or rely on v1.8.1+ auto re-inject on the active tab only).
- **Foreground-only capture:** Badges and prefetch run only on the **active tab** in the focused window — background tabs are intentionally quiet.
- **Site handlers** live in `extension/static/sites/` and register via `registry.js`.

---

## Backend development notes

- **Format listing:** `LIST_FORMATS` WebSocket message → `listFormats()` in `extractor.ts`
- **Platform-specific errors:** Use `failReasonForSource()` — never show a YouTube error on an Instagram URL.
- **Cache key:** Always `normalizeFormatUrl()` — same normalization in extension `background.js`.
- **Tests:** `cd backend && pnpm test`

---

## Engine development notes

- **Range safety:** Multi-connection downloads require `206 Partial Content` per piece; `200` on a sub-range is rejected (anti-corruption).
- **Resume:** `.veloce_state` sidecar next to the partial file.
- **Tests:** `cd core_engine && cargo test`
- **Rebuild after pull:** `cd core_engine && cargo build --release`

---

## Pull request checklist

- [ ] Change is in the correct layer (extension / backend / engine)
- [ ] New hostname added to `detectMediaSource` if backend listing changed
- [ ] Extension built (`npm run build`) if `extension/static/` changed
- [ ] `backend/tests/` updated for new URL classification or extractor behavior
- [ ] `AGENTS.md` site registry updated for new or changed site behavior
- [ ] PR description includes test URL and before/after behavior

---

## Code style

- Match surrounding code — naming, error handling, comment density.
- Prefer small, focused diffs over large refactors in bugfix PRs.
- Do not commit secrets (`.env`, cookies, API keys).

---

## Deep reference

For detailed format kinds, cache rules, DOM layout tables, and API message shapes, see **[AGENTS.md](./AGENTS.md)** — the technical source of truth for agents and advanced contributors.

For architecture, setup, and feature lists, see **[README.md](./README.md)**.

---

## Questions?

Open a GitHub issue with the **bug** or **enhancement** template fields above. Label ideas:

- `site-handler` — badge / SPA / intercept
- `extractor` — yt-dlp / format listing
- `engine` — download speed, resume, corruption
- `docs` — README / CONTRIBUTING only

We welcome first-time contributors — a minimal fix for one site you use daily is often the best first PR.
