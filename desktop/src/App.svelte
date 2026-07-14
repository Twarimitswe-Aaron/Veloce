<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  // Note: open/reveal go through Rust commands (cross-platform, handles spaces).
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
    failedIndices: number[];
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
  let maxConcurrent = 2;
  let defaultThreads = 8;
  let maxRateMBps = 0;
  let engineQuiet = true;
  let plMediaType = "audio";
  let plVideoQuality = "720";
  let plAudioFallback = "video";
  let settingsLoaded = false;
  let pickerBusy = false;
  let pickerError = "";

  // New download form
  let treatAsPlaylist = false;

  async function loadSettings() {
    try {
      const s: any = await invoke("get_settings");
      if (s) {
        baseDir = s.base_dir || s.baseDirectory || "";
        maxConcurrent = s.max_concurrent || s.maxConcurrentDownloads || 2;
        defaultThreads = s.default_threads || s.defaultThreads || 8;
        maxRateMBps = Math.round(((s.max_rate_bytes || s.maxRateBytes || 0) as number) / (1024 * 1024));
        engineQuiet = s.engine_quiet ?? s.engineQuiet ?? true;
        const pf = s.playlistFormats || {};
        plMediaType = pf.mediaType || "audio";
        plVideoQuality = pf.videoQuality || "720";
        plAudioFallback = pf.audioMissingFallback || "video";
      }
      settingsLoaded = true;
    } catch (e) {
      console.error("Failed to load settings", e);
      settingsLoaded = true;
    }
  }

  async function saveSettings() {
    if (!settingsLoaded) return;
    try {
      await invoke("update_settings", {
        settings: JSON.stringify({
          base_dir: baseDir,
          baseDirectory: baseDir,
          max_concurrent: maxConcurrent,
          maxConcurrentDownloads: maxConcurrent,
          default_threads: defaultThreads,
          defaultThreads: defaultThreads,
          max_rate_bytes: Math.max(0, maxRateMBps) * 1024 * 1024,
          maxRateBytes: Math.max(0, maxRateMBps) * 1024 * 1024,
          engine_quiet: engineQuiet,
          engineQuiet: engineQuiet,
          playlistFormats: {
            mediaType: plMediaType,
            videoQuality: plVideoQuality,
            audioMissingFallback: plAudioFallback,
          },
        }),
      });
    } catch (e) {
      console.error("Failed to save settings", e);
    }
  }

  // Auto-save settings when they change
  $: if (settingsLoaded) {
    void saveSettings();
  }

  async function browseDirectory() {
    pickerBusy = true;
    pickerError = "";
    try {
      const path = await invoke<string>("select_directory");
      if (path) baseDir = path;
    } catch (e: any) {
      pickerError = typeof e === "string" ? e : e?.message || "Folder picker failed";
    } finally {
      pickerBusy = false;
    }
  }

  // Cached file stats per playlist (populated on completion).
  let playlistFileStats: Record<string, { fileCount: number; totalSize: number }> = {};

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
      const prev = downloads.find((d) => d.id === p.id);
      // Never let late progress ticks reopen a finished/paused job or wipe paths.
      if (prev && ["completed", "failed", "cancelled", "error"].includes(prev.status)) {
        return;
      }
      upsertDownload({
        id: p.id,
        url: prev?.url ?? "",
        file_name: prev?.file_name ?? "",
        save_path: prev?.save_path ?? "",
        status: prev?.status === "paused" ? "paused" : "downloading",
        downloaded: p.downloaded,
        total: p.total,
        speed_bps: p.speed_bps,
        eta_secs: p.eta_secs,
        progress_pct: p.progress_pct,
        error: undefined,
      });
    });

    unlistenStatus = await listen<StatusEvent>("download-status", (event) => {
      const s = event.payload;
      const prev = downloads.find((d) => d.id === s.id);
      const clearError = ["queued", "downloading", "paused", "completed"].includes(s.status);
      let downloaded = prev?.downloaded ?? 0;
      let total = prev?.total ?? 0;
      let progress_pct = prev?.progress_pct ?? 0;
      if (s.status === "completed") {
        const tot = Math.max(total, downloaded);
        downloaded = tot;
        total = tot;
        progress_pct = tot > 0 ? 100 : progress_pct;
      }
      upsertDownload({
        id: s.id,
        url: prev?.url ?? "",
        file_name: prev?.file_name ?? "",
        save_path: prev?.save_path ?? "",
        status: s.status,
        downloaded,
        total,
        speed_bps: 0,
        eta_secs: 0,
        progress_pct,
        error: clearError ? undefined : (s.error ?? prev?.error),
      });
      if (s.status === "completed" || s.status === "failed") {
        loadHistory(false);
      }
    });

    listen<any>("download-added", (event) => {
      const d = event.payload;
      const prev = downloads.find((x) => x.id === d.id);
      upsertDownload({
        id: d.id,
        url: d.url || prev?.url || "",
        file_name: d.file_name || prev?.file_name || "",
        save_path: d.save_path || prev?.save_path || "",
        status: d.status,
        downloaded: prev?.downloaded ?? 0,
        total: prev?.total ?? 0,
        speed_bps: 0,
        eta_secs: 0,
        progress_pct: prev?.progress_pct ?? 0,
        error: undefined,
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
      // Fetch file stats for the save directory.
      if (p.saveDir) {
        invoke<any>("list_playlist_files", { path: p.saveDir })
          .then((stats) => {
            playlistFileStats[p.playlistId] = stats;
            playlistFileStats = playlistFileStats; // trigger reactivity
          })
          .catch((e) => console.error("Failed to list playlist files", e));
      }
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
      const pls = await invoke<PlaylistStatus[]>("list_playlists");
      if (Array.isArray(pls)) playlists = pls;
    } catch (e) {
      console.error("Failed to load playlists", e);
    }

    await loadSettings();

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
      treatAsPlaylist = false;
    } catch (e: any) {
      const msg = typeof e === "string" ? e : (e.message || "Download failed");
      alert(`Download failed: ${msg}`);
    }
  }

  async function startPlaylist() {
    if (!newUrl.trim()) return;
    listingFormats = true;
    formatError = "";
    try {
      await invoke("queue_playlist", {
        url: newUrl.trim(),
        fileName: newFileName.trim() || null,
      });
      newUrl = "";
      newFileName = "";
      treatAsPlaylist = false;
      activeTab = "downloads";
    } catch (e: any) {
      const msg = typeof e === "string" ? e : (e.message || "Playlist failed");
      alert(`Playlist failed: ${msg}`);
    } finally {
      listingFormats = false;
    }
  }

  async function submitUrl() {
    if (treatAsPlaylist) {
      await startPlaylist();
    } else {
      await listFormats();
    }
  }

  async function resumeDownload(id: string) {
    try {
      await invoke("resume_download", { id });
    } catch (e) {
      console.error("Resume failed", e);
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

  async function loadHistory(switchTab = true) {
    try {
      history = await invoke<any[]>("get_history");
      if (switchTab) activeTab = "history";
    } catch (e) {
      console.error("Failed to load history", e);
    }
  }

  async function openFolder(path: string) {
    const target = path?.trim();
    if (!target) {
      alert("No file path saved for this download. Re-download or check History.");
      return;
    }
    try {
      await invoke("reveal_in_folder", { path: target });
    } catch (e) {
      console.error(e);
      try {
        const dir =
          target.substring(0, target.lastIndexOf("/")) ||
          target.substring(0, target.lastIndexOf("\\"));
        if (dir) await invoke("open_path", { path: dir });
        else alert(String(e));
      } catch (e2) {
        console.error(e2);
        alert(String(e2));
      }
    }
  }

  async function openDir(path: string) {
    const target = path?.trim();
    if (!target) return;
    try {
      await invoke("open_path", { path: target });
    } catch (e) {
      console.error(e);
      alert(String(e));
    }
  }

  async function openFile(path: string) {
    const target = path?.trim();
    if (!target) {
      alert("No file path saved for this download. Try History → Open File, or check Settings → download folder.");
      return;
    }
    try {
      await invoke("open_path", { path: target });
    } catch (e) {
      console.error(e);
      alert(String(e));
    }
  }

  function clearDownload(id: string) {
    downloads = downloads.filter(d => d.id !== id);
  }

  function closeFormatMenu() {
    showFormatMenu = false;
    formats = [];
    formatError = "";
  }

  // ── Playlist actions ──────────────────────────────────────────────────

  async function pausePlaylist(playlistId: string) {
    try {
      await invoke("pause_download", { id: playlistId });
    } catch (e) {
      console.error("Pause playlist failed", e);
    }
  }

  async function cancelPlaylist(playlistId: string) {
    try {
      await invoke("cancel_download", { id: playlistId });
    } catch (e) {
      console.error("Cancel playlist failed", e);
    }
  }

  async function resumePlaylist(playlistId: string) {
    try {
      await invoke("resume_download", { id: playlistId });
    } catch (e) {
      console.error("Resume playlist failed", e);
    }
  }

  async function dismissPlaylist(playlistId: string) {
    try {
      await invoke("dismiss_playlist", { id: playlistId });
    } catch (e) {
      console.error("Dismiss playlist failed", e);
    }
  }

  async function retryPlaylist(playlistId: string) {
    try {
      const result = await invoke<any>("retry_failed_playlist", { playlistId });
      console.log("Retry playlist created:", result);
    } catch (e) {
      console.error("Retry playlist failed", e);
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────

  /// Find the currently-active track download for a playlist, if any.
  function currentTrackDownload(playlistId: string): DownloadStatus | undefined {
    return downloads.find(
      (d) => d.id.startsWith(playlistId + "-t") && d.status === "downloading"
    );
  }

  function upsertDownload(dl: DownloadStatus) {
    const idx = downloads.findIndex((d) => d.id === dl.id);
    if (idx >= 0) {
      const prev = downloads[idx];
      downloads[idx] = {
        ...prev,
        ...dl,
        // Never clobber known path/name with empty progress payloads.
        save_path: dl.save_path || prev.save_path || "",
        file_name: dl.file_name || prev.file_name || "",
        url: dl.url || prev.url || "",
      };
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
        submitUrl();
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
        onclick={() => loadHistory()}
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
        <button onclick={submitUrl} disabled={listingFormats || !newUrl.trim()}>
          {listingFormats ? "Loading..." : treatAsPlaylist ? "Queue Playlist" : "List Formats"}
        </button>
      </div>
      <label class="playlist-toggle">
        <input type="checkbox" bind:checked={treatAsPlaylist} />
        Treat URL as a playlist (format rules from Settings)
      </label>
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
                    class:done={dl.status === "completed"}
                    style="width: {dl.status === 'completed' ? 100 : dl.progress_pct}%"
                  ></div>
                </div>
                <span class="dl-size">
                  {#if dl.status === "completed"}
                    {formatBytes(dl.total || dl.downloaded)}
                  {:else}
                    {formatBytes(dl.downloaded)} / {formatBytes(dl.total)}
                  {/if}
                </span>
              </div>
              <div class="dl-meta">
                {#if dl.status === "downloading"}
                  <span class="dl-speed">{formatSpeed(dl.speed_bps)}</span>
                  <span class="dl-eta">ETA: {dl.eta_secs > 0 ? formatEta(dl.eta_secs) : '--'}</span>
                {/if}
              </div>
              <div class="dl-actions">
                {#if dl.status === "downloading" || dl.status === "queued"}
                  <button onclick={() => pauseDownload(dl.id)}>Pause</button>
                  <button class="btn-cancel" onclick={() => cancelDownload(dl.id)}>Cancel</button>
                {:else if dl.status === "paused"}
                  <button onclick={() => resumeDownload(dl.id)}>Resume</button>
                  <button class="btn-cancel" onclick={() => cancelDownload(dl.id)}>Cancel</button>
                {:else if dl.status === "completed"}
                  <button onclick={() => openFile(dl.save_path)}>Open File</button>
                  <button onclick={() => openFolder(dl.save_path)}>Open Folder</button>
                  <button class="btn-cancel" onclick={() => clearDownload(dl.id)}>Clear</button>
                {:else if dl.status === "failed" || dl.status === "error" || dl.status === "cancelled"}
                  <button onclick={() => resumeDownload(dl.id)}>Retry</button>
                  <button class="btn-cancel" onclick={() => clearDownload(dl.id)}>Clear</button>
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
                <span class="dl-status">
                  {#if pl.fileName.includes("- Retry")}
                    <span class="pl-retry-badge">retry</span>
                  {/if}
                  {pl.status}
                </span>
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
              {#if pl.status === "downloading"}
                {@const trk = currentTrackDownload(pl.playlistId)}
                {#if trk}
                  <div class="pl-track-progress-detail">
                    <div class="dl-progress pl-inline-progress">
                      <div class="progress-bar pl-track-bar">
                        <div
                          class="progress-fill"
                          style="width: {trk.progress_pct}%"
                        ></div>
                      </div>
                      <span class="dl-size">
                        {formatBytes(trk.downloaded)}{#if trk.total > 0} / {formatBytes(trk.total)}{/if}
                      </span>
                    </div>
                    <div class="dl-meta">
                      {#if trk.status === "downloading"}
                        <span class="dl-speed">{formatSpeed(trk.speed_bps)}</span>
                        <span class="dl-eta">ETA: {trk.eta_secs > 0 ? formatEta(trk.eta_secs) : '--'}</span>
                      {/if}
                    </div>
                  </div>
                {/if}
              {/if}
              {#if pl.status === "completed" && pl.saveDir}
                {@const stats = playlistFileStats[pl.playlistId]}
                <div class="pl-save-dir">
                  {#if stats}
                    <span class="pl-save-dir-summary">
                      {stats.fileCount} file{stats.fileCount !== 1 ? "s" : ""} · {formatBytes(stats.totalSize)}
                    </span>
                  {:else}
                    <span class="pl-save-dir-summary">Scanning files…</span>
                  {/if}
                  <button class="btn-open" onclick={() => openDir(pl.saveDir)}>Open folder</button>
                </div>
              {/if}
              <div class="dl-actions">
                {#if pl.status === "downloading"}
                  <button onclick={() => pausePlaylist(pl.playlistId)}>Pause</button>
                  <button class="btn-cancel" onclick={() => cancelPlaylist(pl.playlistId)}>Cancel</button>
                {:else if pl.status === "queued"}
                  <button class="btn-cancel" onclick={() => cancelPlaylist(pl.playlistId)}>Cancel</button>
                {:else if pl.status === "completed"}
                  <button class="btn-dismiss" onclick={() => dismissPlaylist(pl.playlistId)}>Dismiss</button>
                  {#if pl.failed > 0}
                    <button class="btn-retry" onclick={() => retryPlaylist(pl.playlistId)}>Retry Failed ({pl.failed})</button>
                  {/if}
                {:else if pl.status === "paused"}
                  <button class="btn-resume" onclick={() => resumePlaylist(pl.playlistId)}>Resume</button>
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
              <div class="hist-actions">
                  <button onclick={() => openFile(item.save_path)}>Open File</button>
                  <button onclick={() => openFolder(item.save_path)}>Open Folder</button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>

  {:else if activeTab === "settings"}
    <!-- Settings Tab -->
    <section class="settings-tab">
      <h2>Settings</h2>
      <div class="settings-columns">
        <div class="settings-col">
          <h3>General</h3>
          <div class="settings-group">
            <label>
              <span>Base Directory</span>
              <div class="dir-row">
                <input type="text" bind:value={baseDir} placeholder="~/Downloads/Veloce/media" />
                <button type="button" class="btn-browse" onclick={browseDirectory} disabled={pickerBusy}>
                  {pickerBusy ? "…" : "Browse"}
                </button>
              </div>
              <p class="hint dir-hint">
                Videos go here. If this path is the Veloce source repo, the app uses a <code>media/</code> subfolder automatically.
              </p>
              {#if pickerError}
                <span class="picker-error">{pickerError}</span>
              {/if}
            </label>
            <label>
              <span>Max Concurrent Downloads (Queue)</span>
              <input type="number" bind:value={maxConcurrent} min="1" max="64" />
              <p class="hint dir-hint">
                Jobs are separate processes, but they still share your internet link. Keep this at 1–2 on slow/CDN hosts (MediaFire, OmniSave) or speeds collapse to KB/s.
              </p>
            </label>
            <label>
              <span>Default Threads Per Download</span>
              <input type="number" bind:value={defaultThreads} min="1" max="64" />
            </label>
            <label>
              <span>Speed cap (MB/s, 0 = unlimited)</span>
              <input type="number" bind:value={maxRateMBps} min="0" max="1000" />
            </label>
            <label class="checkbox-label">
              <input type="checkbox" bind:checked={engineQuiet} />
              Quiet engine (less diagnostic output)
            </label>
          </div>
        </div>
        <div class="settings-col">
          <h3>Playlist downloads</h3>
          <div class="settings-group">
            <label>
              <span>Media type</span>
              <select bind:value={plMediaType}>
                <option value="audio">Audio</option>
                <option value="video">Video</option>
              </select>
            </label>
            <label>
              <span>Video quality (when video / audio fallback)</span>
              <select bind:value={plVideoQuality}>
                <option value="1080">1080p</option>
                <option value="720">720p</option>
                <option value="480">480p</option>
                <option value="360">360p</option>
                <option value="best">Best</option>
              </select>
            </label>
            <label>
              <span>If audio missing</span>
              <select bind:value={plAudioFallback}>
                <option value="video">Fall back to video</option>
                <option value="skip">Skip track</option>
              </select>
            </label>
          </div>
        </div>
      </div>
      <p class="settings-note">Settings sync to the extension popup. New downloads use the folder immediately; concurrency applies to the next queued jobs.</p>
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

  .playlist-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    font-size: 12px;
    color: var(--veloce-muted);
    cursor: pointer;
    user-select: none;
  }

  .playlist-toggle input {
    accent-color: var(--veloce-green);
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

  /* Completed: solid success tone, no “still downloading” neon look */
  .progress-fill.done {
    background: var(--veloce-success);
    transition: none;
  }

  .download-item.status-completed .progress-bar {
    opacity: 0.85;
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

  .btn-retry {
    color: var(--veloce-green) !important;
    border-color: var(--veloce-green) !important;
  }

  .btn-dismiss {
    color: var(--veloce-muted) !important;
    border-color: var(--veloce-border) !important;
  }

  .btn-open {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    background: rgba(0, 200, 255, 0.1);
    color: #00c8ff;
    border: 1px solid rgba(0, 200, 255, 0.3);
    border-radius: 3px;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }

  .btn-open:hover {
    background: rgba(0, 200, 255, 0.2);
  }

  .pl-save-dir {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    padding: 4px 6px;
    background: rgba(255,255,255,0.03);
    border-radius: 3px;
  }

  .pl-save-dir-summary {
    flex: 1;
    font-size: 11px;
    font-weight: 500;
    color: var(--veloce-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .hist-size { color: var(--veloce-muted); width: 80px; text-align: right; }
  .hist-path { color: var(--veloce-muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
  .hist-actions { display: flex; gap: 0.5rem; }
  .hist-actions button { padding: 4px 8px; font-size: 10px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(0, 0, 0, 0.2); color: var(--veloce-text); cursor: pointer; }
  .hist-actions button:hover { background: rgba(255, 255, 255, 0.1); }

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

  .pl-track-progress-detail {
    margin: 4px 0 0 8px;
    padding: 4px 0 4px 8px;
    border-left: 1px solid rgba(0, 200, 255, 0.2);
  }

  .pl-inline-progress {
    margin-bottom: 2px;
  }

  .pl-track-bar {
    height: 3px;
  }

  .pl-track-progress-detail .dl-meta {
    margin-bottom: 0;
  }

  .pl-retry-badge {
    display: inline-block;
    font-size: 8px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 1px 4px;
    margin-right: 4px;
    border-radius: 3px;
    background: rgba(255, 200, 0, 0.15);
    color: #ffc800;
    border: 1px solid rgba(255, 200, 0, 0.3);
    vertical-align: middle;
  }

  /* ── Settings ───────────────────────────────────────── */

  .settings-tab {
    flex: 1;
    overflow-y: auto;
    padding: 10px 16px 20px;
    color-scheme: dark;
  }

  .settings-tab h2 {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0 0 12px;
    color: var(--veloce-muted);
  }

  .settings-columns {
    display: grid;
    grid-template-columns: 1fr;
    gap: 20px;
  }

  @media (min-width: 720px) {
    .settings-columns {
      grid-template-columns: 1fr 1fr;
      gap: 28px;
      align-items: start;
    }
  }

  .settings-col {
    min-width: 0;
  }

  .settings-tab h3,
  .settings-col h3 {
    margin: 0 0 10px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
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

  .settings-group input,
  .settings-group select {
    padding: 7px 10px;
    background: #0f1f35;
    border: 1px solid var(--veloce-border);
    color: #e8edf5;
    font-size: 13px;
    border-radius: 4px;
    outline: none;
    color-scheme: dark;
  }

  .settings-group input:focus,
  .settings-group select:focus {
    border-color: var(--veloce-green);
  }

  .settings-group select option {
    background-color: #0f1f35;
    color: #e8edf5;
  }

  .dir-row {
    display: flex;
    gap: 8px;
  }

  .dir-row input {
    flex: 1;
  }

  .dir-hint {
    margin: 6px 0 0;
    font-size: 11px;
    color: var(--veloce-muted);
    line-height: 1.4;
  }

  .dir-hint code {
    font-size: 11px;
    color: var(--veloce-white);
  }

  .btn-browse {
    padding: 7px 12px;
    background: var(--veloce-navy-light);
    border: 1px solid var(--veloce-border);
    color: var(--veloce-white);
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }

  .btn-browse:hover:not(:disabled) {
    border-color: var(--veloce-green);
    color: var(--veloce-green);
  }

  .btn-browse:disabled {
    opacity: 0.5;
    cursor: wait;
  }

  .picker-error {
    font-size: 11px;
    color: var(--veloce-error);
  }

  .checkbox-label {
    flex-direction: row !important;
    align-items: center;
    gap: 8px !important;
    font-size: 13px;
    color: var(--veloce-white);
  }

  .settings-note {
    margin-top: 16px;
    font-size: 11px;
    color: var(--veloce-muted);
    line-height: 1.5;
  }
</style>
