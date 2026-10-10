import { state } from './state.js';
import { icons } from './icons.js';
import { el } from './dom.js';
import { esc, fmt, coverUrl, trackTitle, makeGroupKey, albumKey } from './utils.js';
import { groupKindForView, groupSummary } from './groups.js';
import { loadLibraryPage } from './library-data.js';
import { libraryPageKey } from './library-query.js';
import { activeGroup, activePlaylist, playlistSummary, firstPlaylistTrack } from './helpers.js';
import { getVisibleTracks } from './sort.js';
import { isFavorite } from './favorites.js';

let lastTracks, lastPlaylists, lastSignature, lastPage;
function highlights() {
  el.trackGrid.querySelectorAll('[data-track-id]').forEach(card => {
    const current = card.dataset.trackId === state.currentTrackId;
    card.classList.toggle('is-active', current);
    card.classList.toggle('is-playing', current && !el.audio.paused);
    card.classList.toggle('is-selected', card.dataset.trackId === state.selectedTrackId);
    card.querySelector('[data-play-btn]')?.setAttribute('aria-label', current && !el.audio.paused ? 'Pause track' : 'Play track');
  });
}
function page(items) {
  state.gridOffset = Math.min(state.gridOffset || 0, Math.max(0, Math.floor((items.length - 1) / state.gridPageSize) * state.gridPageSize));
  return items.slice(state.gridOffset, state.gridOffset + state.gridPageSize);
}
function pagination(total) {
  if (total <= state.gridPageSize) return '';
  const start = state.gridOffset;
  return `<div class="page-controls"><button type="button" data-grid-page="-1" ${start === 0 ? 'disabled' : ''}>Previous</button><span>${start + 1}–${Math.min(total, start + state.gridPageSize)} of ${total}</span><button type="button" data-grid-page="1" ${start + state.gridPageSize >= total ? 'disabled' : ''}>Next</button></div>`;
}
export function toggleEmptyState() {
  el.importPanel.classList.toggle('is-hidden', !state.libraryReady || state.trackIds.length > 0);
  el.contentScroll.classList.toggle('is-hidden', !state.libraryReady || (state.trackIds.length === 0 && state.activeView !== 'playlists'));
  if (state.activeView === 'playlists') el.importPanel.classList.add('is-hidden');
}
export function renderViewTitle() {
  const group = activeGroup(), playlist = activePlaylist();
  el.viewTitle.textContent = group?.name || playlist?.name || ({home:'Home', recent:'Recently Added', artists:'Artists', albums:'Albums', songs:'Songs', playlists:'All Playlists', search:'Search Results'})[state.activeView] || 'Library';
}
export function renderPlaylistsSidebar() {
  el.sidebarPlaylistList.innerHTML = state.playlists.map(playlist => `<li class="sidebar-playlist"><button class="nav-item ${playlist.id === state.activePlaylistId ? 'is-active' : ''}" data-playlist-id="${esc(playlist.id)}"><span>${esc(playlist.name)}</span></button><div class="playlist-inline-actions"><button class="playlist-mini-action" data-playlist-rename="${esc(playlist.id)}" aria-label="Rename ${esc(playlist.name)}">${icons.edit}</button><button class="playlist-mini-action" data-playlist-delete="${esc(playlist.id)}" aria-label="Delete ${esc(playlist.name)}">${icons.x}</button></div></li>`).join('');
}
export function renderGrid() {
  if (state.libraryPage.key !== libraryPageKey(state)) loadLibraryPage();
  const signature = JSON.stringify([state.activeView, state.activeGroup, state.activePlaylistId, state.search, state.sortField, state.sortDir, state.layout, state.filters, state.gridOffset, state.favoriteRevision, state.recentIds]);
  if (lastPage === state.libraryPage && lastTracks === state.tracks && lastPlaylists === state.playlists && lastSignature === signature) { highlights(); return; }
  lastPage = state.libraryPage;
  lastTracks = state.tracks; lastPlaylists = state.playlists; lastSignature = signature;
  const focused = document.activeElement?.closest('[data-track-id]')?.dataset.trackId;
  contents();
  if (focused) el.trackGrid.querySelector(`[data-track-id="${CSS.escape(focused)}"]`)?.focus({preventScroll:true});
}
function contents() {
  if (state.libraryPage.loading) { el.trackGrid.innerHTML = '<p class="empty-grid-message" role="status">Loading library…</p>'; el.listHeaders?.classList.add('is-hidden'); return; }
  if (state.libraryPage.error) { el.trackGrid.innerHTML = `<div class="empty-grid-message" role="status">${esc(state.libraryPage.error)} <button type="button" data-library-retry>Retry</button></div>`; el.listHeaders?.classList.add('is-hidden'); return; }
  const type = groupKindForView(), showGroups = type && !state.activeGroup;
  const collection = state.activeView === 'playlists' && !state.activePlaylistId;
  const tracks = getVisibleTracks(), playlist = activePlaylist();
  el.trackGrid.classList.toggle('is-list', state.layout === 'list' && !collection);
  const headers = state.layout === 'list' && !showGroups && !collection && tracks.length > 0;
  el.listHeaders?.classList.toggle('is-hidden', !headers);
  if (headers) el.headerCols.forEach(column => {
    const active = state.sortField === column.dataset.sort;
    column.setAttribute('aria-pressed', String(active));
    column.title = active ? `Sorted ${state.sortDir === 'asc' ? 'ascending' : 'descending'}. Click to reverse.` : 'Sort by this column';
    column.classList.toggle('is-active', active);
    const icon = column.querySelector('.sort-icon');
    if (icon) icon.innerHTML = active ? icons[state.sortDir === 'asc' ? 'arrow-down' : 'arrow-up'] : '';
  });
  let items, html;
  if (collection) {
    items = state.playlists;
    html = page(items).map(playlist => `<article tabindex="0" class="grid-card group-card" data-playlist-card-id="${esc(playlist.id)}" aria-label="Playlist ${esc(playlist.name)}"><div class="card-art"><img src="${coverUrl(firstPlaylistTrack(playlist))}" alt="" loading="lazy"><button class="card-play" type="button" aria-label="Play playlist" data-playlist-play>${icons.play_pause_morph}</button></div><div class="card-copy"><div class="card-title">${esc(playlist.name)}</div><div class="card-subtitle">${esc(playlistSummary(playlist))}</div></div><div class="playlist-card-actions"><button data-playlist-rename="${esc(playlist.id)}" type="button">Rename</button><button data-playlist-export="${esc(playlist.id)}" type="button">Export M3U</button><button data-playlist-delete="${esc(playlist.id)}" type="button">Delete</button></div></article>`).join('');
  } else if (showGroups) {
    items = state.libraryPage.groups;
    html = items.map(group => `<article tabindex="0" class="grid-card group-card" data-group-type="${type}" data-group-key="${esc(group.key)}" data-group-name="${esc(group.name)}" aria-label="${esc(group.name)}"><div class="card-art"><img src="${coverUrl(group.artworkTrack)}" alt="" loading="lazy"><button class="card-play" type="button" aria-label="Play ${esc(group.name)}" data-play-btn>${icons.play_pause_morph}</button></div><div class="card-copy"><div class="card-title">${esc(group.name)}</div><div class="card-subtitle">${esc(groupSummary(group))}</div></div><div class="card-meta">${group.trackCount} songs</div><div class="card-duration">${fmt(group.duration)}</div></article>`).join('');
  } else {
    items = tracks; html = items.map(track => trackCard(track, playlist)).join('');
  }
  el.trackGrid.innerHTML = html + pagination(collection ? items.length : state.libraryPage.total) || '<div class="empty-grid-message">No matching items. Adjust filters or add music.</div>';
  highlights();
}
function trackCard(track, playlist) {
  const favorite = isFavorite(track.id), title = trackTitle(track), artist = track.artist || 'Unknown Artist', album = track.album || 'Unknown Album';
  return `<article tabindex="0" class="grid-card" data-track-id="${esc(track.id)}" aria-label="${esc(title)}, ${esc(artist)}"><div class="card-art"><img src="${coverUrl(track)}" alt="" loading="lazy"><button class="card-play" type="button" aria-label="Play ${esc(title)}" data-play-btn>${icons.play_pause_morph}</button></div><div class="track-card-actions"><button class="track-mini-action ${favorite ? 'is-favorite' : ''}" data-track-favorite="${esc(track.id)}" aria-pressed="${favorite}" aria-label="Favorite ${esc(title)}">♥</button><button class="track-mini-action" data-track-playlist="${esc(track.id)}" aria-label="Choose playlists">${icons.plus}</button><button class="track-mini-action" data-track-details="${esc(track.id)}" aria-label="Track information">ⓘ</button>${playlist ? `<button class="track-mini-action" data-track-remove-playlist="${esc(track.id)}" aria-label="Remove from playlist">${icons.x}</button><button class="track-mini-action" data-playlist-move="${esc(track.id)}" data-direction="-1" aria-label="Move up">↑</button><button class="track-mini-action" data-playlist-move="${esc(track.id)}" data-direction="1" aria-label="Move down">↓</button>` : ''}</div><div class="card-copy"><div class="card-title">${esc(title)}</div><div class="card-subtitle"><button class="nav-link" type="button" data-group-type="artist" data-group-key="${esc(makeGroupKey('artist', artist))}">${esc(artist)}</button></div></div><div class="card-meta"><button class="nav-link" type="button" data-group-type="album" data-group-key="${esc(albumKey(track))}">${esc(album)}</button></div><div class="card-duration">${track.available === false ? 'File missing · ' : ''}${fmt(track.duration)}</div></article>`;
}
