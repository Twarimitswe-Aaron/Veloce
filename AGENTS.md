# Veloce — Agent Guide (format & link handling)

This file is the **source of truth for agents** working on Veloce download/format logic. When you add a site, fix a badge, or change extraction — follow these classifications and file locations.

---

## Core rule

**Every URL gets a platform signature first.** Listing formats, caching failures, error messages, and download routing must all use that signature — never one global path that mixes Instagram errors with YouTube URLs.

```
URL → normalizeFormatUrl() → detectMediaSource() → handler → MediaFormat[] → download by FormatKind
```

---

## Key files

| Layer | File | Role |
|-------|------|------|
| Signatures & errors | `backend/src/lib/server/formatSources.ts` | `MediaSource`, `FormatKind`, `detectMediaSource`, `failReasonForSource`, `isManifestFormatUrl` |
| Format listing | `backend/src/lib/server/extractor.ts` | `listFormats`, per-source yt-dlp races, MediaFire resolver, `normalizeFormatUrl` |
| Download jobs | `backend/src/lib/server/ws.ts` | `LIST_FORMATS`, `NEW_DOWNLOAD`, manifest re-extract, referer |
| Extension cache | `extension/static/background.js` | `normalizeFormatUrl`, format cache, prefetch vs user `force` |
| Badges & menu | `extension/static/content.js` | Badge scan, `normalizeBadgeKey`, format menu, manifest skip on `directUrl` |
| Page intercept | `extension/static/inject-intercept.js` | MAIN-world XHR/anchor hook (OmniSave / axios sites) |

Tests: `backend/tests/formatSources.test.ts`, `backend/tests/extractor.test.ts`

---

## Platform signatures (`MediaSource`)

Detected in `formatSources.ts` → `detectMediaSource(url)`:

| Signature | Host patterns | List formats | Download notes |
|-----------|---------------|--------------|----------------|
| `youtube` | `youtube.com`, `youtu.be` | yt-dlp: Chrome → Chromium → player clients `web`/`android`/`ios` → no cookies | Progressive googlevideo URLs need **referer** = watch page |
| `instagram` | `instagram.com` | yt-dlp + cookies; try **Chrome first**, then Chromium; `/p/` and `/reel/` variants | Carousel = playlist; cookies must match browser user actually uses |
| `tiktok` | `tiktok.com` | Generic yt-dlp race | Login often required |
| `twitter` | `twitter.com`, `x.com` | Generic yt-dlp race | |
| `mediafire` | `mediafire.com`, `download*.mediafire.com` | Page scrape → CDN direct URL | **Re-resolve on every download** (tokens expire) |
| `direct` | `.mp4`, `.mkv`, etc. on any host | Single “Direct” row | Rust engine range download |
| `generic` | Everything else | yt-dlp Chrome → Chromium → no cookies | Fallback |

**Adding a new signature (e.g. `moviebox`, `vimeo`):**

1. Add to `MediaSource` union in `formatSources.ts`
2. Extend `detectMediaSource()` with hostname rules
3. Add `failReasonForSource()` message (platform-specific, never generic cross-site text)
4. In `extractor.ts` → `listFormatsBySource()`:
   - **yt-dlp social** → `raceGenericYtDlpFormats` or dedicated race (copy `raceYoutubeFormats` / `raceInstagramFormats`)
   - **API / HTML scrape** → dedicated async resolver (copy `resolveMediafireDownload`)
   - **Preloaded CDN from extension** → no backend list; extension passes formats (see OmniSave below)
5. Add tests in `backend/tests/formatSources.test.ts`
6. Update this table in `AGENTS.md`

---

## Format kinds (`FormatKind`)

Each `MediaFormat` should set `source` and `kind` when known:

| Kind | Meaning | Download path |
|------|---------|---------------|
| `direct` | Stable file URL (CDN, MediaFire, intercept) | `NEW_DOWNLOAD` with `directUrl` → Rust engine |
| `progressive` | Single HTTP stream (typical yt-dlp `formats[].url`) | `directUrl` + `referer` / `pageUrl` |
| `manifest` | `.m3u8`, `.mpd`, DASH/HLS | **Do not** pass `directUrl`; backend runs `extractMediaUrl(pageUrl)` in `ws.ts` |
| `adaptive` | Reserved for video-only / audio-only pairs | Prefer merged format or yt-dlp `-f b` on download |

Extension rule (`content.js` → `renderFormatButtons`): if `fmt.kind === 'manifest'` or URL matches `.m3u8`/`.mpd`, omit `directUrl` so coordinator re-extracts.

---

## Cache & retry (do not break)

All three layers must use the **same normalized key** (`normalizeFormatUrl` / `normalizeBadgeKey`):

- YouTube: `https://www.youtube.com/watch?v=ID` (strip playlist params)
- Instagram: strip query + trailing slash
- One cache entry **per video/post** — resolving B must not delete A

| Event | Behavior |
|-------|----------|
| Background prefetch fails | Soft fail ~45s; **does not** block badge click |
| User clicks badge | `VELOCE_LIST_FORMATS` with **`force: true`** → clears fail cache, bypasses prefetch block, full platform retry |
| Backend fail cache | Stored with `source` + platform-specific `failReasonForSource`; TTL 90s (Instagram 5 min) |
| YouTube SPA navigate | `resetYoutubeCapture()` clears badges/scan attrs, **not** `localFormatCache` |

---

## Extension link behaviors (classifications)

