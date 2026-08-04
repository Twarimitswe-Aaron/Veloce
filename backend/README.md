# Veloce local coordinator

SvelteKit app: WebSocket server, download queue (SQLite), yt-dlp extraction, Rust engine orchestration, web dashboard at `http://localhost:14921`.

**Project docs:** [../README.md](../README.md) · [../doc/CONTRIBUTING.md](../doc/CONTRIBUTING.md) · [../AGENTS.md](../AGENTS.md)

## Develop

```bash
cp .env.example .env   # if needed
npm install
npm run dev            # coordinator + dashboard on port 14921
```

## Test

```bash
pnpm test
pnpm exec svelte-check --threshold error
```

## Key paths

| Path | Role |
|------|------|
| `src/lib/server/ws.ts` | WebSocket protocol, job queue, engine spawn |
| `src/lib/server/extractor.ts` | `listFormats`, yt-dlp, MediaFire, GitHub |
| `src/lib/server/formatSources.ts` | Platform detection and error messages |
| `src/lib/server/engineCli.ts` | `core_engine` CLI argument builder |
