import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This suite owns its servers, music fixtures and database. It never connects
// to the user's running server or opens the workspace data directory.
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'test-results');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'LocalAmpBrowserTest-'));
const servers = [];
const apiOnly = process.argv.includes('--api-only');
const failures = [];
const frontendRequests = [];
let browser, context, page;

async function until(check, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}

async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

function launch(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, windowsHide: true, ...options });
  child.on('error', error => { child.launchError = error; });
  return child;
}

async function buildBackend() {
  if (process.env.LOCAL_AMP_TEST_BINARY) return path.resolve(process.env.LOCAL_AMP_TEST_BINARY);
  const child = launch('cargo', ['build', '--locked'], { cwd: path.join(root, 'backend'), stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, 'The integration backend must build successfully.');
  return path.join(root, 'backend', 'target', 'debug', process.platform === 'win32' ? 'backend.exe' : 'backend');
}

async function startBackend(binary, name, overrides = {}) {
  const data = path.join(temporary, name);
  await mkdir(data);
  const port = await freePort();
  const child = launch(binary, [], { cwd: temporary, env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data,
    SCAN_CONCURRENCY: '1', FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
    FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe', JSON_LIMIT: '1mb',
    ...overrides,
  } });
  let log = '';
  child.stdout.on('data', data => { log = (log + data).slice(-30_000); });
  child.stderr.on('data', data => { log = (log + data).slice(-30_000); });
  const server = { child, data, base: `http://127.0.0.1:${port}`, token: '', log: () => log };
  servers.push(server);
  await until(async () => {
    if (child.launchError || child.exitCode !== null) throw child.launchError || new Error(log);
    const response = await fetch(server.base + '/api/identity', { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const session = await response.json();
    if (session.app !== 'LocalAmp' || session.processId !== child.pid) return false;
    const credential = JSON.parse(await readFile(path.join(data, 'launch.json'), 'utf8'));
    if (credential.processId !== child.pid || credential.port !== port) return false;
    server.token = credential.bootstrapToken;
    return server.token;
  }, `start isolated ${name} backend`);
  return server;
}

async function request(server, route, method = 'GET', body, expected = 200) {
  const headers = { 'x-local-amp-token': server.token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(server.base + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route}: ${text.slice(0, 500)}`);
  return response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
}

async function embeddedAssets(server, directory = path.join(root, 'public')) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { await embeddedAssets(server, file); continue; }
    const route = '/' + path.relative(path.join(root, 'public'), file).split(path.sep).join('/');
    const response = await fetch(server.base + encodeURI(route), { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, `Embedded asset ${route} must exist.`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(file), `Embedded asset ${route} must match current source bytes; rebuild the tested binary.`);
  }
}

function wav(seconds = 20, frequency = 440) {
  const sampleRate = 8000, samples = sampleRate * seconds;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin(index * frequency * Math.PI * 2 / sampleRate) * 2000), 44 + index * 2);
  return data;
}

async function finishScan(server, id) {
  const result = await until(async () => {
    const snapshot = await request(server, `/api/scan/${encodeURIComponent(id)}`);
    return snapshot.finished && snapshot;
  }, 'scan finishes', 120_000);
  assert.equal(result.event.phase, 'complete', JSON.stringify(result.event));
  return result.event;
}

async function scan(server, directory) {
  const { jobId } = await request(server, '/api/scan', 'POST', { directory }, 202);
  return finishScan(server, jobId);
}

async function openImport(directory) {
  await page.locator('#sidebarImportButton').click();
  await page.locator('#folderInputSheet').fill(directory);
  const starting = page.waitForResponse(response => response.url().endsWith('/api/scan') && response.request().method() === 'POST');
  await page.locator('#importButtonSheet').click();
  return (await (await starting).json()).jobId;
}

async function clearInitialLibrary(server) {
  for (const track of (await request(server, '/api/state')).tracks) await request(server, `/api/tracks/${track.id}`, 'DELETE');
  // The cancellation fixture is deliberately large. Remove its saved source
  // after testing cancellation so a later backup does not rescan that fixture.
  for (const source of (await request(server, '/api/library/sources')).sources) await request(server, `/api/library/sources/${source.id}`, 'DELETE');
}

async function clickRevealedAction(item, selector) {
  // Card and queue actions appear when their item is hovered or focused.
  await item.hover();
  await item.locator(selector).click();
}

async function apiContracts(server, music) {
  const state = await request(server, '/api/state');
  assert.equal(state.tracks.length, 3);
  const ids = state.tracks.map(track => track.id);
  const health = await request(server, '/api/health');
  assert.equal(health.checks.database, true);
  assert.equal(health.checks.ffmpeg, true);
  assert.equal(health.checks.ffprobe, true);
  assert.equal(health.limits.jsonLimitBytes, 1024 * 1024);
  assert.equal(typeof health.limits.m3uTextBytes, 'number');
  const stats = await request(server, '/api/stats');
  assert.equal(stats.totalTracks, 3);
  assert(stats.totalDuration >= 59);
  assert((await request(server, '/api/library/sources')).sources.some(source => source.path === music || source.path === path.toNamespacedPath(music)));
  const unauthenticated = await fetch(server.base + '/api/playlists', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"No token"}' });
  assert.equal(unauthenticated.status, 403);
  const playlist = (await request(server, '/api/playlists', 'POST', { name: 'API contract' }, 201)).playlist;
  await request(server, `/api/playlists/${playlist.id}/tracks`, 'POST', { trackId: ids[0] });
  await request(server, `/api/playlists/${playlist.id}/tracks`, 'POST', { trackId: ids[0] });
  let snapshot = await request(server, '/api/state');
  assert.deepEqual(snapshot.playlists.find(item => item.id === playlist.id).trackIds, [ids[0]], 'Single-track append is idempotent.');
  await request(server, `/api/tracks/${ids[1]}/playlists`, 'PUT', { playlistIds: [playlist.id] });
  await request(server, `/api/playlists/${playlist.id}/tracks`, 'PUT', { trackIds: [ids[1], ids[0]] });
  snapshot = await request(server, '/api/state');
  assert.deepEqual(snapshot.playlists.find(item => item.id === playlist.id).trackIds, [ids[1], ids[0]]);
  await request(server, `/api/favorites/${ids[0]}`, 'PUT');
  await request(server, `/api/recent/${ids[0]}`, 'POST');
  const firstPage = await request(server, '/api/library/tracks?limit=1&offset=0');
  const secondPage = await request(server, '/api/library/tracks?limit=1&offset=1');
  assert.equal(firstPage.total, 3);
  assert.notEqual(firstPage.tracks[0].id, secondPage.tracks[0].id);
  assert.equal((await request(server, '/api/library/tracks?limit=1&q=%25')).total, 0, 'SQL wildcard search is literal.');
  await request(server, '/api/library/tracks?limit=0', 'GET', undefined, 400);
  const decoded = await request(server, `/api/decode/${ids[0]}`, 'POST', { format: 'original' });
  const response = await fetch(server.base + decoded.audioUrl, { headers: { Range: 'bytes=0-43' } });
  assert.equal(response.status, 206);
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
  assert.equal((await fetch(server.base + decoded.audioUrl, { method: 'HEAD' })).status, 200);
  const m3u = await request(server, `/api/playlists/${playlist.id}/m3u`);
  const imported = await request(server, '/api/playlists/import', 'POST', { name: 'API M3U', text: m3u });
  assert.deepEqual(imported.playlist.trackIds, [ids[1], ids[0]]);
  assert.equal(typeof await request(server, '/metrics'), 'string');
  return { ids, playlist };
}

async function browserFeatures(server, music, cancellation) {
  // Match the launcher: a private local page supplies the credential without
  // placing the broad secret in browser process arguments or HTTP requests.
  await page.goto(pathToFileURL(path.join(server.data, 'launch.html')).href);
  await page.locator('#importPanel').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).hash, '', 'The browser must remove the launch fragment.');
  const canceledJob = await openImport(cancellation);
  await page.reload();
  await page.locator('#sidebarImportButton').click();
  await page.locator('#cancelScanButton').waitFor({ state: 'visible' });
  await page.locator('#cancelScanButton').click();
  await until(async () => (await request(server, `/api/scan/${canceledJob}`)).finished, 'recovered scan cancels');
  await until(async () => /canceled/i.test(await page.locator('#importStatusSheet').textContent()), 'scan cancellation is explained');
  // Completed imports may be kept by design; clear only this test database.
  await clearInitialLibrary(server);
  await page.reload();
  const job = await openImport(music);
  await finishScan(server, job);
  await until(async () => /imported or updated/.test(await page.locator('#importStatusSheet').textContent()), 'import UI receives completion');
  await page.locator('#importSheetClose').click();
  await page.locator('[data-view="songs"]').click();
  await until(async () => (await page.locator('#trackGrid [data-track-id]').count()) === 3, 'imported songs appear');
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'restored-ui-desktop.png'), fullPage: true });
  const first = page.locator('#trackGrid [data-track-id]').first();
  const firstId = await first.getAttribute('data-track-id');
  await page.locator('#muteBtn').focus();
  await page.locator('#volumeRange').press('Home');
  assert.equal(await page.locator('#audio').evaluate(audio => audio.volume), 0);
  await page.locator('#volumeRange').press('End');
  assert.equal(await page.locator('#audio').evaluate(audio => audio.volume), 1);
  await page.locator('#muteBtn').click();
  assert.equal(await page.locator('#audio').evaluate(audio => audio.muted), true);
  await page.locator('#muteBtn').click();
  assert.equal(await page.locator('#audio').evaluate(audio => audio.muted), false);
  await clickRevealedAction(first, '[data-play-btn]');
  await until(() => page.locator('#audio').evaluate(audio => !audio.paused && audio.currentTime > 0), 'actual audio playback', 30_000);
  await page.locator('#seekRange').press('Home');
  for (let index = 0; index < 8; index++) await page.locator('#seekRange').press('ArrowRight');
  await until(() => page.locator('#audio').evaluate(audio => audio.currentTime >= 7), 'audio seek');
  await page.locator('#playButton').click();
  assert.equal(await page.locator('#audio').evaluate(audio => audio.paused), true);
  await clickRevealedAction(first, '[data-track-details]');
  const details = page.getByRole('dialog').filter({ has: page.locator('[data-refresh]') });
  await details.locator('[data-close]').click();
  await page.locator('#queueButton').click();
  await until(async () => (await page.locator('#queueList [data-queue-index]').count()) === 3, 'queue contains playback scope');
  await clickRevealedAction(page.locator('#queueList [data-queue-drag-index="1"]'), '[data-queue-move="1"][data-direction="-1"]');
  await clickRevealedAction(page.locator('#queueList [data-queue-drag-index="2"]'), '[data-queue-remove="2"]');
  assert.equal(await page.locator('#queueList [data-queue-index]').count(), 2);
  await page.locator('#queueCloseButton').click();
  await clickRevealedAction(first, `[data-track-favorite="${firstId}"]`);
  await until(async () => (await request(server, '/api/state')).favorites.includes(firstId), 'favorite persists');
  await clickRevealedAction(first, `[data-track-playlist="${firstId}"]`);
  await page.locator('#playlistPickerNew').click();
  await until(async () => (await page.locator('[data-picker-playlist]').count()) === 1, 'new playlist created in picker');
  const playlistId = await page.locator('[data-picker-playlist]').getAttribute('data-picker-playlist');
  await page.locator('#playlistPickerDone').click();
  await until(async () => (await request(server, '/api/state')).playlists.find(item => item.id === playlistId)?.trackIds.includes(firstId), 'playlist picker membership persists');
  const secondId = await page.locator('#trackGrid [data-track-id]').nth(1).getAttribute('data-track-id');
  await clickRevealedAction(page.locator(`#trackGrid [data-track-id="${secondId}"]`), `[data-track-playlist="${secondId}"]`);
  await page.locator(`[data-picker-playlist="${playlistId}"]`).check();
  await page.locator('#playlistPickerDone').click();
  await page.locator(`[data-playlist-id="${playlistId}"]`).click();
  await until(async () => (await page.locator('#trackGrid [data-track-id]').count()) === 2, 'playlist opens');
  await clickRevealedAction(page.locator(`#trackGrid [data-track-id="${secondId}"]`), `[data-playlist-move="${secondId}"][data-direction="-1"]`);
  await until(async () => (await request(server, '/api/state')).playlists.find(item => item.id === playlistId)?.trackIds[0] === secondId, 'playlist order persists');
  await page.locator('#settingsButton').click();
  const settings = page.getByRole('dialog', { name: 'Library & Playback' });
  await until(async () => /3/.test(await settings.locator('[data-library-stats]').textContent()), 'library stats display');
  await until(async () => /FFmpeg/.test(await settings.locator('[data-server-health]').textContent()), 'tool diagnostics display');
  assert.match(await settings.locator('[data-import-limits]').textContent(), /1(?:\.0)?\s*MiB/i);
  await until(async () => (await settings.locator('[data-recent-play]').count()) > 0, 'recent playback consumer displays persisted history');
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'feature-desktop.png'), fullPage: true });
  await settings.locator('[data-server-health]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, 'feature-diagnostics.png'), fullPage: true });
  await settings.locator('[data-recent-play]').first().click();
  await settings.waitFor({ state: 'hidden' });
  await until(() => page.locator('#audio').evaluate(audio => !audio.paused), 'recent playback button plays its history queue');
  await page.locator('#settingsButton').click();
  const gainPattern = /\/api\/tracks\/[^/]+$/;
  let releaseGain, delayedGain;
  const gainTags = async route => {
    const response = await route.fetch();
    const data = await response.json();
    if (releaseGain) await delayedGain;
    await route.fulfill({ response, json: { ...data, track: { ...data.track, tags: { replaygain_track_gain: '-6 dB', replaygain_track_peak: '2' } } } });
  };
  await page.route(gainPattern, gainTags);
  await settings.locator('#gainSelect').selectOption('track');
  await until(() => page.evaluate(() => Math.abs(globalThis.__localAmpTestGain?.gain.value - 0.5) < 0.001), 'ReplayGain applies to the current playing track');
  assert.equal(await page.locator('#audio').evaluate(audio => audio.paused), false);
  await settings.locator('#gainSelect').selectOption('off');
  assert.equal(await page.evaluate(() => globalThis.__localAmpTestGain.gain.value), 1);
  delayedGain = new Promise(resolve => { releaseGain = resolve; });
  const gainRequest = page.waitForRequest(request => gainPattern.test(request.url()));
  await settings.locator('#gainSelect').selectOption('track');
  await gainRequest;
  await settings.locator('#gainSelect').selectOption('off');
  const completedGain = page.waitForResponse(response => gainPattern.test(response.url()));
  releaseGain();
  await completedGain;
  await page.evaluate(() => new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => globalThis.__localAmpTestGain.gain.value), 1, 'An earlier ReplayGain response must not override turning it off.');
  await page.unroute(gainPattern, gainTags);
  await settings.locator('[data-close]').click();
  await page.locator('#playButton').click();
  await page.locator('#settingsButton').click();
  await settings.locator('#qualitySelect').selectOption('compatibility');
  await settings.locator('#gainSelect').selectOption('track');
  const downloaded = page.waitForEvent('download');
  await settings.locator('[data-backup]').click();
  const backupFile = path.join(temporary, 'browser-backup.json');
  await (await downloaded).saveAs(backupFile);
  const backup = JSON.parse(await readFile(backupFile, 'utf8'));
  assert.equal(backup.tracks.length, 3);
  await request(server, `/api/playlists/${playlistId}`, 'DELETE');
  await settings.locator('[data-restore]').setInputFiles(backupFile);
  await until(async () => /Restored/.test(await settings.locator('[role="status"]').textContent()), 'backup restore displays completion');
  assert((await request(server, '/api/state')).playlists.some(item => item.id === playlistId));
  const m3uPath = path.join(temporary, 'Browser import.m3u');
  await writeFile(m3uPath, await request(server, `/api/playlists/${playlistId}/m3u`), 'utf8');
  await settings.locator('[data-m3u]').setInputFiles(m3uPath);
  await until(async () => /Imported playlist/.test(await settings.locator('[role="status"]').textContent()), 'M3U import displays completion');
  await settings.locator('[data-diagnostics-refresh]').click();
  await settings.locator('[data-clear-cache]').click();
  await until(async () => /Removed .* cached files/i.test(await settings.locator('[role="status"]').textContent()), 'cache action displays completion');
  const tooLarge = path.join(temporary, 'oversized.json');
  await writeFile(tooLarge, JSON.stringify({ ...backup, padding: 'x'.repeat(1024 * 1024 + 1) }));
  let restoreRequests = 0;
  const countRestore = request => { if (request.url().endsWith('/api/backup/restore')) restoreRequests++; };
  page.on('request', countRestore);
  await settings.locator('[data-restore]').setInputFiles(tooLarge);
  await until(async () => /limit|at most|exceed/i.test(await settings.locator('[role="status"]').textContent()), 'oversize restore is rejected before upload');
  page.off('request', countRestore);
  assert.equal(restoreRequests, 0);
  await settings.locator('[data-close]').click();
  await page.reload();
  await page.locator('#settingsButton').click();
  assert.equal(await page.locator('#qualitySelect').inputValue(), 'compatibility');
  assert.equal(await page.locator('#gainSelect').inputValue(), 'track');
  await page.getByRole('dialog', { name: 'Library & Playback' }).locator('[data-close]').click();
}