### A — Social feed video (YouTube, Instagram, TikTok)

- **Problem:** `<video>` uses `blob:`; page URL is not the media URL.
- **Resolve:** Walk to card link (`findYoutubeWatchUrl`, `findPostUrl`).
- **Badge anchor:** YouTube thumbnail `<a>`, not shared hover-preview `<video>`.
- **Prefetch:** Skip Instagram prefetch on feed; YouTube sidebar uses per-card URL.
- **Files:** `content.js` (`processMediaElement`, `findYoutubeFeedCard`, `shouldBadgeYoutubeElement`)

### B — Direct file / CDN link

- **Detect:** `isDirectFileUrl`, `FILE_EXT` on `<a href>`.
- **Formats:** Single direct row from backend or `formatsFromDownloadAnchor`.
- **Download:** `directUrl` as-is; signed CDNs may need `referer` from `pageUrl`.

### C — MediaFire

- **Signature:** `mediafire`
- **List:** Scrape file page → CDN URL (`resolveMediafireDownload` in `extractor.ts`)
- **Download:** Always refresh CDN URL in `runDownloadJob` before engine spawn
- **Never** treat `www.mediafire.com/file/...` as direct

### D — OmniSave / videodownloader.site (and future **MovieBox**-style sites)

**Classification:** `intercept-preloaded` — formats come from the **site’s own API**, not yt-dlp.

| Piece | Location |
|-------|----------|
| XHR cache | `inject-intercept.js` hooks axios/fetch → `sessionStorage` key `veloce_omni_links` |
| Modal parse | `content.js` → `parseDownloadModalButton`, `#download-modal-title` |
| Preloaded format | `formatFromOmniSaveLink()` → `{ id: 'intercept', url, ext, label }` |
| Open menu | `openFormatMenu(..., preloadedFormats)` — skips `LIST_FORMATS` |
| Download | `directUrl` = API CDN link; `pageUrl` + `referer` = current tab |

**Adding MovieBox or similar:**

1. Identify API endpoint (like OmniSave `/wefeed-h5api-bff/subject/download`)
2. Hook in `inject-intercept.js` (MAIN world, `document_start`)
3. Cache links in `sessionStorage` with a **site-specific key** (e.g. `veloce_moviebox_links`)
4. Map quality buttons in `content.js` (modal or button selectors)
5. Build preloaded `MediaFormat[]` with `kind: 'direct'`, `source: 'generic'`
6. Document hostname + API shape in the table below
7. **Do not** route these URLs through yt-dlp `listFormats` unless fallback needed

### E — Trap / redirect URLs

- **Detect:** `isTrapDownloadUrl`, `isInterceptTrapUrl` (redirect, `/api/`, graphql)
- **Behavior:** Fail with message to use in-page badge/intercept, not raw URL

---

## Site registry (maintain this)

| Site / family | Signature | Behavior class | Format source | Notes |
|---------------|-----------|----------------|---------------|-------|
| YouTube | `youtube` | A | yt-dlp `-J` | Card-scoped watch URL; **2025+ homepage** uses flat `#content` inside `ytd-rich-item-renderer` (no `#video-title`); deep shadow-DOM link scan; lazy-load retry when `#content` empty |
| Instagram | `instagram` | A | yt-dlp + cookies | Chrome profile; reel/p variants |
| TikTok | `tiktok` | A | yt-dlp | |
| X/Twitter | `twitter` | A | yt-dlp | |
| MediaFire | `mediafire` | C | HTML scrape | Re-resolve each download |
| OmniSave / videodownloader.site | — | D | Site API (XHR) | `inject-intercept.js` + modal |
| MovieBox | — | D *(planned)* | Site API *(TBD)* | Same pattern as OmniSave; add row when implemented |
| Generic CDN `.mp4` | `direct` | B | Direct | |

When you implement a new row, **save the link behavior class and handler here** before merging.

---

## Backend API quick reference

### `LIST_FORMATS`

```json
{ "type": "LIST_FORMATS", "requestId": "uuid", "payload": { "url": "https://...", "force": true } }
```

- `force: true` — user badge click; ignore fail cache, run full platform retry
- Response: `{ "type": "FORMATS_LIST", "formats": [{ "id", "label", "url", "ext", "source?", "kind?" }] }`

### `NEW_DOWNLOAD`

```json
{
  "type": "NEW_DOWNLOAD",
  "payload": {
    "url": "page or canonical URL",
    "directUrl": "optional — omit for manifest or page-only extract",
    "pageUrl": "tab URL for referer",
    "referer": "same as pageUrl for CDNs",
    "fileName": "name.mp4",
    "ext": ".mp4"
  }
}
```

---

## Checklist for agents

- [ ] New hostname added to `detectMediaSource` + `failReasonForSource`
- [ ] Cache key uses `normalizeFormatUrl` in backend **and** extension
- [ ] Prefetch failures marked `prefetch: true` (background.js) — never 5‑min block
- [ ] User click sends `force: true`
- [ ] Error text matches **URL platform**, not last failed site
- [ ] Manifest formats omit `directUrl` in extension
- [ ] MediaFire / expiring CDN re-resolved in `runDownloadJob`
- [ ] Intercept sites documented in **Site registry** above
- [ ] Tests added/updated in `backend/tests/`

---

## Version

Extension manifest version and notable behavior changes should be noted in commit messages. Current format-handling architecture: **v1.4.7+** (platform signatures in `formatSources.ts`).
