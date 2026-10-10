import { state } from './state.js';
import { api } from './api.js';
import { syncFavorites, migrateFavorites } from './favorites.js';
import { libraryQuery, libraryPageKey } from './library-query.js';

let pageController, refreshSequence = 0;
const pendingTracks = new Map();
function announce(type) { document.dispatchEvent(new Event(type)); }
function mergeTracks(tracks) {
  const cache = new Map(state.tracks.map(track => [track.id, track]));
  for (const track of tracks) { cache.delete(track.id); cache.set(track.id, track); }
  const pinned = new Set([state.currentTrackId, state.selectedTrackId,
    ...state.libraryPage.tracks.map(track => track.id),
    ...(state.activeView === 'playlists' && !state.activePlaylistId
      ? state.playlists.slice(state.gridOffset, state.gridOffset + state.gridPageSize).map(playlist => playlist.trackIds[0]) : []),
    ...(state.queueOpen ? state.queue.slice(state.queuePage * 100, state.queuePage * 100 + 100) : [])]);
  for (const id of cache.keys()) {
    if (cache.size <= 1000) break;
    if (!pinned.has(id)) cache.delete(id);
  }
  state.tracks = [...cache.values()];
}
export async function ensureTracks(ids, { force = false } = {}) {
  const cached = new Set(state.tracks.map(track => track.id));
  const valid = new Set(state.trackIds);
  const missing = [...new Set(ids)].filter(id => valid.has(id) && (force || !cached.has(id)));
  const fresh = missing.filter(id => !pendingTracks.has(id));
  const generation = state.libraryRevision;
  for (let start = 0; start < fresh.length; start += 150) {
    const chunk = fresh.slice(start, start + 150);
    const request = api('/api/library/tracks/lookup', {
      method: 'POST', body: JSON.stringify({ ids: chunk })
    }).then(data => {
      if (generation === state.libraryRevision) { mergeTracks(data.tracks); announce('tracks-cached'); }
    }).finally(() => { for (const id of chunk) if (pendingTracks.get(id) === request) pendingTracks.delete(id); });
    for (const id of chunk) pendingTracks.set(id, request);
  }
  await Promise.all(missing.map(id => pendingTracks.get(id)));
  if (generation !== state.libraryRevision) return ensureTracks(ids);
  const byId = new Map(state.tracks.map(track => [track.id, track]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}
export async function refreshLibrary({ initial = false } = {}) {
  const sequence = ++refreshSequence;
  const data = await api('/api/state?includeTracks=false', { timeoutMs: 120000 });
  if (sequence !== refreshSequence) return;
  pageController?.abort();
  state.trackIds = data.trackIds;
  state.playlists = data.playlists;
  state.facets = data.facets;
  state.recentIds = data.recentIds;
  state.libraryReady = true;
  state.libraryRevision++;
  pendingTracks.clear();
  // Keep current metadata while audio is playing; refetch other entries after mutations.
  state.tracks = state.tracks.filter(track => track.id === state.currentTrackId && state.trackIds.includes(track.id));
  if (initial) await migrateFavorites(data.favorites, () => sequence === refreshSequence);
  else syncFavorites(data.favorites);
  if (sequence !== refreshSequence) return;
  if (!state.trackIds.includes(state.selectedTrackId)) state.selectedTrackId = null;
  if (state.activePlaylistId && !state.playlists.some(item => item.id === state.activePlaylistId)) state.activePlaylistId = null;
  state.libraryPage = { key: '', tracks: [], groups: [], total: 0, loading: false, error: '' };
  await loadLibraryPage();
  if (sequence !== refreshSequence) return;
  if (!state.selectedTrackId) state.selectedTrackId = state.libraryPage.tracks[0]?.id || null;
  try {
    if (state.trackIds.includes(state.currentTrackId)) await ensureTracks([state.currentTrackId], { force: true });
    if (state.trackIds.includes(state.selectedTrackId)) await ensureTracks([state.selectedTrackId]);
  }
  finally { if (sequence === refreshSequence) announce('library-updated'); }
  if (sequence !== refreshSequence) return;
  return data;
}
export async function loadLibraryPage({ force = false } = {}) {
  if (!state.libraryReady) return;
  const key = libraryPageKey(state);
  if (!force && state.libraryPage.key === key) return;
  pageController?.abort();
  const controller = pageController = new AbortController();
  state.libraryPage = { key, tracks: [], groups: [], total: 0, loading: true, error: '' };
  try {
    if (state.activeView === 'playlists' && !state.activePlaylistId) {
      if (state.gridOffset > 0 && state.gridOffset >= state.playlists.length) {
        state.gridOffset = Math.max(0, Math.floor((state.playlists.length - 1) / state.gridPageSize) * state.gridPageSize);
        return loadLibraryPage({ force: true });
      }
      const firstIds = state.playlists.slice(state.gridOffset, state.gridOffset + state.gridPageSize)
        .map(playlist => playlist.trackIds[0]).filter(Boolean);
      await ensureTracks(firstIds);
      if (controller.signal.aborted) return;
      state.libraryPage = { key, tracks: [], groups: [], total: state.playlists.length, loading: false, error: '' };
    } else {
      const data = await api('/api/library/tracks?' + libraryQuery(state), { signal: controller.signal });
      if (controller.signal.aborted) return;
      const total = data.total;
      if (state.gridOffset > 0 && state.gridOffset >= total) {
        state.gridOffset = Math.max(0, Math.floor((total - 1) / state.gridPageSize) * state.gridPageSize);
        return loadLibraryPage({ force: true });
      }
      mergeTracks(data.tracks || []);
      state.libraryPage = { key, tracks: data.tracks || [], groups: data.groups || [], total, loading: false, error: '' };
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    state.libraryPage = { key, tracks: [], groups: [], total: 0, loading: false, error: error.message };
  }
  if (!controller.signal.aborted) announce('library-page-updated');
}
export async function matchingTrackIds(overrides = {}, signal) {
  const data = await api('/api/library/tracks?' + libraryQuery(state, { groupBy: '', idsOnly: true, ...overrides }), { signal });
  return data.trackIds;
}
