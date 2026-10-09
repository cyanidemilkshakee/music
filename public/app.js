import { showTrackDetails, reorderPlaylist, exportPlaylist } from "./modules/manage-library.js";
import { state } from "./modules/state.js";
import { hydrateIcons } from "./modules/icons.js";
import { api } from "./modules/api.js";
import { el } from "./modules/dom.js";
import { showToast } from "./modules/toast.js";
import { refreshLibrary, ensureTracks, matchingTrackIds, loadLibraryPage } from "./modules/library-data.js";
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
  reconcileQueue,
  updatePlayingMetadata,
  storedVolume,
  setShuffle,
  cycleRepeat
} from "./modules/player.js";
import { updateVolumeUI } from "./modules/audio.js";
import { openImportSheet, closeImportSheet, doImport, chooseLibraryFolder, directoryFromDrop, forgetLibrarySource, refreshLibrarySources, recoverScan } from "./modules/import-lib.js";
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

document.addEventListener("error", event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  if (image.dataset.fallbackApplied || image.getAttribute("src") === "/assets/default-cover.svg") return;
  image.dataset.fallbackApplied = "true";
  image.src = "/assets/default-cover.svg";
}, true);

const DOUBLE_PLAY_WINDOW_MS = 650;
let lastTrackActivation = { id: null, at: 0 };

function selectOrPlayTrack(trackId, event) {
  const now = Date.now();
  const repeatedTap = lastTrackActivation.id === trackId
    && now - lastTrackActivation.at <= DOUBLE_PLAY_WINDOW_MS;
  const browserDoubleTap = Number(event?.detail) >= 2;

  if (repeatedTap || browserDoubleTap) {
    lastTrackActivation = { id: null, at: 0 };
    state.selectedTrackId = trackId;
    renderGrid();
    playTrack(trackId);
    return;
  }

  state.selectedTrackId = trackId;
  renderGrid();
  lastTrackActivation = {
    id: trackId,
    at: now
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

let queueReady = false;
document.addEventListener('library-page-updated', render);
document.addEventListener('tracks-cached', render);
document.addEventListener('library-updated', () => {
  if (queueReady) {
    reconcileQueue();
    if (!state.trackIds.includes(state.currentTrackId)) {
      state.currentTrackId = null; el.audio.pause(); el.audio.removeAttribute('src');
    }
  }
  updatePlayingMetadata(); renderPlaylistsSidebar(); render();
});

async function loadState() {
  const [health, result] = await Promise.all([
    api('/api/health', { timeoutMs: 15000 }).catch(error => error.data || { ok: false, error: error.message }),
    refreshLibrary({ initial: !queueReady }).then(() => ({ ok: true })).catch(error => ({ error: error.message }))
  ]);
  const status = document.getElementById('appStatus');
  status.querySelector('span').textContent = result.error || '';
  document.getElementById('retryLoadButton').hidden = !result.error;
  status.classList.toggle('has-error', Boolean(result.error));
  if (result.error) return;
  if (!queueReady) {
    state.queue = state.trackIds;
    restoreQueue(); queueReady = true;
    const lastPlayed = getStorage('amp-last-played', '');
    if (!state.currentTrackId && state.trackIds.includes(lastPlayed)) state.selectedTrackId = lastPlayed;
  }
  await ensureTracks([state.currentTrackId, state.selectedTrackId].filter(Boolean));
  if (!health.ok) {
    const checks = health.checks || {};
    const unavailableTools = [
      checks.ffmpeg === false ? "FFmpeg" : null,
      checks.ffprobe === false ? "FFprobe" : null
    ].filter(Boolean);
    const warning = unavailableTools.length
      ? `${unavailableTools.join(" and ")} unavailable. Playback or import may be limited.`
      : checks.database === false
        ? "The database health check failed. Some library actions may not work."
        : `Health check unavailable. ${health.error || health.ffmpeg || ""}`;
    showToast(`Warning: ${warning}`, 8000);
  }
  toggleEmptyState();
  renderPlaylistsSidebar();
  render();
  refreshLibrarySources().catch(() => {});
  recoverScan().catch(() => {});

  el.audio.volume = storedVolume();
  el.audio.muted=getStorage("amp-muted","false")==="true";
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
      openPlaylistPicker(trackPlaylist.dataset.trackPlaylist);
      return;
    }

    const favorite = event.target.closest("[data-track-favorite]");
    if (favorite) {
      event.preventDefault();
      event.stopPropagation();
      favorite.disabled=true;
      toggleFavorite(favorite.dataset.trackFavorite).then(added=>{ showToast(added ? "Added to favorites" : "Removed from favorites"); renderGrid(); }).catch(showActionError).finally(()=>{favorite.disabled=false;});
      return;
    }

    const details=event.target.closest("[data-track-details]");
    if(details) {showTrackDetails(details.dataset.trackDetails).catch(showActionError);return;}
    const playlistMove=event.target.closest("[data-playlist-move]");
    if(playlistMove) {reorderPlaylist(playlistMove.dataset.playlistMove,Number(playlistMove.dataset.direction)).catch(showActionError);return;}
    const exportButton=event.target.closest("[data-playlist-export]");
    if(exportButton) {exportPlaylist(exportButton.dataset.playlistExport);return;}
    if (event.target.closest('[data-library-retry]')) { loadLibraryPage({ force: true }); renderGrid(); return; }
    const gridPage=event.target.closest("[data-grid-page]");
    if(gridPage) {state.gridOffset=Math.max(0,(state.gridOffset || 0)+Number(gridPage.dataset.gridPage)*state.gridPageSize);renderGrid();el.contentScroll.scrollTop=0;return;}
    const queueMove=event.target.closest("[data-queue-move]");
    if(queueMove) {const from=Number(queueMove.dataset.queueMove);moveQueueItem(from,from+Number(queueMove.dataset.direction));return;}
    const queuePage=event.target.closest("[data-queue-page]");
    if(queuePage) {state.queuePage=Math.max(0,state.queuePage+Number(queuePage.dataset.queuePage));renderQueue();return;}
    if(event.target.closest("[data-queue-current]")) {state.queuePage=Math.max(0,Math.floor(state.queueIndex/100));renderQueue();return;}
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
      if (event.target.closest("[data-play-btn]")) {
        event.stopPropagation();
        matchingTrackIds({ groupType: type, groupKey: key }).then(ids => {
          if (ids.length) return playTrack(ids[0], ids, 0);
        }).catch(showActionError);
      } else {
        openGroup(type, key, false, groupItem.dataset.groupName || groupItem.textContent.trim());
      }
      return;
    }

    const card = event.target.closest(".grid-card[data-track-id]");
    if (card) {
      const trackId = card.dataset.trackId;
      if (event.target.closest("[data-play-btn]")) {
        if(trackId===state.currentTrackId && el.audio.getAttribute("src")) playPause(); else playTrack(trackId);
        return;
      }
      selectOrPlayTrack(trackId, event);
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
      else if (action === "playlist") openPlaylistPicker(track.id);
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
el.fsPlayButton?.addEventListener("click", playPause);
el.fsNextButton?.addEventListener("click", nextTrack);
el.fsPrevButton?.addEventListener("click", prevTrack);
el.fsShuffleButton?.addEventListener("click", () => setShuffle(!state.shuffle));
el.fsRepeatButton?.addEventListener("click", cycleRepeat);
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
    state.gridOffset = 0;
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
    state.gridOffset=0;
    el.navItems.forEach(button => button.classList.remove("is-active"));
    render();
    return;
  }

  const target = state.searchReturn;
  state.searchReturn = null;
  state.gridOffset=0;
  if (target?.group) openGroup(target.group.type, target.group.key, true, target.group.name);
  else if (target?.playlist) openPlaylist(target.playlist, true);
  else setView(target?.view || "home", true);
});

