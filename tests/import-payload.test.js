import test from 'node:test';
import assert from 'node:assert/strict';
import { importLimits, backupBody, m3uBody, formatBytes, readImportFile, directoryFromFileUri } from '../public/modules/import-payload.js';

const bytes = value => new TextEncoder().encode(value).byteLength;
const limits = jsonLimitBytes => ({ jsonLimitBytes, m3uTextBytes: 2 * 1024 * 1024 });

test('import limits require the actual positive server byte caps', () => {
  assert.deepEqual(importLimits({ limits: limits(1234) }), limits(1234));
  for (const health of [null, {}, { limits: { ...limits(0) } }, { limits: { ...limits(2), m3uTextBytes: -1 } }, { limits: { ...limits(1.5) } }]) {
    assert.throws(() => importLimits(health), /retrieve the server import limits/);
  }
});

test('backup checks the compact serialized UTF-8 payload and accepts the exact limit', () => {
  const text = '\uFEFF{\n  "version": 1,\n  "name": "音楽😀"\n}';
  const serialized = JSON.stringify({ version: 1, name: '音楽😀' });
  assert.equal(backupBody(text, limits(bytes(serialized))), serialized);
  assert.throws(() => backupBody(text, limits(bytes(serialized) - 1)), /Backup request.*server limit/);
  assert.throws(() => backupBody(text, limits(serialized.length)), /server limit/);
});

test('invalid JSON backups fail before a request can be made', () => {
  assert.throws(() => backupBody('{', limits(1024)), /not valid JSON/);
  for (const text of ['null', '[]', '"text"']) assert.throws(() => backupBody(text, limits(1024)), /JSON object/);
});

test('M3U enforces text bytes separately from the escaped request bytes', () => {
  const text = 'C:\\Music\\音楽.mp3\n';
  const body = JSON.stringify({ name: 'My mix', text });
  assert.equal(m3uBody('My mix.m3u8', text, { jsonLimitBytes: bytes(body), m3uTextBytes: bytes(text) }), body);
  assert.throws(() => m3uBody('My mix.m3u8', text, { jsonLimitBytes: bytes(body) - 1, m3uTextBytes: bytes(text) }), /escaped paths.*server limit/);
  assert.throws(() => m3uBody('My mix.m3u8', text, { jsonLimitBytes: bytes(body), m3uTextBytes: bytes(text) - 1 }), /Playlist text.*server limit/);
});

test('M3U names preserve Unicode code points and have a usable fallback', () => {
  const payload = JSON.parse(m3uBody('😀'.repeat(125) + '.m3u', '', limits(4096)));
  assert.equal(Array.from(payload.name).length, 120);
  assert.equal(payload.name, '😀'.repeat(120));
  assert.equal(JSON.parse(m3uBody('.m3u', '', limits(4096))).name, 'Imported playlist');
});

test('byte labels describe the units used by the server', () => {
  assert.equal(formatBytes(9), '9 bytes');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(20 * 1024 ** 2), '20.0 MiB');
  assert.equal(formatBytes(1024 ** 3), '1.0 GiB');
});

test('oversized import files are rejected without reading or parsing them', async () => {
  let reads = 0;
  const file = { size: 2049, text() { reads++; throw new Error('must not read'); } };
  await assert.rejects(readImportFile(file, 2048, 'Backup'), /Backup file.*read limit/);
  assert.equal(reads, 0);
  for (const size of [-1, Infinity, 1.5, undefined]) {
    await assert.rejects(readImportFile({ ...file, size }, 2048, 'Playlist'), /verify the import file size/);
  }
  assert.equal(reads, 0);
});

test('imports at the exact file limit can be read and still undergo encoded checks', async () => {
  const text = 'C:\\Music\\音楽.mp3\n';
  let reads = 0;
  const file = { size: bytes(text), async text() { reads++; return text; } };
  assert.equal(await readImportFile(file, bytes(text), 'Playlist'), text);
  assert.equal(reads, 1);
  assert.throws(() => m3uBody('mix.m3u', text, limits(bytes(text))), /escaped paths.*server limit/);
});

test('folder drops accept local file URIs and reject remote or device paths', () => {
  assert.equal(directoryFromFileUri('file:///C:/Music/My%20songs'), 'C:\\Music\\My songs');
  assert.equal(directoryFromFileUri('file://localhost/C:/Music'), 'C:\\Music');
  assert.equal(directoryFromFileUri('file:///home/me/Music'), '/home/me/Music');
  for (const uri of [undefined, 'https://example.com/music', 'file://server/share/music', 'file:////server/share/music', 'file:///%5C%5Cserver/share/music', 'file:///C:/Music/track.mp3:private', 'file:///C:/Music/%00', 'file:///C:/Music/%ZZ']) {
    assert.equal(directoryFromFileUri(uri), '', String(uri));
  }
});