async function paginationFeatures(server) {
  const backup = await request(server, '/api/backup');
  const sample = backup.tracks[0], seeded = [];
  const directory = path.join(temporary, 'Paged music');
  await mkdir(directory);
  await scan(server, directory);
  for (let index = 0; index < 153; index++) {
    const file = path.join(directory, `Page ${index.toString().padStart(3, '0')}.wav`);
    await copyFile(sample.path, file);
    seeded.push({ ...sample, id: `browser-page-${index}`, path: file, fileName: path.basename(file), directory,
      title: `Pagination ${index.toString().padStart(3, '0')}`, artist: index % 2 ? 'Artist odd' : 'Artist even',
      album: `Album ${index % 3}`, genre: index % 2 ? 'Jazz' : 'Rock', year: index % 2 ? '2024' : '2025', tags: {},
    });
  }
  await request(server, '/api/backup/restore', 'POST', { ...backup, tracks: seeded, playlists: [], favorites: [], recent: [], sources: [] });
  const first = await request(server, '/api/library/tracks?limit=150&offset=0');
  const second = await request(server, '/api/library/tracks?limit=150&offset=150');
  assert.equal(first.total, 156); assert.equal(first.tracks.length, 150); assert.equal(second.tracks.length, 6);
  assert(!first.tracks.some(track => second.tracks.some(other => other.id === track.id)), 'Pages do not overlap.');
  const lightweight = await request(server, '/api/state?includeTracks=false');
  assert.deepEqual(lightweight.tracks, []);
  assert.equal(lightweight.trackIds.length, 156);
  assert(lightweight.facets.genre.includes('Jazz'));
  const jazz = await request(server, '/api/library/tracks?limit=150&genre=Jazz&sortField=title&sortDir=desc');
  assert.equal(jazz.total, 76);
  assert.equal(jazz.tracks[0].title, 'Pagination 151');
  const identifiers = await request(server, '/api/library/tracks?genre=Jazz&idsOnly=true&sortField=title&sortDir=desc');
  assert.equal(identifiers.trackIds.length, 76);
  assert.equal(identifiers.trackIds[0], jazz.tracks[0].id);
  const lookup = await request(server, '/api/library/tracks/lookup', 'POST', { ids: [second.tracks[0].id, first.tracks[0].id] });
  assert.deepEqual(lookup.tracks.map(track => track.id), [second.tracks[0].id, first.tracks[0].id]);
  const groups = await request(server, '/api/library/tracks?groupBy=album&limit=1&offset=0');
  assert(groups.total >= 3);
  assert.equal(groups.groups.length, 1);
  assert.equal(groups.trackTotal, 156);
  if (apiOnly) return;
  const pageRequests = [];
  page.on('request', request => { if (request.url().includes('/api/library/tracks?')) pageRequests.push(request.url()); });
  await page.reload();
  await page.locator('[data-view="songs"]').click();
  await until(async () => (await page.locator('#trackGrid [data-track-id]').count()) === 150, 'first server-rendered page');
  const firstIds = await page.locator('#trackGrid [data-track-id]').evaluateAll(cards => cards.map(card => card.dataset.trackId));
  await clickRevealedAction(page.locator('#trackGrid [data-track-id]').first(), '[data-play-btn]');
  await until(() => page.locator('#audio').evaluate(audio => !audio.paused), 'paged library playback');
  await page.locator('#queueButton').click();
  await until(async () => (await page.locator('#queueCount').textContent()).startsWith('156 songs'), 'playback queues the entire matching library beyond the current page');
  await until(async () => (await page.locator('#queueList [data-queue-index]').count()) === 100, 'queue metadata resolves outside the library page');
  await page.locator('#queueCloseButton').click();
  await page.locator('#playButton').click();
  await page.locator('[data-grid-page="1"]').click();
  await until(async () => (await page.locator('#trackGrid [data-track-id]').count()) === 6, 'second server-rendered page');
  const secondIds = await page.locator('#trackGrid [data-track-id]').evaluateAll(cards => cards.map(card => card.dataset.trackId));
  assert(!firstIds.some(id => secondIds.includes(id)));
  await page.locator('#searchInput').fill('Pagination 150');
  await until(async () => (await page.locator('#trackGrid [data-track-id]').count()) === 1, 'server search resets page');
  assert.match(await page.locator('#trackGrid').textContent(), /Pagination 150/);
  assert(pageRequests.length >= 3, 'UI must consume the server pagination API.');
  await page.locator('#searchInput').fill('');
  await page.locator('[data-view="songs"]').click();
  await page.locator('#filterToggleButton').click();
  await page.locator('#filterGenre').selectOption('Jazz');
  await until(async () => (await page.locator('#trackGrid [data-track-id]').count()) === 76, 'server filter resets page');
  await page.locator('#clearFiltersButton').click();
  await page.locator('[data-view="albums"]').click();
  await until(async () => (await page.locator('#trackGrid [data-group-type="album"]').count()) >= 3, 'album groups render across all tracks');
  const failPage = route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary test interruption' }) });
  await page.route(/\/api\/library\/tracks\?/, failPage);
  await page.locator('[data-view="songs"]').click();
  await page.locator('[data-library-retry]').waitFor({ state: 'visible' });
  assert.match(await page.locator('#trackGrid').textContent(), /Temporary test interruption/);
  await page.unroute(/\/api\/library\/tracks\?/, failPage);
  await page.locator('[data-library-retry]').click();
  await until(async () => (await page.locator('#trackGrid [data-track-id]').count()) === 150, 'failed library request retries successfully');
  assert(frontendRequests.filter(url => new URL(url).pathname === '/api/state').every(url => new URL(url).searchParams.get('includeTracks') === 'false'), 'UI library refreshes must request only the lightweight state index.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(artifacts, 'restored-ui-mobile.png'), fullPage: true });
  await page.locator('#mobileSettingsButton').click();
  await page.getByRole('dialog', { name: 'Library & Playback' }).waitFor({ state: 'visible' });
  await until(async () => /156/.test(await page.locator('[data-library-stats]').textContent()), 'mobile settings loads library totals');
  await page.screenshot({ path: path.join(artifacts, 'feature-mobile.png'), fullPage: true });
  await page.getByRole('dialog', { name: 'Library & Playback' }).locator('[data-close]').click();
  await page.locator('#mobileImportButton').click();
  await page.locator('#importSheet').waitFor({ state: 'visible' });
  await page.locator('#importSheetClose').click();
  assert(await page.locator('html').evaluate(element => element.scrollWidth <= element.ownerDocument.defaultView.innerWidth + 1), 'Mobile view must not overflow horizontally.');
  await queueMetadataRace(server, first.tracks[0], second.tracks[0]);
  assert.equal(failures.length, 0, `Browser errors:\n${failures.join('\n')}`);
}

async function queueMetadataRace(server, current, target) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const saved = { entries: [
    { id: current.id, key: 'race-current' }, { id: target.id, key: 'race-target' }, { id: current.id, key: 'race-duplicate' },
  ], index: 0, shuffle: false, repeat: 'none', position: 0 };
  // Write after the previous document's pagehide handler persists its queue.
  await page.evaluate(queue => globalThis.sessionStorage.setItem('local-amp-test-queue', JSON.stringify(queue)), saved);
  await page.addInitScript(() => {
    const fixture = globalThis.sessionStorage.getItem('local-amp-test-queue');
    if (fixture) {
      globalThis.sessionStorage.removeItem('local-amp-test-queue');
      globalThis.localStorage.setItem('amp-queue', fixture);
    }
  });
  await page.reload();
  const restoredQueue = await page.evaluate(() => JSON.parse(globalThis.localStorage.getItem('amp-queue')));
  assert.deepEqual(restoredQueue.entries.map(entry => entry.key), saved.entries.map(entry => entry.key));
  await page.locator('[data-view="songs"]').click();
  await until(async () => (await page.locator('#trackGrid [data-track-id]').count()) === 150, 'race fixture first page loads');
  let releaseLookup, lookupObserved = false;
  const pending = new Promise(resolve => { releaseLookup = resolve; });
  const lookupPattern = /\/api\/library\/tracks\/lookup$/;
  const delayLookup = async route => {
    if (route.request().postDataJSON().ids.includes(target.id)) { lookupObserved = true; await pending; }
    await route.continue();
  };
  await page.route(lookupPattern, delayLookup);
  await page.locator('#nextButton').click();
  await until(() => lookupObserved, 'Next requests uncached track metadata', 15_000);
  await page.locator('#trackGrid [data-track-id]').first().click({ button: 'right' });
  const contextId = await page.evaluate(async () => (await import('/modules/context-menu.js')).getCtxTrackId());
  assert.equal(contextId, current.id, 'Context menu must retain its selected track while metadata is pending.');
  await page.locator('[data-ctx="queue"]').click();
  const appended = await page.evaluate(() => JSON.parse(globalThis.localStorage.getItem('amp-queue')));
  assert.equal(appended.entries.length, 4, 'Context menu append must persist immediately while metadata is pending.');
  await page.locator('#queueButton').click();
  await until(async () => (await page.locator('#queueCount').textContent()).startsWith('4 songs'), 'queue append applies during pending metadata');
  await clickRevealedAction(page.locator('#queueList [data-queue-drag-index="2"]'), '[data-queue-move="2"][data-direction="-1"]');
  const edited = await page.evaluate(() => JSON.parse(globalThis.localStorage.getItem('amp-queue')));
  assert.deepEqual(edited.entries.slice(0, 3).map(entry => entry.key), ['race-current', 'race-duplicate', 'race-target']);
  releaseLookup();
  await until(async () => {
    const queue = await page.evaluate(() => JSON.parse(globalThis.localStorage.getItem('amp-queue')));
    return queue.entries[queue.index]?.key === 'race-target' && !await page.locator('#audio').evaluate(audio => audio.paused);
  }, 'Next resumes the requested occurrence after queue edits');
  const resumed = await page.evaluate(() => JSON.parse(globalThis.localStorage.getItem('amp-queue')));
  assert.deepEqual(resumed.entries, edited.entries, 'Playback must retain appended entries and edited occurrence order.');
  assert.equal(resumed.index, 2);
  await page.unroute(lookupPattern, delayLookup);
  await page.locator('#queueCloseButton').click();
  await page.locator('#playButton').click();
  assert.equal((await request(server, '/api/state?includeTracks=false')).trackIds.length, 156);
}

