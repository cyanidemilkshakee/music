import test from 'node:test';
import assert from 'node:assert/strict';
import { importLimits, backupBody, m3uBody, formatBytes } from '../public/modules/import-payload.js';

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
