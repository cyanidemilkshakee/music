import { state } from "./modules/state.js";
import { hydrateIcons } from "./modules/icons.js";
import { api } from "./modules/api.js";
import { el } from "./modules/dom.js";
import { showToast } from "./modules/toast.js";
import { groupTracks } from "./modules/groups.js";
import {
  render,
  renderGrid,
  renderPlaylistsSidebar,
  renderQueue,
  toggleEmptyState
} from "./modules/render.js";
import { setView, openGroup, openPlaylist, goBack } from "./modules/navigation.js";
import {
  playTrack,
  playPause,
  nextTrack,
  prevTrack,
  queueTrack,
  clearQueue,
  removeQueueItem,
  moveQueueItem,
  playPlaylist,
  restoreQueue,
  storedVolume,
  setShuffle,
  cycleRepeat
} from "./modules/player.js";
import { updateVolumeUI } from "./modules/audio.js";
import { openImportSheet, closeImportSheet, doImport, chooseLibraryFolder, directoryFromDrop, forgetLibrarySource, refreshLibrarySources } from "./modules/import-lib.js";
import {
  closePlaylistPicker,
  createPlaylistFromPicker,
  deletePlaylist,
  openPlaylistPicker,
  removeFromActivePlaylist,
  renamePlaylist,
  refreshTrackMetadata,
  savePlaylistPicker,
  createPlaylistFromButton,
  showActionError
} from "./modules/playlists.js";
import { showCtx, closeCtx, getCtxTrackId } from "./modules/context-menu.js";
import { trackTitle } from "./modules/utils.js";
import { getStorage, setStorage } from "./modules/storage.js";
import { clearFilters, updateFiltersFromForm } from "./modules/filters.js";
import { toggleFavorite } from "./modules/favorites.js";
import { initVisualizer } from "./modules/visualizer.js";
import "./modules/shortcuts.js";

const DOUBLE_PLAY_WINDOW_MS = 650;
const SINGLE_SELECT_DELAY_MS = 280;
let pendingTrackActivation = { id: null, at: 0, timer: null };

function selectOrPlayTrack(trackId) {
  const now = Date.now();
  if (pendingTrackActivation.id === trackId && now - pendingTrackActivation.at <= DOUBLE_PLAY_WINDOW_MS) {
    window.clearTimeout(pendingTrackActivation.timer);
    pendingTrackActivation = { id: null, at: 0, timer: null };
    playTrack(trackId);
    return;
  }

  window.clearTimeout(pendingTrackActivation.timer);
  pendingTrackActivation = {
    id: trackId,
    at: now,
    timer: window.setTimeout(() => {
      state.selectedTrackId = trackId;
      renderGrid();
      pendingTrackActivation = { id: null, at: 0, timer: null };
    }, SINGLE_SELECT_DELAY_MS)
  };
}

function reportAppError(error, fallback = "Something went wrong.") {
  const message = error?.message || fallback;
  console.error(error);
  showToast(`Warning: ${message}`);
}

window.addEventListener("error", event => {
  reportAppError(event.error || new Error(event.message), "The interface hit an unexpected error.");
});

window.addEventListener("unhandledrejection", event => {
  reportAppError(event.reason, "An action did not complete.");
});

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let next = value / 1024;
  let unit = units.shift();
  while (next >= 1024 && units.length) {
    next /= 1024;
    unit = units.shift();
  }
  return `${next.toFixed(next >= 10 ? 1 : 2)} ${unit}`;
}

function syncLibraryFromServer(data) {
  state.tracks = arrayOrEmpty(data.tracks);
  state.playlists = arrayOrEmpty(data.playlists);

  const lastPlayed = getStorage("amp-last-played", "");
  const hasLast = state.tracks.some(track => track.id === lastPlayed);
  state.selectedTrackId = hasLast ? lastPlayed : (state.tracks[0]?.id || null);
  state.currentTrackId = null;
  state.queue = state.tracks.map(track => track.id);
  state.queueIndex = -1;
}

