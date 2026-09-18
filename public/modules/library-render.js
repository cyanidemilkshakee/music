import { state, DEFAULT_COVER } from "./state.js";
import { icons } from "./icons.js";
import { el } from "./dom.js";
import { esc, fmt, coverUrl, trackTitle, makeGroupKey } from "./utils.js";
import { groupTracks, groupKindForView, groupSummary } from "./groups.js";
import { activeGroup, activePlaylist, playlistSummary, firstPlaylistTrack } from "./helpers.js";
import { getVisibleTracks } from "./sort.js";
import { isFavorite } from "./favorites.js";

let viewTransitionRunning = false;
function withViewTransition(callback) {
  if (!document.startViewTransition || viewTransitionRunning) return callback();
  viewTransitionRunning = true;
  try {
    const transition = document.startViewTransition(callback);
    transition.ready.catch(() => {});
    transition.finished.catch(() => {}).finally(() => { viewTransitionRunning = false; });
  }
  catch { viewTransitionRunning = false; callback(); }
}

export function toggleEmptyState() {
  const hasTracks = state.tracks.length > 0;
  el.importPanel.classList.toggle("is-hidden", hasTracks);
  el.contentScroll.classList.toggle("is-hidden", !hasTracks);
}

export function renderViewTitle() {
  const group = activeGroup();
  const playlist = activePlaylist();
  if (group) { el.viewTitle.textContent = group.name; return; }
  if (playlist) { el.viewTitle.textContent = playlist.name; return; }
  const titles = { home: "Home", recent: "Recently Added", artists: "Artists", albums: "Albums", songs: "Songs", playlists: "All Playlists", search: "Search Results" };
  el.viewTitle.textContent = titles[state.activeView] || "Library";
}

export function renderPlaylistsSidebar() {
  el.sidebarPlaylistList.innerHTML = state.playlists.map(playlist => `<li><button class="nav-item ${playlist.id === state.activePlaylistId ? "is-active" : ""}" data-playlist-id="${esc(playlist.id)}"><span>${esc(playlist.name)}</span><span class="playlist-inline-actions"><span class="playlist-mini-action" data-playlist-rename="${esc(playlist.id)}" title="Rename playlist">${icons.edit || icons.album}</span><span class="playlist-mini-action" data-playlist-delete="${esc(playlist.id)}" title="Delete playlist">${icons.x}</span></span></button></li>`).join("");
}

export function renderGrid() { withViewTransition(renderGridContents); }

function renderGridContents() {
  if (state.activeView === "playlists" && !state.activePlaylistId) return renderPlaylistCollection();
  const groupType = groupKindForView();
  const showGroups = Boolean(groupType && !state.activeGroup);
  const tracks = getVisibleTracks();
  const isList = state.layout === "list";
  el.trackGrid.classList.toggle("is-list", isList);
  const showHeaders = isList && !showGroups && tracks.length > 0;
  el.listHeaders?.classList.toggle("is-hidden", !showHeaders);
  if (showHeaders) el.headerCols.forEach(column => {
    const active = state.sortField === column.dataset.sort;
    column.classList.toggle("is-active", active);
    const icon = column.querySelector(".sort-icon");
    if (icon) icon.innerHTML = active ? (state.sortDir === "asc" ? icons["arrow-down"] : icons["arrow-up"]) : "";
  });
  if (showGroups) return renderGroups(groupType);
  if (!tracks.length) {
    el.trackGrid.innerHTML = `<div class="empty-grid-message">${state.search ? `No results for "${esc(state.search)}".` : "No tracks found."}</div>`;
    return;
  }
  const playlist = activePlaylist();
  const visible = tracks.slice(0, state.gridLimit);
  el.trackGrid.innerHTML = visible.map(track => trackCard(track, playlist)).join("") + (tracks.length > visible.length ? `<button class="load-more" type="button" data-load-more>Show ${Math.min(state.gridPageSize, tracks.length - visible.length)} more of ${tracks.length}</button>` : "");
}

