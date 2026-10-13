import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryQuery, libraryPageKey } from '../public/modules/library-query.js';
const base = () => ({ activeView: 'songs', activeGroup: null, activePlaylistId: null,
  gridPageSize: 150, gridOffset: 150, search: '  Jazz & soul  ', sortField: 'title', sortDir: 'desc',
  filters: { genre: 'Jazz', year: '', codec: '', duration: 'medium', favorite: true, recentlyPlayed: false },
  libraryRevision: 1, favoriteRevision: 1, recentIds: [], playlists: [] });
test('page and playback context share scopes, filters and sorting', () => {
  const state = base(); state.activePlaylistId = 'id/+ &';
  const page = libraryQuery(state), ids = libraryQuery(state, { groupBy: '', idsOnly: true });
  for (const name of ['playlistId', 'q', 'genre', 'duration', 'favorite', 'sortField', 'sortDir'])
    assert.equal(ids.get(name), page.get(name));
  assert.equal(ids.get('idsOnly'), 'true'); assert.equal(page.get('q'), 'Jazz & soul');
  assert.equal(page.get('playlistId'), 'id/+ &'); assert.equal(page.has('recentlyPlayed'), false);
});
test('group overview and drilldown request different result kinds', () => {
  const state = base(); state.activeView = 'albums';
  assert.equal(libraryQuery(state).get('groupBy'), 'album');
  state.activeGroup = { type: 'album', key: 'album:["é","artist"]' };
  const query = libraryQuery(state); assert.equal(query.has('groupBy'), false);
  assert.equal(query.get('groupKey'), state.activeGroup.key);
});
test('cached page invalidates for membership, recent and favorite changes', () => {
  const state = base(); state.filters.recentlyPlayed = true; state.activePlaylistId = 'p'; state.playlists = [{ id: 'p', trackIds: ['a'] }];
  let key = libraryPageKey(state); state.playlists[0].trackIds.push('b'); assert.notEqual(libraryPageKey(state), key);
  key = libraryPageKey(state); state.recentIds.push('a'); assert.notEqual(libraryPageKey(state), key);
  key = libraryPageKey(state); state.favoriteRevision++; assert.notEqual(libraryPageKey(state), key);
});
