const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startBackgroundJob } = require('../dist/services/background-job');
const hub = require('../dist/services/hub');
const { createClient } = require('@supabase/supabase-js');
const { reconcilePendingRequests } = require('../dist/services/auto-fulfill');
const vm = require('node:vm');
const fs = require('node:fs');

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
class Clock {
  now = 0; nextId = 0; timers = new Map();
  setTimeout = (callback, ms) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + ms, callback });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async advance(ms) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at; this.timers.delete(next[0]);
      next[1].callback(); await flush();
    }
    this.now = end; await flush();
  }
}

test('slow work never overlaps, even if it ignores its aborted deadline', async () => {
  const clock = new Clock(); let calls = 0; let release; let signal;
  const stop = startBackgroundJob({ name: 'test', clock, immediate: true,
    intervalMs: 60, timeoutMs: 15, report() {},
    run: async (s) => { calls++; signal = s; await new Promise(r => release = r); } });
  await clock.advance(0); await clock.advance(1000);
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
  release(); await flush(); await clock.advance(59); assert.equal(calls, 1);
  await clock.advance(1); assert.equal(calls, 2); stop(); release(); await flush();
});

test('outage delays grow to cap and reset after recovery', async () => {
  const clock = new Clock(); const calls = []; let fail = true; const logs = [];
  const stop = startBackgroundJob({ name: 'test', clock, immediate: true,
    intervalMs: 60, timeoutMs: 15, maxBackoffMs: 240, report: m => logs.push(m),
    run: async () => { calls.push(clock.now); if (fail) throw new Error('offline'); } });
  await clock.advance(0); await clock.advance(60); await clock.advance(120);
  await clock.advance(240); await clock.advance(240);
  assert.deepEqual(calls, [0, 60, 180, 420, 660]);
  fail = false; await clock.advance(240); await clock.advance(60);
  assert.deepEqual(calls.slice(-2), [900, 960]);
  assert.ok(logs.some(x => x.includes('recovered'))); stop();
});

test('stop aborts active work and prevents subsequent runs', async () => {
  const clock = new Clock(); let calls = 0; let aborted = false;
  const stop = startBackgroundJob({ name: 'test', clock, immediate: true, report() {},
    run: signal => { calls++; return new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); })); } });
  await clock.advance(0); stop(); await flush(); await clock.advance(1000000);
  assert.equal(aborted, true); assert.equal(calls, 1); assert.equal(clock.timers.size, 0);
});

function fakeClient(fetch) {
  return createClient('https://example.invalid', 'test-public-key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch },
  });
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

test('empty pending queue stops before catalog lookup', async () => {
  const urls = []; hub.hubClient = () => fakeClient(async url => { urls.push(String(url)); return json([]); });
  assert.deepEqual(await reconcilePendingRequests('server', new AbortController().signal), { checked: 0, fulfilled: 0 });
  assert.equal(urls.length, 1); assert.ok(urls[0].includes('status=eq.pending'));
});

test('background error enters backoff while manual error keeps its existing result', async () => {
  hub.hubClient = () => fakeClient(async () => json({ message: 'offline', code: 'TEST' }, 500));
  await assert.rejects(reconcilePendingRequests('server', new AbortController().signal), /offline/);
  assert.deepEqual(await reconcilePendingRequests('server'), { checked: 0, fulfilled: 0 });
});

test('deadline aborts Supabase fetch, without retries or concurrent runs', async () => {
  const clock = new Clock(); let active = 0; let maximum = 0; let calls = 0;
  hub.hubClient = () => fakeClient((url, options) => new Promise((resolve, reject) => {
    calls++; active++; maximum = Math.max(maximum, active);
    options.signal.addEventListener('abort', () => { active--; reject(new DOMException('aborted', 'AbortError')); });
  }));
  const stop = startBackgroundJob({ name: 'reconcile-test', clock, immediate: true,
    intervalMs: 60, timeoutMs: 15, report() {}, run: async signal => { await reconcilePendingRequests('server', signal); } });
  await clock.advance(0); assert.equal(active, 1); await clock.advance(15);
  assert.equal(active, 0); assert.equal(calls, 1);
  await clock.advance(60); assert.equal(calls, 2); assert.equal(maximum, 1);
  stop(); await flush();
});