function renderPlaylistCollection() {
  el.trackGrid.classList.remove("is-list");
  el.listHeaders?.classList.add("is-hidden");
  if (!state.playlists.length) { el.trackGrid.innerHTML = `<div class="empty-grid-message">No playlists yet. Click <strong>+</strong> in the sidebar to create one.</div>`; return; }
  el.trackGrid.innerHTML = state.playlists.map(playlist => {
    const first = firstPlaylistTrack(playlist); const summary = playlistSummary(playlist);
    return `<div class="grid-card group-card" data-playlist-card-id="${esc(playlist.id)}"><div class="card-art"><img src="${coverUrl(first)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${DEFAULT_COVER}'"><div class="card-play" data-playlist-play="true">${icons.play_pause_morph}</div></div><div class="card-copy"><div class="card-title">${esc(playlist.name)}</div><div class="card-subtitle">${esc(summary)}</div></div><div class="playlist-card-actions"><button class="card-glass-action" data-playlist-rename="${esc(playlist.id)}" type="button">Rename</button><button class="card-glass-action danger" data-playlist-delete="${esc(playlist.id)}" type="button">Delete</button></div><div class="card-meta">Playlist</div><div class="card-duration">${esc(summary)}</div></div>`;
  }).join("");
}

function renderGroups(groupType) {
  const groups = groupTracks(groupType);
  if (!groups.length) { el.trackGrid.innerHTML = `<div class="empty-grid-message">No ${groupType === "album" ? "albums" : "artists"} found.</div>`; return; }
  el.trackGrid.innerHTML = groups.map(group => {
    const meta = group.type === "album" ? group.artists.slice(0, 3).join(", ") : group.albums.slice(0, 3).join(", ");
    return `<div class="grid-card group-card" data-group-type="${group.type}" data-group-key="${esc(group.key)}"><div class="card-art"><img src="${coverUrl(group.artworkTrack)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${DEFAULT_COVER}'"><div class="card-play" data-play-btn="true">${icons.play_pause_morph}</div></div><div class="card-copy"><div class="card-title">${esc(group.name)}</div><div class="card-subtitle">${esc(groupSummary(group))}</div></div><div class="card-meta">${esc(meta || groupSummary(group))}</div><div class="card-duration">${group.tracks.length} ${group.tracks.length === 1 ? "song" : "songs"}</div></div>`;
  }).join("");
}

function trackCard(track, playlist) {
  const current = track.id === state.currentTrackId;
  const playing = current && !el.audio.paused;
  const selected = track.id === state.selectedTrackId;
  const artist = track.artist || "Unknown Artist";
  const album = track.album || "Unknown Album";
  const favorite = isFavorite(track.id);
  return `<div class="grid-card ${current ? "is-active" : ""} ${selected ? "is-selected" : ""} ${playing ? "is-playing" : ""}" data-track-id="${esc(track.id)}"><div class="card-art"><img src="${coverUrl(track)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${DEFAULT_COVER}'"><div class="card-play" data-play-btn="true">${icons.play_pause_morph}</div></div><div class="track-card-actions"><button class="track-mini-action favorite-action ${favorite ? "is-favorite" : ""}" data-track-favorite="${esc(track.id)}" title="${favorite ? "Remove from favorites" : "Add to favorites"}" aria-label="${favorite ? "Remove from favorites" : "Add to favorites"}" type="button">♥</button><button class="track-mini-action" data-track-playlist="${esc(track.id)}" title="Add or remove from playlists" aria-label="Add or remove from playlists" type="button">${icons.plus}</button>${playlist ? `<button class="track-mini-action danger" data-track-remove-playlist="${esc(track.id)}" title="Remove from this playlist" aria-label="Remove from this playlist" type="button">${icons.x}</button>` : ""}</div><div class="card-copy"><div class="card-title">${esc(trackTitle(track))}</div><div class="card-subtitle"><span class="nav-link" data-group-type="artist" data-group-key="${esc(makeGroupKey("artist", artist))}">${esc(artist)}</span></div></div><div class="card-meta"><span class="nav-link" data-group-type="album" data-group-key="${esc(makeGroupKey("album", album))}">${esc(album)}</span></div><div class="card-duration">${fmt(track.duration)}</div></div>`;
}