async function degradedDiagnostics(binary) {
  const degraded = await startBackend(binary, 'missing-tools', {
    FFMPEG_PATH: 'local-amp-test-missing-ffmpeg', FFPROBE_PATH: 'local-amp-test-missing-ffprobe',
  });
  const health = await request(degraded, '/api/health', 'GET', undefined, 503);
  assert.equal(health.checks.database, true);
  assert.equal(health.checks.ffmpeg, false);
  assert.equal(health.checks.ffprobe, false);
  assert.equal(health.limits.jsonLimitBytes, 1024 * 1024);
  if (apiOnly) return;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(degraded.base + '/#local-amp=' + degraded.token);
  await page.locator('#settingsButton').click();
  const settings = page.getByRole('dialog', { name: 'Library & Playback' });
  await until(async () => /Server needs attention/.test(await settings.locator('[data-server-health]').textContent()), 'degraded tool health is actionable');
  assert.match(await settings.locator('[data-server-health]').textContent(), /FFmpeg/);
  await until(async () => /1(?:\.0)?\s*MiB/i.test(await settings.locator('[data-import-limits]').textContent()), 'degraded health still advertises actual import limits');
  assert.equal(failures.length, 0, `Browser errors:\n${failures.join('\n')}`);
}

try {
  const binary = await buildBackend();
  const music = path.join(temporary, 'Music with spaces 音楽');
  const cancellation = path.join(temporary, 'Cancel scan');
  await mkdir(music); await mkdir(cancellation);
  for (let index = 0; index < 3; index++) await writeFile(path.join(music, `Tone ${index} 音.wav`), wav(20, 440 + index * 110));
  const smallWav = wav(1);
  for (let index = 0; index < 300; index++) await writeFile(path.join(cancellation, `${index}.wav`), smallWav);
  const server = await startBackend(binary, 'data');
  await embeddedAssets(server);
  assert.equal((await request(server, '/api/state')).tracks.length, 0);
  if (apiOnly) {
    const { jobId } = await request(server, '/api/scan', 'POST', { directory: cancellation }, 202);
    await request(server, `/api/scan/${jobId}/cancel`, 'POST');
    const canceled = await until(async () => { const result = await request(server, `/api/scan/${jobId}`); return result.finished && result; }, 'API scan cancellation');
    assert.equal(canceled.event.phase, 'failed');
    await clearInitialLibrary(server);
    await scan(server, music);
  } else {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.addInitScript(() => {
      const prototype = globalThis.AudioContext.prototype;
      const createGain = prototype.createGain;
      prototype.createGain = function (...args) {
        const node = createGain.apply(this, args);
        globalThis.__localAmpTestGain = node;
        return node;
      };
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on('pageerror', error => failures.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) failures.push(message.text());
    });
    page.on('request', request => frontendRequests.push(request.url()));
    await browserFeatures(server, music, cancellation);
  }
  await apiContracts(server, music);
  const backup = await request(server, '/api/backup');
  const fresh = await startBackend(binary, 'restore');
  for (const source of backup.sources) await scan(fresh, source.path);
  await request(fresh, '/api/backup/restore', 'POST', backup);
  const restored = await request(fresh, '/api/state');
  const restoredBackup = await request(fresh, '/api/backup');
  const pathsForIds = (library, ids) => ids.map(id => library.tracks.find(track => track.id === id)?.path);
  assert.equal(restored.tracks.length, 3);
  // Independent folder scans create new IDs. Restore remaps references to
  // those existing tracks while preserving the corresponding music files.
  assert.deepEqual(pathsForIds(restoredBackup, restored.favorites).sort(), pathsForIds(backup, backup.favorites).sort());
  assert.equal(restored.playlists.length, backup.playlists.length);
  for (const playlist of backup.playlists) {
    assert.deepEqual(pathsForIds(restoredBackup, restored.playlists.find(item => item.id === playlist.id).trackIds), pathsForIds(backup, playlist.trackIds));
  }
  await paginationFeatures(server);
  await degradedDiagnostics(binary);
  console.log(`${apiOnly ? 'API contract' : 'Browser and API contract'} smoke passed: scan recovery/cancel, import, media ranges${apiOnly ? '' : '/playback/seek/queue'}, playlists, backup/M3U, diagnostics/limits, pagination/search/filter.`);
} catch (error) {
  process.exitCode = 1;
  await mkdir(artifacts, { recursive: true });
  await page?.screenshot({ path: path.join(artifacts, 'browser-failure.png'), fullPage: true }).catch(() => {});
  await context?.tracing.stop({ path: path.join(artifacts, 'browser-trace.zip') }).catch(() => {});
  await writeFile(path.join(artifacts, 'backend.log'), servers.map(server => server.log()).join('\n'), 'utf8');
  console.error(error.stack || error);
} finally {
  await browser?.close();
  for (const server of servers.reverse()) {
    await fetch(server.base + '/api/shutdown', { method: 'POST', headers: { 'x-local-amp-token': server.token }, signal: AbortSignal.timeout(3000) }).catch(() => {});
    await until(() => server.child.exitCode !== null || server.child.signalCode !== null, 'isolated server exits', 5000).catch(() => server.child.kill());
  }
  // mkdtemp produced this exact owned directory; never remove caller data.
  assert(path.dirname(temporary) === os.tmpdir() && path.basename(temporary).startsWith('LocalAmpBrowserTest-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