test('successful reconciliation preserves match and conditional fulfillment', async () => {
  const requests = [];
  hub.hubClient = () => fakeClient(async (url, options) => {
    requests.push({ url: String(url), method: options.method, body: options.body });
    if (options.method === 'PATCH') return json([{ id: 'request' }]);
    if (String(url).includes('library_server_books')) return json([{ book_id: 'book', books: { id: 'book', title: 'Fixture', authors: [], isbn_13: '123' } }]);
    return json([{ id: 'request', title: 'Fixture', authors: [], isbn_13: '123' }]);
  });
  assert.deepEqual(await reconcilePendingRequests('server', new AbortController().signal), { checked: 1, fulfilled: 1 });
  const update = requests.find(x => x.method === 'PATCH');
  assert.ok(update.url.includes('status=eq.pending'));
  assert.equal(JSON.parse(update.body).fulfilled_book_id, 'book');
});

test('heartbeat preserves target and auth retry, and propagates deadline failure', async () => {
  const scheduler = require('../dist/services/background-job');
  const identity = require('../dist/services/server-identity');
  const originalStart = scheduler.startBackgroundJob;
  const originalIdentity = identity.loadIdentity;
  let run; let starts = 0; let initCalls = 0; let fetchCalls = 0;
  const urls = [];
  scheduler.startBackgroundJob = options => { starts++; run = options.run; return () => {}; };
  identity.loadIdentity = () => ({ serverId: 'server-fixture' });
  hub.resetHubClient = () => {};
  hub.initHubClient = async () => { initCalls++; };
  hub.hubClient = () => fakeClient(async (url, options) => {
    urls.push(String(url)); fetchCalls++;
    if (fetchCalls === 1) return json({ message: 'JWT expired' }, 401);
    return new Response(null, { status: 204 });
  });
  const heartbeat = require('../dist/services/heartbeat');
  try {
    heartbeat.startHeartbeat(); heartbeat.startHeartbeat();
    assert.equal(starts, 1);
    await run(new AbortController().signal);
    assert.equal(initCalls, 1); assert.equal(fetchCalls, 2);
    assert.ok(urls.every(url => url.includes('id=eq.server-fixture')));
    hub.hubClient = () => fakeClient(async (url, options) => {
      options.signal.throwIfAborted();
      throw new DOMException('aborted', 'AbortError');
    });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(run(controller.signal), /aborted/i);
    assert.equal(initCalls, 1);
  } finally {
    heartbeat.stopHeartbeat(); scheduler.startBackgroundJob = originalStart;
    identity.loadIdentity = originalIdentity;
  }
});

test('deployment skip flag suppresses only the boot scan and retains background startup', async () => {
  for (const skip of ['1', undefined]) {
    let scans = 0; let heartbeats = 0; let jobs = 0;
    const app = { set() {}, use() {}, listen(port, callback) { callback(); } };
    const stubs = {
      dotenv: { config() {} }, express: Object.assign(() => app, { json() {}, urlencoded() {} }),
      cors: () => {}, helmet: () => {}, morgan: () => {}, 'express-rate-limit': () => {},
      './routes': {}, './routes/join': {}, './middleware': {},
      './services/server-identity': { loadIdentity: () => ({ serverId: 'server' }) },
      './services/scan-on-startup': { runScanForOwner: async () => { scans++; } },
      './services/heartbeat': { startHeartbeat: () => { heartbeats++; } },
      './services/identity-check': { verifyIdentityOrUnpair: async () => true },
      './services/hub': { isHubMode: () => true, hubConfigured: () => true, initHubClient: async () => {} },
      './services/auto-fulfill': {},
      './services/background-job': { startBackgroundJob: () => { jobs++; } },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../dist/index'), 'utf8'), {
      require: name => { assert.ok(name in stubs, name); return stubs[name]; },
      exports: {}, process: { env: { TOME_SKIP_STARTUP_SCAN: skip } },
      console: { log() {}, error() {} },
    });
    await flush();
    assert.equal(scans, skip === '1' ? 0 : 1);
    assert.equal(heartbeats, 1); assert.equal(jobs, 1);
  }
});
