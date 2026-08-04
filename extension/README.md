# Veloce browser extension

Chrome Manifest V3 extension: in-page badges, format picker, download intercept, and popup UI.

**Project docs:** [../README.md](../README.md) · [../doc/CONTRIBUTING.md](../doc/CONTRIBUTING.md) · [../AGENTS.md](../AGENTS.md)

## Develop

```bash
npm install
npm run build    # output → extension/build/ (load this folder in chrome://extensions)
```

After code changes: rebuild, reload the extension, refresh open tabs (active tab re-injects automatically on update in v1.8.1+).

## Key paths

| Path | Role |
|------|------|
| `static/content.js` | Badge scan, format menu, link intercept |
| `static/background.js` | WebSocket to coordinator, format cache, foreground tab |
| `static/sites/*.js` | Per-site handlers (YouTube, Instagram, MediaFire, OmniSave) |
| `static/inject-intercept.js` | MAIN-world XHR hook for API-driven sites |
| `src/` | Svelte popup UI |
