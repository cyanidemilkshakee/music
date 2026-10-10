// ── Navigation & History ─────────────────────────────────────────────────────
import { state } from "./state.js";
import { el }    from "./dom.js";
import { render, renderPlaylistsSidebar } from "./render.js";
import { cssEscape } from "./utils.js";

const VALID_VIEWS = new Set(["home", "recent", "artists", "albums", "songs", "playlists", "search"]);
const MAX_HISTORY_ITEMS = 100;

// ── Back Button ───────────────────────────────────────────────────────────────
function updateBackButton() {
  if (!el.backButton) return;
  const has = state.history.length > 0;
  el.backButton.style.opacity       = has ? "1" : "0.5";
  el.backButton.style.pointerEvents = has ? "auto" : "none";
}

function pushHistory() {
  state.history.push({
    view:     state.activeView,
    group:    state.activeGroup ? { ...state.activeGroup } : null,
    playlist: state.activePlaylistId,
    search:   state.search,
    sortField: state.sortField, sortDir: state.sortDir, filters: {...state.filters}, offset: state.gridOffset
  });
  if (state.history.length > MAX_HISTORY_ITEMS) {
    state.history.splice(0, state.history.length - MAX_HISTORY_ITEMS);
  }
  updateBackButton();
}

// ── View Transitions ──────────────────────────────────────────────────────────
function clearSearchState() {
  state.search = "";
  state.searchReturn = null;
  if (el.searchInput) el.searchInput.value = "";
}

export function setView(view, skipHistory = false) {
  if (!VALID_VIEWS.has(view)) view = "home";
  if (!skipHistory && state.activeView && state.activeView !== view) pushHistory();

  state.activeView      = view;
  state.activePlaylistId = null;
  state.activeGroup     = null;
  clearSearchState();
  state.gridOffset = 0;

  el.navItems.forEach(btn =>
    btn.classList.toggle("is-active", btn.dataset.view === view)
  );

  render();
  renderPlaylistsSidebar();
  el.contentScroll.scrollTop = 0;
}

export function openGroup(type, key, skipHistory = false, name = '') {
  if (!['album', 'artist'].includes(type) || !key.startsWith(type + ':')) return;
  const group = state.libraryPage.groups.find(item => item.key === key);
  if (!name) {
    name = group?.name || key.slice(type.length + 1);
    if (!group && type === 'album') { try { name = JSON.parse(key.slice(6))[0]; } catch { /* Invalid keys are rejected by the server. */ } }
  }
  if (!skipHistory) pushHistory();

  state.activeView       = type === "album" ? "albums" : "artists";
  state.activePlaylistId = null;
  state.activeGroup      = { type, key, name };
  clearSearchState();
  state.gridOffset = 0;

  el.navItems.forEach(btn =>
    btn.classList.toggle("is-active", btn.dataset.view === state.activeView)
  );
  render();
  renderPlaylistsSidebar();
  el.contentScroll.scrollTop = 0;
}

export function openPlaylist(playlistId, skipHistory = false) {
  const playlist = state.playlists.find(p => p.id === playlistId);
  if (!playlist) return;
  if (!skipHistory) pushHistory();

  state.activeView       = "playlists";
  state.activePlaylistId = playlist.id;
  state.activeGroup      = null;
  clearSearchState();
  state.gridOffset = 0;

  el.navItems.forEach(btn => btn.classList.remove("is-active"));
  const btn = document.querySelector(`[data-playlist-id="${cssEscape(playlist.id)}"]`);
  if (btn) btn.classList.add("is-active");

  render();
  renderPlaylistsSidebar();
  el.contentScroll.scrollTop = 0;
}

// ── Back Navigation ───────────────────────────────────────────────────────────
export function goBack() {
  if (!state.history.length) return;
  const prev = state.history.pop();
  updateBackButton();

  if (prev.group) {
    openGroup(prev.group.type, prev.group.key, true, prev.group.name);
  } else if (prev.playlist) {
    openPlaylist(prev.playlist, true);
  } else {
    setView(prev.view, true);
  }
  state.search=prev.search || "";
  state.sortField=prev.sortField || "none"; state.sortDir=prev.sortDir || "asc";
  state.filters=prev.filters || state.filters; state.gridOffset=prev.offset || 0;
  if(el.searchInput) el.searchInput.value=state.search;
  render();
}
