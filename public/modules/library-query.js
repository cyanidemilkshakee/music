// The same query drives a visible page and its complete playback context.
export function libraryQuery(state, overrides = {}) {
  const groupBy = !state.activeGroup && !state.activePlaylistId
    ? ({ albums: 'album', artists: 'artist' })[state.activeView] || '' : '';
  const values = {
    view: state.activeView === 'search' || state.activeView === 'playlists' ? 'home' : state.activeView,
    limit: state.gridPageSize, offset: state.gridOffset || 0,
    q: state.search.trim(), sortField: state.sortField, sortDir: state.sortDir,
    ...state.filters, playlistId: state.activePlaylistId || '',
    groupType: state.activeGroup?.type || '', groupKey: state.activeGroup?.key || '',
    groupBy, ...overrides
  };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== '' && value !== false && value != null) query.set(key, String(value));
  }
  return query;
}

export function libraryPageKey(state) {
  const playlist = state.playlists.find(item => item.id === state.activePlaylistId);
  return JSON.stringify([libraryQuery(state).toString(), state.libraryRevision,
    state.filters.favorite ? state.favoriteRevision : 0,
    state.filters.recentlyPlayed ? state.recentIds : [], playlist?.trackIds]);
}
