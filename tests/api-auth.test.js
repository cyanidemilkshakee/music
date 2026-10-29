import assert from 'node:assert/strict';
import { test } from 'node:test';

async function fixture(overrides, run) {
  const names = ['location', 'history', 'sessionStorage', 'fetch', 'EventSource'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: overrides[name] });
    const module = await import(`../public/modules/api.js?auth-test=${Math.random()}`);
    await run(module);
  } finally {
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test('launcher credential is stripped from the address and authenticates reads', async () => {
  const token = 'a'.repeat(64);
  const stored = new Map();
  let replacement;
  let request;
  await fixture({
    location: { hash: `#local-amp=${token}`, pathname: '/', search: '?view=songs' },
    history: { replaceState(...args) { replacement = args[2]; } },
    sessionStorage: { setItem(key, value) { stored.set(key, value); }, getItem(key) { return stored.get(key); } },
    fetch: async (path, options) => { request = { path, options }; return Response.json({ tracks: [] }); }
  }, async ({ api }) => {
    assert.deepEqual(await api('/api/state'), { tracks: [] });
    assert.equal(replacement, '/?view=songs');
    assert.equal(stored.get('local-amp-access'), token);
    assert.equal(request.path, '/api/state');
    assert.equal(request.options.headers.get('x-local-amp-token'), token);
  });
});

test('an unauthorized browser cannot obtain a token through anonymous API requests', async () => {
  let calls = 0;
  await fixture({ fetch: async () => { calls++; return Response.json({}); } }, async ({ api }) => {
    await assert.rejects(api('/api/state'), error => error.status === 403 && /launcher/.test(error.message));
    assert.equal(calls, 0);
  });
});

test('authorization failures are reported without requesting a replacement secret', async () => {
  const calls = [];
  await fixture({
    sessionStorage: { getItem() { return 'b'.repeat(64); } },
    fetch: async path => { calls.push(path); return Response.json({ error: 'Open the launcher.' }, { status: 403 }); }
  }, async ({ api }) => {
    await assert.rejects(api('/api/state'), error => error.status === 403);
    assert.deepEqual(calls, ['/api/state']);
  });
});

test('scan event streams use a narrowly scoped resource grant', async () => {
  let issued;
  let stream;
  await fixture({
    sessionStorage: { getItem() { return 'c'.repeat(64); } },
    fetch: async (path, options) => {
      issued = { path, options };
      return Response.json({ urls: ['/api/scan/job/stream?access=scoped-grant'] });
    },
    EventSource: class { constructor(url) { stream = url; } }
  }, async ({ apiStream }) => {
    await apiStream('/api/scan/job/stream');
    assert.equal(issued.path, '/api/access');
    assert.equal(issued.options.headers.get('x-local-amp-token'), 'c'.repeat(64));
    assert.deepEqual(JSON.parse(issued.options.body), { paths: ['/api/scan/job/stream'] });
    assert.equal(stream, '/api/scan/job/stream?access=scoped-grant');
    assert(!stream.includes('c'.repeat(64)));
  });
});