async function loadState() {
  const [health, data, recent] = await Promise.all([
    api("/api/health", { timeoutMs: 15_000 }).catch(error => ({ ok: false, ffmpeg: error.message })),
    api("/api/state", { timeoutMs: 30_000 }).catch(error => ({ tracks: [], playlists: [], error: error.message })),
    api("/api/recent", { timeoutMs: 10_000 }).catch(() => ({ recentTracks: [] }))
  ]);

  state.health = health;
  syncLibraryFromServer(data);
  restoreQueue();
  state.recentIds = (Array.isArray(recent.recentTracks) ? recent.recentTracks : []).map(track => track.id);

  if (!health.ok) {
    showToast(`Warning: FFmpeg not found. Playback unavailable. ${health.ffmpeg || ""}`, 8000);
  }
  if (data.error) {
    showToast(`Warning: ${data.error}`, 6000);
  }

  toggleEmptyState();
  setView(state.activeView, true);
  renderPlaylistsSidebar();
  render();
  refreshLibrarySources().catch(() => {});

  el.audio.volume = storedVolume();
  updateVolumeUI();
}

async function clearCache() {
  const button = el.clearCacheButton;
  if (!button || button.disabled) return;

  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = "Clearing...";

  try {
    const result = await api("/api/cache/clear", { method: "POST", timeoutMs: 60_000 });
    const removed = Number(result.removed) || 0;
    showToast(`Cleared ${removed} cache file${removed === 1 ? "" : "s"} (${formatBytes(result.bytes)}).`, 3000);
  } catch (error) {
    reportAppError(error, "Failed to clear cache.");
  } finally {
    button.disabled = false;
    button.textContent = previousText;
  }
}

hydrateIcons();
initVisualizer();
loadState().catch(error => {
  reportAppError(error, "Failed to load the library.");
  toggleEmptyState();
  render();
});

