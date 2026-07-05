// ── Navigation & History ─────────────────────────────────────────────────────
import { state } from "./state.js";
import { el }    from "./dom.js";
import { groupTracks } from "./groups.js";
import { render, renderViewTitle, renderGrid, renderGroupSidebar, renderPlaylistsSidebar } from "./render.js";
import { cssEscape } from "./utils.js";

const VALID_VIEWS = new Set(["home", "recent", "artists", "albums", "songs", "playlists", "search"]);
const MAX_HISTORY_ITEMS = 100;

// ── Back Button ───────────────────────────────────────────────────────────────
export function updateBackButton() {
  if (!el.backButton) return;
  const has = state.history.length > 0;
  el.backButton.style.opacity       = has ? "1" : "0.5";
  el.backButton.style.pointerEvents = has ? "auto" : "none";
}

export function pushHistory() {
  state.history.push({
    view:     state.activeView,
    group:    state.activeGroup ? { ...state.activeGroup } : null,
    playlist: state.activePlaylistId,
    search:   state.search
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
  state.sortField       = "none";
  state.sortDir         = "asc";
  clearSearchState();

  el.navItems.forEach(btn =>
    btn.classList.toggle("is-active", btn.dataset.view === view)
  );

  renderViewTitle();
  renderGrid();
  renderGroupSidebar();
  renderPlaylistsSidebar();
}

export function openGroup(type, key, skipHistory = false) {
  const group = groupTracks(type).find(g => g.key === key);
  if (!group) return;
  if (!skipHistory) pushHistory();

  state.activeView       = type === "album" ? "albums" : "artists";
  state.activePlaylistId = null;
  state.activeGroup      = { type, key, name: group.name };
  state.sortField        = "none";
  state.sortDir          = "asc";
  clearSearchState();

  el.navItems.forEach(btn =>
    btn.classList.toggle("is-active", btn.dataset.view === state.activeView)
  );
  render();
  renderGroupSidebar();
  renderPlaylistsSidebar();
}

export function openPlaylist(playlistId, skipHistory = false) {
  const playlist = state.playlists.find(p => p.id === playlistId);
  if (!playlist) return;
  if (!skipHistory) pushHistory();

  state.activeView       = "playlists";
  state.activePlaylistId = playlist.id;
  state.activeGroup      = null;
  state.sortField        = "none";
  state.sortDir          = "asc";
  clearSearchState();

  el.navItems.forEach(btn => btn.classList.remove("is-active"));
  const btn = document.querySelector(`[data-playlist-id="${cssEscape(playlist.id)}"]`);
  if (btn) btn.classList.add("is-active");

  render();
  renderGroupSidebar();
  renderPlaylistsSidebar();
}

// ── Back Navigation ───────────────────────────────────────────────────────────
export function goBack() {
  if (!state.history.length) return;
  const prev = state.history.pop();
  updateBackButton();

  if (prev.group) {
    openGroup(prev.group.type, prev.group.key, true);
  } else if (prev.playlist) {
    openPlaylist(prev.playlist, true);
  } else {
    state.search = prev.search || "";
    if (el.searchInput) el.searchInput.value = state.search;
    setView(prev.view, true);
  }
}
