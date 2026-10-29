import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../public/modules/state.js';
import { syncFavorites, isFavorite } from '../public/modules/favorites.js';
import { setStorage } from '../public/modules/storage.js';
import { ensureTracks, refreshLibrary, loadLibraryPage } from '../public/modules/library-data.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
const track = (id, title = id) => ({ id, title, fileName: `${id}.mp3` });
const snapshot = ids => ({ trackIds: ids, playlists: [], favorites: [], recentIds: [], facets: { genre: [], year: [], codec: [] } });
const page = tracks => ({ tracks, total: tracks.length, groups: [] });
const pageRequest = path => path.startsWith('/api/library/tracks?');

function fixture(t, handler) {
  const oldFetch = globalThis.fetch, oldDocument = globalThis.document, oldSessionStorage = globalThis.sessionStorage;
  const events = [], document = new EventTarget();
  for (const name of ['tracks-cached', 'library-page-updated', 'library-updated']) document.addEventListener(name, () => events.push(name));
  globalThis.document = document;
  globalThis.sessionStorage = { getItem: key => key === 'local-amp-access' ? 'f'.repeat(64) : null };
  globalThis.fetch = async (path, options = {}) => path === '/api/session' ? json({ token: 'test-session' }) : handler(String(path), options);
  Object.assign(state, {
    tracks: [], trackIds: ['a', 'b'], playlists: [], currentTrackId: null, selectedTrackId: null,
    libraryReady: true, libraryRevision: state.libraryRevision + 1,
    libraryPage: { key: '', tracks: [], groups: [], total: 0, loading: false, error: '' },
    facets: { genre: [], year: [], codec: [] }, recentIds: [],
    activeView: 'songs', activeGroup: null, activePlaylistId: null, search: '',
    sortField: 'none', sortDir: 'asc', gridOffset: 0, gridPageSize: 150,
    filters: { genre: '', year: '', codec: '', duration: '', favorite: false, recentlyPlayed: false }
  });
  syncFavorites([]);
  setStorage('amp-favorites-migrated', 'yes');
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = oldSessionStorage;
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  });
  return events;
}
async function waitFor(predicate) {
  for (let turn = 0; turn < 20; turn++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Expected mocked request was not started.');
}

test('an out-of-order page response cannot replace the newer search results', async t => {
  const first = deferred(); let firstSignal;
  const events = fixture(t, (path, options) => {
    if (new URL(path, 'http://test').searchParams.get('q') === 'old') { firstSignal = options.signal; return first.promise; }
    return json(page([track('b', 'New result')]));
  });
  state.search = 'old'; const older = loadLibraryPage();
  state.search = 'new'; await loadLibraryPage();
  assert.equal(firstSignal.aborted, true);
  first.resolve(json(page([track('a', 'Stale result')]))); await older;
  assert.equal(state.libraryPage.tracks[0].title, 'New result');
  assert.equal(state.tracks.some(item => item.title === 'Stale result'), false);
  assert.deepEqual(events, ['library-page-updated']);
});

test('a superseded request failure does not overwrite a successful page with an error', async t => {
  const first = deferred(); let count = 0;
  fixture(t, () => ++count === 1 ? first.promise : json(page([track('b')])));
  const older = loadLibraryPage(); state.search = 'new'; await loadLibraryPage();
  first.reject(new DOMException('The operation was aborted.', 'AbortError')); await older;
  assert.equal(state.libraryPage.error, '');
  assert.deepEqual(state.libraryPage.tracks.map(item => item.id), ['b']);
});

test('a current page failure becomes visible and a forced retry can recover', async t => {
  let count = 0;
  fixture(t, () => ++count === 1 ? json({ error: 'Database temporarily unavailable.' }, 503) : json(page([track('a')])));
  await loadLibraryPage();
  assert.equal(state.libraryPage.loading, false);
  assert.match(state.libraryPage.error, /Database temporarily unavailable/);
  await loadLibraryPage({ force: true });
  assert.equal(state.libraryPage.error, '');
  assert.deepEqual(state.libraryPage.tracks.map(item => item.id), ['a']);
});

test('overlapping queue metadata requests share the lookup and preserve duplicate occurrences', async t => {
  const response = deferred(); let count = 0;
  fixture(t, path => {
    assert.equal(path, '/api/library/tracks/lookup'); count++; return response.promise;
  });
  const first = ensureTracks(['a']), second = ensureTracks(['a', 'a']);
  await waitFor(() => count === 1);
  response.resolve(json({ tracks: [track('a')] }));
  assert.deepEqual((await first).map(item => item.id), ['a']);
  assert.deepEqual((await second).map(item => item.id), ['a', 'a']);
  assert.equal(count, 1);
});

test('metadata requested before a refresh retries under the new library revision', async t => {
  const stale = deferred(); let lookups = 0;
  const events = fixture(t, path => {
    if (path.startsWith('/api/state')) return json(snapshot(['a', 'b']));
    if (pageRequest(path)) return json(page([track('b')]));
    assert.equal(path, '/api/library/tracks/lookup');
    return ++lookups === 1 ? stale.promise : json({ tracks: [track('a', 'Fresh metadata')] });
  });
  const queued = ensureTracks(['a']); await waitFor(() => lookups === 1);
  await refreshLibrary();
  stale.resolve(json({ tracks: [track('a', 'Stale metadata')] }));
  assert.equal((await queued)[0].title, 'Fresh metadata');
  assert.equal(lookups, 2);
  assert.equal(state.tracks.find(item => item.id === 'a').title, 'Fresh metadata');
  assert.equal(events.filter(name => name === 'tracks-cached').length, 1);
});

test('only the latest concurrent state refresh applies its snapshot', async t => {
  const first = deferred(); let snapshots = 0;
  const events = fixture(t, path => {
    if (path.startsWith('/api/state')) return ++snapshots === 1 ? first.promise : json(snapshot(['b']));
    assert.ok(pageRequest(path)); return json(page([track('b')]));
  });
  const older = refreshLibrary(); await refreshLibrary();
  first.resolve(json(snapshot(['a'])));
  assert.equal(await older, undefined);
  assert.deepEqual(state.trackIds, ['b']);
  assert.deepEqual(state.libraryPage.tracks.map(item => item.id), ['b']);
  assert.equal(events.filter(name => name === 'library-updated').length, 1);
});

test('a refresh superseded while its page loads cannot announce a stale completion', async t => {
  const firstPage = deferred(); let snapshots = 0, pages = 0;
  const events = fixture(t, path => {
    if (path.startsWith('/api/state')) return json(snapshot([++snapshots === 1 ? 'a' : 'b']));
    assert.ok(pageRequest(path)); return ++pages === 1 ? firstPage.promise : json(page([track('b')]));
  });
  const older = refreshLibrary(); await waitFor(() => pages === 1);
  await refreshLibrary(); firstPage.resolve(json(page([track('a')])));
  assert.equal(await older, undefined);
  assert.deepEqual(state.trackIds, ['b']);
  assert.deepEqual(state.libraryPage.tracks.map(item => item.id), ['b']);
  assert.equal(events.filter(name => name === 'library-updated').length, 1);
});

test('refresh updates the current track metadata even when it is outside the visible page', async t => {
  const events = fixture(t, path => {
    if (path.startsWith('/api/state')) return json(snapshot(['a', 'b']));
    if (pageRequest(path)) return json(page([track('b')]));
    assert.equal(path, '/api/library/tracks/lookup');
    return json({ tracks: [track('a', 'Updated playing track')] });
  });
  state.currentTrackId = 'a'; state.tracks = [track('a', 'Old metadata')];
  await refreshLibrary();
  assert.equal(state.tracks.find(item => item.id === 'a').title, 'Updated playing track');
  assert.equal(events.filter(name => name === 'library-updated').length, 1);
});

test('a superseded initial favorites migration cannot overwrite the newer snapshot', async t => {
  const migration = deferred(); let snapshots = 0, migrationStarted = false;
  fixture(t, path => {
    if (path.startsWith('/api/state')) {
      const data = snapshot(++snapshots === 1 ? ['a', 'b'] : ['b']);
      data.favorites = snapshots === 1 ? [] : ['b'];
      return json(data);
    }
    if (pageRequest(path)) return json(page([track('b')]));
    assert.equal(path, '/api/favorites/a'); migrationStarted = true; return migration.promise;
  });
  syncFavorites(['a']); setStorage('amp-favorites-migrated', 'no');
  const older = refreshLibrary({ initial: true }); await waitFor(() => migrationStarted);
  await refreshLibrary(); migration.resolve(json({ favorites: ['a'] })); await older;
  assert.deepEqual(state.trackIds, ['b']);
  assert.equal(isFavorite('a'), false);
  assert.equal(isFavorite('b'), true);
});

test('shared refresh preserves selected metadata outside the visible page', async t => {
  fixture(t, (path, options) => {
    if (path.startsWith('/api/state')) return json(snapshot(['a', 'b']));
    if (pageRequest(path)) return json(page([track('b')]));
    assert.equal(path, '/api/library/tracks/lookup');
    assert.deepEqual(JSON.parse(options.body).ids, ['a']);
    return json({ tracks: [track('a', 'Updated selected track')] });
  });
  state.selectedTrackId = 'a'; state.tracks = [track('a', 'Old selection')];
  await refreshLibrary();
  assert.equal(state.selectedTrackId, 'a');
  assert.equal(state.tracks.find(item => item.id === 'a').title, 'Updated selected track');
});

test('bounded metadata cache retains visible playlist covers and player metadata', async t => {
  fixture(t, (path, options) => {
    assert.equal(path, '/api/library/tracks/lookup');
    return json({ tracks: JSON.parse(options.body).ids.map(id => track(id)) });
  });
  const ids = Array.from({ length: 1200 }, (_, index) => 'id-' + index);
  state.trackIds = ids; state.tracks = ids.slice(0, 1000).map(id => track(id));
  state.activeView = 'playlists'; state.activePlaylistId = null;
  state.playlists = [{ id: 'p', trackIds: [ids[0]] }];
  state.currentTrackId = ids[1]; state.selectedTrackId = ids[2]; state.queueOpen = false;
  await ensureTracks(ids.slice(1000));
  assert.equal(state.tracks.length, 1000);
  for (const id of ids.slice(0, 3)) assert(state.tracks.some(item => item.id === id));
  assert.equal(state.tracks.some(item => item.id === ids[3]), false);
});