document.addEventListener("click", event => {
  try {
    if (!el.contextMenu.contains(event.target)) closeCtx();

    const playlistRename = event.target.closest("[data-playlist-rename]");
    if (playlistRename) {
      event.preventDefault();
      event.stopPropagation();
      renamePlaylist(playlistRename.dataset.playlistRename).catch(showActionError);
      return;
    }

    const playlistDelete = event.target.closest("[data-playlist-delete]");
    if (playlistDelete) {
      event.preventDefault();
      event.stopPropagation();
      deletePlaylist(playlistDelete.dataset.playlistDelete).catch(showActionError);
      return;
    }

    const trackPlaylist = event.target.closest("[data-track-playlist]");
    if (trackPlaylist) {
      event.preventDefault();
      event.stopPropagation();
      openPlaylistPicker(trackPlaylist.dataset.trackPlaylist, event);
      return;
    }

    const favorite = event.target.closest("[data-track-favorite]");
    if (favorite) {
      event.preventDefault();
      event.stopPropagation();
      const added = toggleFavorite(favorite.dataset.trackFavorite);
      showToast(added ? "Added to favorites" : "Removed from favorites", 1800);
      renderGrid();
      return;
    }

    const loadMore = event.target.closest("[data-load-more]");
    if (loadMore) {
      state.gridLimit += state.gridPageSize;
      renderGrid();
      return;
    }

    const source = event.target.closest("[data-library-source]");
    if (source) {
      el.folderInputSheet.value = source.dataset.librarySource;
      doImport(source.dataset.librarySource);
      return;
    }

    const sourceRemove = event.target.closest("[data-library-source-remove]");
    if (sourceRemove) {
      event.preventDefault();
      event.stopPropagation();
      forgetLibrarySource(sourceRemove.dataset.librarySourceRemove).catch(showActionError);
      return;
    }

    const trackRemovePlaylist = event.target.closest("[data-track-remove-playlist]");
    if (trackRemovePlaylist) {
      event.preventDefault();
      event.stopPropagation();
      removeFromActivePlaylist(trackRemovePlaylist.dataset.trackRemovePlaylist).catch(showActionError);
      return;
    }

    const queueRemove = event.target.closest("[data-queue-remove]");
    if (queueRemove) {
      event.stopPropagation();
      const index = Number(queueRemove.dataset.queueRemove);
      if (Number.isInteger(index)) removeQueueItem(index);
      return;
    }

    const queueItem = event.target.closest("[data-queue-index]");
    if (queueItem) {
      const index = Number(queueItem.dataset.queueIndex);
      const id = Number.isInteger(index) ? state.queue[index] : null;
      if (id) playTrack(id, state.queue, index);
      return;
    }

    const playlistCard = event.target.closest("[data-playlist-card-id]");
    if (playlistCard) {
      const playlist = state.playlists.find(item => item.id === playlistCard.dataset.playlistCardId);
      if (!playlist) return;
      if (event.target.closest("[data-playlist-play]")) {
        event.stopPropagation();
        playPlaylist(playlist);
      } else {
        openPlaylist(playlist.id);
      }
      return;
    }

    const groupItem = event.target.closest("[data-group-key]");
    if (groupItem) {
      const type = groupItem.dataset.groupType;
      const key = groupItem.dataset.groupKey;
      const group = groupTracks(type).find(item => item.key === key);
      if (!group) return;

      if (event.target.closest("[data-play-btn]")) {
        event.stopPropagation();
        const ids = group.tracks.map(track => track.id);
        if (ids.length) playTrack(ids[0], ids, 0);
      } else {
        openGroup(type, key);
      }
      return;
    }

    const navLink = event.target.closest(".nav-link[data-group-type]");
    if (navLink) {
      event.stopPropagation();
      openGroup(navLink.dataset.groupType, navLink.dataset.groupKey);
      return;
    }

    const card = event.target.closest(".grid-card[data-track-id]");
    if (card) {
      const trackId = card.dataset.trackId;
      if (event.target.closest("[data-play-btn]")) {
        playTrack(trackId);
        return;
      }
      selectOrPlayTrack(trackId);
      return;
    }

    const playlistItem = event.target.closest("[data-playlist-id]");
    if (playlistItem) {
      openPlaylist(playlistItem.dataset.playlistId);
      return;
    }

    const ctxItem = event.target.closest("[data-ctx]");
    if (ctxItem) {
      const action = ctxItem.dataset.ctx;
      const trackId = getCtxTrackId();
      const track = state.tracks.find(item => item.id === trackId);
      closeCtx();
      if (!track) return;

      if (action === "play") playTrack(track.id);
      else if (action === "next") queueTrack(track.id, "next");
      else if (action === "queue") queueTrack(track.id, "end");
      else if (action === "playlist") openPlaylistPicker(track.id, event);
      else if (action === "remove-playlist") removeFromActivePlaylist(track.id).catch(showActionError);
      else if (action === "metadata") refreshTrackMetadata(track.id).catch(showActionError);
      else if (action === "copy") {
        navigator.clipboard?.writeText(trackTitle(track))
          .then(() => showToast("Copied to clipboard", 2000))
          .catch(() => {});
      }
      return;
    }

    if (state.queueOpen
      && !el.queuePanel.contains(event.target)
      && !el.queueButton.contains(event.target)
      && !el.playerPill.contains(event.target)) {
      state.queueOpen = false;
      renderQueue();
    }
  } catch (error) {
    reportAppError(error);
  }
});

document.addEventListener("contextmenu", event => {
  const card = event.target.closest(".grid-card[data-track-id]");
  if (!card) return;
  event.preventDefault();
  state.selectedTrackId = card.dataset.trackId;
  renderGrid();
  showCtx(event.clientX, event.clientY, card.dataset.trackId);
});

el.playButton.addEventListener("click", playPause);
el.nextButton.addEventListener("click", nextTrack);
el.prevButton.addEventListener("click", prevTrack);
el.shuffleButton.addEventListener("click", event => {
  event.stopPropagation();
  setShuffle(!state.shuffle);
});
el.repeatButton.addEventListener("click", event => {
  event.stopPropagation();
  cycleRepeat();
});

el.queueButton.addEventListener("click", event => {
  event.stopPropagation();
  state.queueOpen = !state.queueOpen;
  renderQueue();
});

el.queueClearButton.addEventListener("click", event => {
  event.stopPropagation();
  clearQueue();
});

el.queueCloseButton?.addEventListener("click", event => {
  event.stopPropagation();
  state.queueOpen = false;
  renderQueue();
});

el.playlistPickerClose?.addEventListener("click", closePlaylistPicker);
el.playlistPickerDone?.addEventListener("click", () => savePlaylistPicker().catch(showActionError));
el.playlistPickerNew?.addEventListener("click", () => createPlaylistFromPicker().catch(showActionError));
el.playlistPicker?.addEventListener("click", event => {
  if (event.target === el.playlistPicker) closePlaylistPicker();
});

