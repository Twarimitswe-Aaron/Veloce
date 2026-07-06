<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import "./app.css";

  interface MediaFormat {
    id: string;
    label: string;
    url: string;
    ext: string;
    filesize?: number;
    source?: string;
    kind?: string;
  }

  interface DownloadStatus {
    id: string;
    url: string;
    file_name: string;
    save_path: string;
    status: string;
    downloaded: number;
    total: number;
    speed_bps: number;
    eta_secs: number;
    progress_pct: number;
    error?: string;
    source?: string;
  }

  interface ProgressEvent {
    id: string;
    downloaded: number;
    total: number;
    speed_bps: number;
    eta_secs: number;
    progress_pct: number;
  }

  interface StatusEvent {
    id: string;
    status: string;
    error?: string;
  }

  interface PlaylistStatus {
    playlistId: string;
    fileName: string;
    status: string;
    current: number;
    total: number;
    completed: number;
    failed: number;
    trackTitle?: string;
    saveDir: string;
    downloaded: number;
    totalBytes: number;
    error?: string;
  }

  interface PlaylistQueuedEvent {
    playlistId: string;
    count: number;
    total: number;
    folder: string;
    title: string;
  }

  interface PlaylistFinishedEvent {
    playlistId: string;
    title: string;
    saveDir: string;
    completed: number;
    failed: number;
    total: number;
  }

  interface PlaylistRemovedEvent {
    playlistId: string;
  }

  // ── State ──────────────────────────────────────────────────────────────

  let connected = true; // Tauri is always connected
  let downloads: DownloadStatus[] = [];
  let playlists: PlaylistStatus[] = [];
  let newUrl = "";
  let newFileName = "";
  let formats: MediaFormat[] = [];
  let listingFormats = false;
  let formatError = "";
  let showFormatMenu = false;
  let formatUrl = "";
  let history: any[] = [];
  let activeTab: "downloads" | "history" | "settings" = "downloads";

  // Settings
  let baseDir = "";
  let maxConcurrent = 10;
  let defaultThreads = 8;

  // ── Event listeners ───────────────────────────────────────────────────

  let unlistenProgress: UnlistenFn | undefined;
  let unlistenStatus: UnlistenFn | undefined;
  let unlistenPlaylistUpdate: UnlistenFn | undefined;
  let unlistenPlaylistQueued: UnlistenFn | undefined;
  let unlistenPlaylistFinished: UnlistenFn | undefined;
  let unlistenPlaylistRemoved: UnlistenFn | undefined;

  onMount(async () => {
    unlistenProgress = await listen<ProgressEvent>("download-progress", (event) => {
      const p = event.payload;
      upsertDownload({
        id: p.id,
        url: "",
        file_name: downloads.find((d) => d.id === p.id)?.file_name ?? "",
        save_path: "",
        status: "downloading",
        downloaded: p.downloaded,
        total: p.total,
        speed_bps: p.speed_bps,
        eta_secs: p.eta_secs,
        progress_pct: p.progress_pct,
      });
    });

    unlistenStatus = await listen<StatusEvent>("download-status", (event) => {
      const s = event.payload;
      upsertDownload({
        id: s.id,
        url: "",
        file_name: downloads.find((d) => d.id === s.id)?.file_name ?? "",
        save_path: "",
        status: s.status,
        downloaded: 0,
        total: 0,
        speed_bps: 0,
        eta_secs: 0,
        progress_pct: 0,
        error: s.error,
      });
    });

    // ── Playlist event listeners ─────────────────────────────────────────

    unlistenPlaylistQueued = await listen<PlaylistQueuedEvent>("playlist-queued", (event) => {
      const p = event.payload;
      const playlist: PlaylistStatus = {
        playlistId: p.playlistId,
        fileName: `${p.title} (0/${p.total} tracks)`,
        status: "queued",
        current: 0,
        total: p.total,
        completed: 0,
        failed: 0,
        saveDir: p.folder,
        downloaded: 0,
        totalBytes: 0,
      };
      playlists = [...playlists, playlist];
    });

    unlistenPlaylistUpdate = await listen<PlaylistStatus>("playlist-update", (event) => {
      const p = event.payload;
      updatePlaylist(p);
    });

    unlistenPlaylistFinished = await listen<PlaylistFinishedEvent>("playlist-finished", (event) => {
      const p = event.payload;
      updatePlaylist({
        playlistId: p.playlistId,
        fileName: `${p.title} (${p.total}/${p.total} tracks)`,
        status: "completed",
        current: p.total,
        total: p.total,
        completed: p.completed,
        failed: p.failed,
        saveDir: p.saveDir,
        downloaded: 0,
        totalBytes: 0,
      });
    });

    unlistenPlaylistRemoved = await listen<PlaylistRemovedEvent>("playlist-removed", (event) => {
      const p = event.payload;
      playlists = playlists.filter((pl) => pl.playlistId !== p.playlistId);
    });

    // Load initial state
    try {
      const statuses = await invoke<DownloadStatus[]>("get_statuses");
      downloads = statuses;
    } catch (e) {
      console.error("Failed to load statuses", e);
    }

    try {
      const config = await invoke<any>("get_config");
      baseDir = config.base_dir || "";
      maxConcurrent = config.max_concurrent_downloads || 10;
      defaultThreads = config.default_threads || 8;
    } catch (e) {
      console.error("Failed to load config", e);
    }
  });

  onDestroy(() => {
    unlistenProgress?.();
    unlistenStatus?.();
    unlistenPlaylistUpdate?.();
    unlistenPlaylistQueued?.();
    unlistenPlaylistFinished?.();
    unlistenPlaylistRemoved?.();
  });

  // ── Actions ────────────────────────────────────────────────────────────

  async function listFormats() {
    if (!newUrl.trim()) return;
    listingFormats = true;
    formatError = "";
    formats = [];
    formatUrl = newUrl.trim();

    try {
      formats = await invoke<MediaFormat[]>("list_formats", {
        url: formatUrl,
        force: false,
      });
      showFormatMenu = true;
    } catch (e: any) {
      formatError = typeof e === "string" ? e : (e.message || "Failed to list formats");
    } finally {
      listingFormats = false;
    }
  }

  async function startDownload(url: string, directUrl: string | null, fileName: string, kind?: string) {
    try {
      const id = await invoke<string>("start_download", {
        url,
        directUrl,
        fileName: fileName || "download",
        referer: null as string | null,
      });
      showFormatMenu = false;
      newUrl = "";
      newFileName = "";
    } catch (e: any) {
      const msg = typeof e === "string" ? e : (e.message || "Download failed");
      alert(`Download failed: ${msg}`);
    }
  }

  async function cancelDownload(id: string) {
    try {
      await invoke("cancel_download", { id });
    } catch (e) {
      console.error("Cancel failed", e);
    }
  }

  async function pauseDownload(id: string) {
    try {
      await invoke("pause_download", { id });
    } catch (e) {
      console.error("Pause failed", e);
    }
  }

  async function loadHistory() {
    try {
      history = await invoke<any[]>("get_history");
      activeTab = "history";
    } catch (e) {
      console.error("Failed to load history", e);
    }
  }

  function closeFormatMenu() {
    showFormatMenu = false;
    formats = [];
    formatError = "";
  }

  // ── Playlist actions ──────────────────────────────────────────────────

  async function cancelPlaylist(playlistId: string) {
    try {
      await invoke("cancel_download", { id: playlistId });
    } catch (e) {
      console.error("Cancel playlist failed", e);
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────

  function upsertDownload(dl: DownloadStatus) {
    const idx = downloads.findIndex((d) => d.id === dl.id);
    if (idx >= 0) {
      downloads[idx] = { ...downloads[idx], ...dl };
      downloads = downloads;
    } else {
      downloads = [...downloads, dl];
    }
  }

  function updatePlaylist(pl: PlaylistStatus) {
    const idx = playlists.findIndex((p) => p.playlistId === pl.playlistId);
    if (idx >= 0) {
      playlists[idx] = { ...playlists[idx], ...pl };
      playlists = playlists;
    } else {
      playlists = [...playlists, pl];
    }
  }

  function formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }

  function formatSpeed(bps: number): string {
    if (!bps || bps <= 0) return "";
    return `${formatBytes(bps)}/s`;
  }

  function formatEta(secs: number): string {
    if (!secs || secs <= 0) return "";
    if (secs < 60) return `${Math.round(secs)}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
    return `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m`;
  }

  function statusClass(status: string): string {
    switch (status) {
      case "downloading": return "status-downloading";
      case "completed": return "status-completed";
      case "failed": return "status-error";
      case "paused": return "status-paused";
      case "cancelled": return "status-paused";
      default: return "status-queued";
    }
  }

  function fileNameNoExt(fileName: string): string {
    const dot = fileName.lastIndexOf(".");
    return dot > 0 ? fileName.substring(0, dot) : fileName;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      if (showFormatMenu) {
        // Pick first format and download
        if (formats.length > 0) {
          const f = formats[0];
          startDownload(formatUrl, f.url, newFileName || fileNameNoExt(f.label) || "download", f.kind);
        }
      } else {
        listFormats();
      }
    }
  }
</script>

<div class="app">
  <!-- Header -->
  <header class="header">
    <h1>Veloce</h1>
    <nav class="tabs">
      <button
        class="tab"
        class:active={activeTab === "downloads"}
        onclick={() => activeTab = "downloads"}
      >Downloads</button>
      <button
        class="tab"
        class:active={activeTab === "history"}
        onclick={loadHistory}
      >History</button>
      <button
        class="tab"
        class:active={activeTab === "settings"}
        onclick={() => activeTab = "settings"}
      >Settings</button>
    </nav>
    <div class="status-badge connected">
      Running
    </div>
  </header>

  {#if activeTab === "downloads"}
    <!-- New Download Form -->
    <section class="new-download">
      <div class="form-row">
        <input
          type="text"
          placeholder="Paste URL and press Enter to list formats..."
          bind:value={newUrl}
          onkeydown={handleKeydown}
          disabled={listingFormats}
        />
        <input
          type="text"
          placeholder="File name (optional)"
          bind:value={newFileName}
          onkeydown={handleKeydown}
          disabled={listingFormats}
        />
        <button onclick={listFormats} disabled={listingFormats || !newUrl.trim()}>
          {listingFormats ? "Loading..." : "List Formats"}
        </button>
      </div>
    </section>

    <!-- Format Menu -->
    {#if showFormatMenu}
      <section class="format-menu">
        <div class="format-header">
          <span class="format-title">Formats for {formatUrl}</span>
          <button class="btn-close" onclick={closeFormatMenu}>×</button>
        </div>
        {#if formatError}
          <div class="format-error">{formatError}</div>
        {:else if formats.length === 0}
          <div class="format-empty">No formats found</div>
        {:else}
          <div class="format-list">
            {#each formats as fmt}
              <button
                class="format-item"
                onclick={() => startDownload(formatUrl, fmt.url, newFileName || fileNameNoExt(fmt.label), fmt.kind)}
              >
                <span class="fmt-label">{fmt.label}</span>
                <span class="fmt-meta">
                  {fmt.ext}
                  {#if fmt.filesize}
                    · {formatBytes(fmt.filesize)}
                  {/if}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    <!-- Download Queue -->
    <section class="queue">
      <h2>Active Downloads ({downloads.length})</h2>
      {#if downloads.length === 0}
        <p class="empty">No active downloads. Paste a URL above to start.</p>
      {:else}
        <div class="downloads-list">
          {#each downloads as dl (dl.id)}
            <div class="download-item {statusClass(dl.status)}">
              <div class="dl-header">
                <span class="dl-name" title={dl.file_name}>{dl.file_name}</span>
                <span class="dl-status">{dl.status}</span>
              </div>
              <div class="dl-progress">
                <div class="progress-bar">
                  <div
                    class="progress-fill"
                    style="width: {dl.progress_pct}%"
                  ></div>
                </div>
                <span class="dl-size">
                  {formatBytes(dl.downloaded)} / {formatBytes(dl.total)}
                </span>
              </div>
              <div class="dl-meta">
                {#if dl.speed_bps > 0}
                  <span class="dl-speed">{formatSpeed(dl.speed_bps)}</span>
                {/if}
                {#if dl.eta_secs > 0}
                  <span class="dl-eta">ETA: {formatEta(dl.eta_secs)}</span>
                {/if}
              </div>
              <div class="dl-actions">
                {#if dl.status === "downloading"}
                  <button onclick={() => pauseDownload(dl.id)}>Pause</button>
                  <button class="btn-cancel" onclick={() => cancelDownload(dl.id)}>Cancel</button>
                {:else if dl.status === "paused"}
                  <button onclick={() => startDownload(dl.url, null, dl.file_name)}>Resume</button>
                {/if}
              </div>
              {#if dl.error}
                <div class="dl-error">{dl.error}</div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Playlist Queue -->
    {#if playlists.length > 0}
      <section class="queue">
        <h2>Playlists ({playlists.length})</h2>
        <div class="downloads-list">
          {#each playlists as pl (pl.playlistId)}
            <div class="download-item playlist-item">
              <div class="dl-header">
                <span class="dl-name" title={pl.fileName}>{pl.fileName}</span>
                <span class="dl-status">{pl.status}</span>
              </div>
              <div class="pl-tracks">
                <span class="pl-track-progress">
                  Track {pl.current}/{pl.total}
                </span>
                <span class="pl-track-counts">
                  {#if pl.completed > 0}<span class="pl-ok">{pl.completed} ok</span>{/if}
                  {#if pl.failed > 0}<span class="pl-err">{pl.failed} failed</span>{/if}
                </span>
              </div>
              {#if pl.trackTitle}
                <div class="pl-current-track" title={pl.trackTitle}>
                  Currently: {pl.trackTitle}
                </div>
              {/if}
              <div class="dl-progress">
                <div class="progress-bar">
                  <div
                    class="progress-fill pl-fill"
                    style="width: {pl.total > 0 ? (pl.current / pl.total * 100) : 0}%"
                  ></div>
                </div>
                <span class="dl-size">
                  {pl.completed + pl.failed} / {pl.total} tracks
                </span>
              </div>
              <div class="dl-actions">
                {#if pl.status === "downloading" || pl.status === "queued"}
                  <button class="btn-cancel" onclick={() => cancelPlaylist(pl.playlistId)}>Cancel</button>
                {/if}
              </div>
              {#if pl.error}
                <div class="dl-error">{pl.error}</div>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/if}

  {:else if activeTab === "history"}
    <!-- History Tab -->
    <section class="history-tab">
      <h2>Download History</h2>
      {#if history.length === 0}
        <p class="empty">No completed downloads yet.</p>
      {:else}
        <div class="history-list">
          {#each history as item}
            <div class="history-item">
              <span class="hist-name">{item.file_name}</span>
              <span class="hist-status">{item.status}</span>
              <span class="hist-size">{formatBytes(item.total_bytes || 0)}</span>
              <span class="hist-path" title={item.save_path}>{item.save_path}</span>
            </div>
          {/each}
        </div>
      {/if}
    </section>

  {:else if activeTab === "settings"}
    <!-- Settings Tab -->
    <section class="settings-tab">
      <h2>Settings</h2>
      <div class="settings-group">
        <label>
          <span>Base Directory</span>
          <input type="text" bind:value={baseDir} disabled placeholder="~/Downloads/Veloce" />
        </label>
        <label>
          <span>Max Concurrent Downloads</span>
          <input type="number" bind:value={maxConcurrent} min="1" max="50" />
        </label>
        <label>
          <span>Default Threads Per Download</span>
          <input type="number" bind:value={defaultThreads} min="1" max="32" />
        </label>
      </div>
      <p class="settings-note">Settings are persisted automatically. Restart to apply changes to running downloads.</p>
    </section>
  {/if}
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    background: var(--veloce-navy);
    color: var(--veloce-white);
  }

  /* ── Header ─────────────────────────────────────────── */

  .header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 8px 16px;
    background: var(--veloce-navy-dark);
    border-bottom: 1px solid var(--veloce-border);
    flex-shrink: 0;
  }

  .header h1 {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--veloce-white);
    margin: 0;
  }

  .tabs {
    display: flex;
    gap: 2px;
    flex: 1;
  }

  .tab {
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 600;
    background: transparent;
    color: var(--veloce-muted);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .tab:hover {
    background: rgba(255,255,255,0.06);
    color: var(--veloce-white);
  }

  .tab.active {
    background: rgba(0,255,157,0.1);
    color: var(--veloce-green);
  }

  .status-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: rgba(0,255,157,0.12);
    color: var(--veloce-green);
    border: 1px solid rgba(0,255,157,0.25);
  }

  /* ── New Download ──────────────────────────────────── */

  .new-download {
    padding: 10px 16px;
    border-bottom: 1px solid var(--veloce-border);
    flex-shrink: 0;
  }

  .form-row {
    display: flex;
    gap: 8px;
  }

  .form-row input {
    flex: 1;
    padding: 8px 10px;
    background: #000d1f;
    border: 1px solid var(--veloce-border);
    color: var(--veloce-white);
    font-size: 13px;
    border-radius: 4px;
    outline: none;
    transition: border-color 0.15s;
  }

  .form-row input:focus {
    border-color: var(--veloce-green);
  }

  .form-row input::placeholder {
    color: rgba(255,255,255,0.25);
  }

  .form-row button {
    padding: 8px 14px;
    background: var(--veloce-green);
    color: var(--veloce-navy);
    border: none;
    font-size: 12px;
    font-weight: 700;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 0.15s;
  }

  .form-row button:hover:not(:disabled) {
    opacity: 0.85;
  }

  .form-row button:disabled {
    opacity: 0.35;
    cursor: default;
  }

  /* ── Format Menu ────────────────────────────────────── */

  .format-menu {
    border-bottom: 1px solid var(--veloce-border);
    flex-shrink: 0;
    max-height: 280px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .format-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px 4px;
  }

  .format-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--veloce-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .btn-close {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    background: none;
    border: none;
    color: var(--veloce-muted);
    font-size: 16px;
    cursor: pointer;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .btn-close:hover {
    background: rgba(255,255,255,0.1);
    color: var(--veloce-white);
  }

  .format-error {
    padding: 6px 16px;
    font-size: 12px;
    color: var(--veloce-error);
  }

  .format-empty {
    padding: 6px 16px;
    font-size: 12px;
    color: var(--veloce-muted);
  }

  .format-list {
    overflow-y: auto;
    padding: 4px 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .format-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    background: var(--veloce-navy-light);
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    text-align: left;
    font-size: 12px;
    color: var(--veloce-white);
  }

  .format-item:hover {
    background: rgba(0,255,157,0.08);
    border-color: rgba(0,255,157,0.2);
  }

  .fmt-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }

  .fmt-meta {
    flex-shrink: 0;
    margin-left: 8px;
    color: var(--veloce-muted);
    font-size: 11px;
  }

  /* ── Queue ──────────────────────────────────────────── */

  .queue {
    flex: 1;
    overflow-y: auto;
    padding: 10px 16px;
  }

  .queue h2 {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0 0 8px;
    color: var(--veloce-muted);
  }

  .empty {
    color: var(--veloce-muted);
    font-size: 13px;
    text-align: center;
    margin-top: 48px;
    line-height: 1.6;
  }

  .downloads-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .download-item {
    padding: 10px 12px;
    background: var(--veloce-navy-light);
    border-radius: 6px;
    border: 1px solid transparent;
    transition: border-color 0.2s;
  }

  .download-item.status-error {
    border-color: var(--veloce-error);
  }

  .download-item.status-completed {
    border-color: var(--veloce-success);
  }

  .dl-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
    gap: 8px;
  }

  .dl-name {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dl-status {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 2px 6px;
    border-radius: 3px;
    flex-shrink: 0;
    font-weight: 600;
  }

  :global(.status-downloading) .dl-status { background: rgba(0,255,157,0.12); color: var(--veloce-green); }
  :global(.status-completed) .dl-status { background: rgba(13,107,77,0.15); color: var(--veloce-success); }
  :global(.status-error) .dl-status { background: rgba(192,57,43,0.12); color: var(--veloce-error); }
  :global(.status-paused) .dl-status { background: rgba(255,255,255,0.06); color: var(--veloce-muted); }
  :global(.status-queued) .dl-status { background: rgba(255,255,255,0.04); color: var(--veloce-muted); }

  .dl-progress {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .progress-bar {
    flex: 1;
    height: 4px;
    background: rgba(255,255,255,0.08);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--veloce-green);
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .dl-size {
    font-size: 11px;
    color: var(--veloce-muted);
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  .dl-meta {
    display: flex;
    gap: 12px;
    margin-bottom: 6px;
  }

  .dl-speed,
  .dl-eta {
    font-size: 11px;
    color: var(--veloce-muted);
    font-variant-numeric: tabular-nums;
  }

  .dl-actions {
    display: flex;
    gap: 6px;
  }

  .dl-actions button {
    padding: 3px 8px;
    font-size: 10px;
    font-weight: 600;
    background: rgba(255,255,255,0.06);
    color: var(--veloce-white);
    border: 1px solid var(--veloce-border);
    border-radius: 3px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .dl-actions button:hover {
    background: rgba(255,255,255,0.12);
  }

  .btn-cancel {
    color: var(--veloce-error) !important;
    border-color: var(--veloce-error) !important;
  }

  .dl-error {
    margin-top: 6px;
    font-size: 11px;
    color: var(--veloce-error);
    line-height: 1.4;
  }

  /* ── History ────────────────────────────────────────── */

  .history-tab {
    flex: 1;
    overflow-y: auto;
    padding: 10px 16px;
  }

  .history-tab h2 {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0 0 8px;
    color: var(--veloce-muted);
  }

  .history-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .history-item {
    display: flex;
    gap: 12px;
    padding: 8px 10px;
    background: var(--veloce-navy-light);
    border-radius: 4px;
    font-size: 12px;
    align-items: center;
  }

  .hist-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .hist-status { font-size: 10px; text-transform: uppercase; color: var(--veloce-muted); flex-shrink: 0; }
  .hist-size { color: var(--veloce-muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .hist-path { color: var(--veloce-muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }

  /* ── Playlist Items ──────────────────────────────────── */

  .playlist-item {
    border-color: rgba(0, 200, 255, 0.15);
  }

  .pl-tracks {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
    gap: 8px;
  }

  .pl-track-progress {
    font-size: 12px;
    font-weight: 600;
    color: var(--veloce-white);
  }

  .pl-track-counts {
    display: flex;
    gap: 6px;
    font-size: 11px;
    font-weight: 500;
  }

  .pl-ok {
    color: var(--veloce-success);
  }

  .pl-err {
    color: var(--veloce-error);
  }

  .pl-current-track {
    font-size: 11px;
    color: var(--veloce-muted);
    margin-bottom: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pl-fill {
    background: linear-gradient(90deg, var(--veloce-green), #00c8ff);
  }

  /* ── Settings ───────────────────────────────────────── */

  .settings-tab {
    flex: 1;
    overflow-y: auto;
    padding: 10px 16px;
  }

  .settings-tab h2 {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0 0 12px;
    color: var(--veloce-muted);
  }

  .settings-group {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .settings-group label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .settings-group label span {
    font-size: 12px;
    color: var(--veloce-muted);
    font-weight: 500;
  }

  .settings-group input {
    padding: 7px 10px;
    background: #000d1f;
    border: 1px solid var(--veloce-border);
    color: var(--veloce-white);
    font-size: 13px;
    border-radius: 4px;
    outline: none;
  }

  .settings-group input:focus {
    border-color: var(--veloce-green);
  }

  .settings-note {
    margin-top: 12px;
    font-size: 11px;
    color: var(--veloce-muted);
    line-height: 1.5;
  }
</style>