document.getElementById("mobileImportButton").addEventListener("click",openImportSheet);
document.getElementById("mobilePlaylistButton").addEventListener("click",createPlaylistFromButton);
document.getElementById("retryLoadButton").addEventListener("click",()=>loadState().catch(reportAppError));
document.getElementById("retryPlaybackButton").addEventListener("click", playPause);
document.addEventListener("keydown",event=>{
  const card=event.target.closest("article.grid-card");
  if(!card || event.target!==card) return;
  if(event.key==="Enter" || event.key===" ") {
    event.preventDefault();
    if(card.dataset.trackId) {if(card.dataset.trackId===state.currentTrackId && el.audio.getAttribute("src")) playPause();else playTrack(card.dataset.trackId);}
    else card.click();
  } else if(event.key==="ContextMenu" || (event.shiftKey && event.key==="F10")) {
    if(!card.dataset.trackId) return;
    event.preventDefault();const rect=card.getBoundingClientRect();showCtx(rect.left,rect.top,card.dataset.trackId);el.contextMenu.querySelector("button")?.focus();
  }
});
window.addEventListener("storage",event=>{
  if(event.key==="amp-volume") el.audio.volume=storedVolume();
  if(event.key==="amp-layout") {state.layout=getStorage("amp-layout","grid");render();}
  if(event.key==="amp-favorite-tracks") refreshLibrary().catch(()=>{});
});