el.backButton?.addEventListener("click", goBack);
el.navItems.forEach(button => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

el.headerCols.forEach(column => {
  column.addEventListener("click", () => {
    const field = column.dataset.sort;
    if (!field) return;
    if (state.sortField === field) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortField = field;
      state.sortDir = "asc";
    }
    setStorage("amp-sort-field", state.sortField);
    setStorage("amp-sort-dir", state.sortDir);
    renderGrid();
  });
});

el.layoutToggleButton.addEventListener("click", () => {
  state.layout = state.layout === "list" ? "grid" : "list";
  setStorage("amp-layout", state.layout);
  render();
});

el.importSmallButton.addEventListener("click", createPlaylistFromButton);
el.importMainButton.addEventListener("click", openImportSheet);
el.clearCacheButton?.addEventListener("click", clearCache);
el.sidebarImportButton?.addEventListener("click", openImportSheet);
el.importSheetClose.addEventListener("click", closeImportSheet);
el.importButtonSheet.addEventListener("click", () => doImport(el.folderInputSheet.value.trim()));
el.pickFolderButton?.addEventListener("click", chooseLibraryFolder);
el.folderInputSheet.addEventListener("keydown", event => {
  if (event.key === "Enter") doImport(el.folderInputSheet.value.trim());
});
el.importSheet.addEventListener("click", event => {
  if (event.target === el.importSheet) closeImportSheet();
});
el.importDropZone?.addEventListener("dragover", event => {
  event.preventDefault();
  el.importDropZone.classList.add("is-dragging");
});
el.importDropZone?.addEventListener("dragleave", () => el.importDropZone.classList.remove("is-dragging"));
el.importDropZone?.addEventListener("drop", event => {
  event.preventDefault();
  el.importDropZone.classList.remove("is-dragging");
  const directory = directoryFromDrop(event);
  if (!directory) {
    showToast("Drop a folder from File Explorer, or use Choose Folder.");
    return;
  }
  el.folderInputSheet.value = directory;
  doImport(directory);
});
let draggedQueueIndex = null;
el.queueList?.addEventListener("dragstart", event => {
  const item = event.target.closest("[data-queue-drag-index]");
  if (!item) return;
  draggedQueueIndex = Number(item.dataset.queueDragIndex);
  event.dataTransfer.effectAllowed = "move";
});
el.queueList?.addEventListener("dragover", event => {
  if (draggedQueueIndex !== null) event.preventDefault();
});
el.queueList?.addEventListener("drop", event => {
  const target = event.target.closest("[data-queue-drag-index]");
  if (!target || draggedQueueIndex === null) return;
  event.preventDefault();
  moveQueueItem(draggedQueueIndex, Number(target.dataset.queueDragIndex));
  draggedQueueIndex = null;
});
el.queueList?.addEventListener("dragend", () => { draggedQueueIndex = null; });

el.filterToggleButton?.addEventListener("click", () => {
  el.filterPanel.classList.toggle("is-hidden");
});
[el.filterGenre, el.filterYear, el.filterCodec, el.filterDuration, el.filterFavorite, el.filterRecent]
  .filter(Boolean)
  .forEach(control => control.addEventListener("change", () => {
    updateFiltersFromForm();
    render();
  }));
el.clearFiltersButton?.addEventListener("click", () => {
  clearFilters();
  render();
});

el.searchInput.addEventListener("input", event => {
  const value = event.target.value;
  const wasSearching = state.activeView === "search";
  state.search = value;

  if (value) {
    if (!wasSearching) {
      state.searchReturn = {
        view: state.activeView,
        playlist: state.activePlaylistId,
        group: state.activeGroup ? { ...state.activeGroup } : null
      };
    }
    state.activeGroup = null;
    state.activeView = "search";
    state.gridLimit = state.gridPageSize;
    el.navItems.forEach(button => button.classList.remove("is-active"));
    render();
    return;
  }

  const target = state.searchReturn;
  state.searchReturn = null;
  state.gridLimit = state.gridPageSize;
  if (target?.group) openGroup(target.group.type, target.group.key, true);
  else if (target?.playlist) openPlaylist(target.playlist, true);
  else setView(target?.view || "home", true);
});
