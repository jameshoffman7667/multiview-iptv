'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { MockProvider, PKT, packet, pat, pmt } = require('./mock-xtream');
const { findAlignment, TsInfo, findBurstStart } = require('../src/ts');
const { Ring } = require('../src/ring');
const { normName } = require('../src/lists');
const { createApp } = require('../src/server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(base, pathname, { method = 'GET', body, headers = {}, ms = 0, maxBytes = Infinity, pause = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base);
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(u, { method, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers) }, (res) => {
      const chunks = [];
      const times = [];
      let total = 0;
      let closed = false;
      const finish = (extra) => {
        if (closed) return;
        closed = true;
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buf, chunks, times, ...extra });
      };
      if (pause) res.pause();
      res.socket.on('close', () => finish({ closedByServer: true }));
      res.on('data', (c) => { chunks.push(c); times.push(Date.now()); total += c.length; if (total >= maxBytes) { req.destroy(); finish(); } });
      res.on('end', () => finish());
      res.on('close', () => finish({ closedByServer: true }));
      if (ms) setTimeout(() => { req.destroy(); finish({ closedByServer: false }); }, ms);
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    if (data) req.write(data);
    req.end();
  });
}

const json = (r) => JSON.parse(r.buf.toString('utf8'));

function checkPackets(buf) {
  assert.equal(buf.length % PKT, 0, `length ${buf.length} is not a multiple of 188`);
  for (let o = 0; o < buf.length; o += PKT) assert.equal(buf[o], 0x47, `no sync at ${o}`);
}

function seqs(buf) {
  const out = [];
  for (let o = 0; o < buf.length; o += PKT) {
    const pid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2];
    if (pid !== 0x101) continue;
    const start = (buf[o + 3] >> 4) & 2 ? 6 : 4;
    out.push(buf.readUInt32BE(o + start));
  }
  return out;
}

describe('ts helpers', () => {
  test('findAlignment finds the sync run', () => {
    const p = packet(0x101);
    const junk = Buffer.from([1, 2, 3, 4, 5, 6, 7]);
    const buf = Buffer.concat([junk, p, p, p, p, p, p]);
    assert.equal(findAlignment(buf), junk.length);
    assert.equal(findAlignment(Buffer.alloc(2000, 1)), -1);
  });

  test('ring keeps whole packets and wraps', () => {
    const r = new Ring(PKT * 64);
    let n = 0;
    for (let i = 0; i < 200; i++) { r.write(packet(0x101, { payload: Buffer.from([i]) })); n++; }
    assert.equal(r.size, r.cap);
    const t = r.tail(PKT * 10);
    assert.equal(t.length, PKT * 10);
    checkPackets(t);
    assert.equal(t[4], 190); // oldest of the 10 newest packets first
    assert.equal(t[PKT * 9 + 4], 199); // newest last
    assert.equal(r.tail(PKT * 1000).length, r.cap);
  });

  test('PAT/PMT learning and keyframe-aware burst start', () => {
    const parts = [];
    for (let sec = 0; sec < 5; sec++) {
      parts.push(pat(), pmt());
      parts.push(packet(0x101, { pusi: true, rai: true, payload: Buffer.from([sec]) }));
      for (let i = 0; i < 20; i++) parts.push(packet(0x101));
    }
    const buf = Buffer.concat(parts);
    const info = new TsInfo();
    info.feed(buf);
    assert.deepEqual([...info.pmtPids], [0x100]);
    assert.deepEqual([...info.videoPids], [0x101]);
    const perSec = 23;
    // want the last 2.5 "seconds": target lies inside second #2, so start at keyframe 2's PAT
    const targetPkt = Math.floor(buf.length / PKT) - Math.round(2.5 * perSec);
    const start = findBurstStart(buf, targetPkt, info);
    assert.equal(start % perSec, 0, 'starts at a PAT');
    assert.equal(((buf[start * PKT + 1] & 0x1f) << 8) | buf[start * PKT + 2], 0);
    assert.ok(start <= targetPkt);
    assert.ok(targetPkt - start < perSec * 1.01);
  });

  test('normName strips tags and prefixes', () => {
    assert.equal(normName('US| ESPN HD'), 'espn');
    assert.equal(normName('ESPN'), 'espn');
    assert.equal(normName('[US] ESPN FHD (backup)'), 'espn');
    assert.equal(normName('UK: BBC One 4K'), 'bbcone');
    assert.notEqual(normName('ESPN 2'), normName('ESPN'));
  });
});

describe('relay server', () => {
  let p1;
  let p2;
  let app;
  let base;
  let dir;

  before(async () => {
    p1 = await new MockProvider({ user: 'u1', pass: 'secret1', max: 1, kbps: 2000, channels: [
      { id: 1, name: 'US| ESPN HD', cat: '10' },
      { id: 2, name: 'US| CNN FHD', cat: '10' },
      { id: 3, name: 'UK| BBC One', cat: '20' },
      { id: 'drop', name: 'Dropper', cat: '10' },
    ] }).listen();
    p2 = await new MockProvider({ user: 'u2', pass: 'secret2', max: 1, kbps: 2000, channels: [
      { id: 77, name: 'CNN HD', cat: '10' },
    ] }).listen();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-test-'));
    app = createApp({ dataDir: dir, basicAuth: '', relay: { idleMs: 600, stallMs: 4000 } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
  });

  after(async () => {
    app.close();
    await p1.close();
    await p2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('providers: test, save, password masked, password kept on edit', async () => {
    const bad = json(await request(base, '/api/providers/test', { method: 'POST', body: { provider: { name: 'x', url: p1.url, username: 'u1', password: 'wrong' } } }));
    assert.equal(bad.ok, false);
    assert.match(bad.error, /login rejected/);
    const good = json(await request(base, '/api/providers/test', { method: 'POST', body: { provider: { name: 'x', url: `${p1.url}/`, username: 'u1', password: 'secret1' } } }));
    assert.equal(good.ok, true);
    assert.equal(good.maxConnections, 1);
    assert.equal(good.status, 'Active');

    let r = await request(base, '/api/providers', { method: 'PUT', body: { providers: [
      { id: 'p1', name: 'One', url: p1.url, username: 'u1', password: 'secret1', maxConnections: 1 },
      { id: 'p2', name: 'Two', url: p2.url, username: 'u2', password: 'secret2', maxConnections: 1 },
    ] } });
    assert.equal(r.status, 200);
    const listed = json(r).providers;
    assert.equal(listed.length, 2);
    assert.ok(!r.buf.toString().includes('secret'), 'password must never be returned');
    assert.equal(listed[0].hasPassword, true);
    // edit without sending a password: stored one is kept
    r = await request(base, '/api/providers', { method: 'PUT', body: { providers: [
      { id: 'p1', name: 'One', url: p1.url, username: 'u1', maxConnections: 1 },
      { id: 'p2', name: 'Two', url: p2.url, username: 'u2', password: 'secret2', maxConnections: 1 },
    ] } });
    assert.equal(r.status, 200);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8'));
    assert.equal(stored.providers[0].password, 'secret1');
    assert.equal((fs.statSync(path.join(dir, 'providers.json')).mode & 0o077), 0, 'providers.json is private');
    const bad2 = await request(base, '/api/providers', { method: 'PUT', body: { providers: [{ name: 'n', url: 'ftp://x', username: 'u', password: 'p' }] } });
    assert.equal(bad2.status, 400);
  });

  test('channel list is served (gzipped) and cached on disk', async () => {
    const r = await request(base, '/api/channels?provider=p1', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(r.status, 200);
    const body = JSON.parse((r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.buf) : r.buf).toString());
    assert.equal(body.channels.length, 4);
    assert.deepEqual(body.categories.map((c) => c.name), ['US', 'UK']);
    assert.ok(fs.existsSync(path.join(dir, 'cache', 'p1.json')));
    await request(base, '/api/channels?provider=p2');
    assert.equal((await request(base, '/api/channels?provider=nope')).status, 404);
  });

  test('two viewers share ONE provider connection; data is packet aligned; credentials hidden', async () => {
    const before = p1.opened.length;
    const [a, b] = await Promise.all([
      request(base, '/stream/p1/1.ts', { ms: 1800 }),
      sleep(100).then(() => request(base, '/stream/p1/1.ts', { ms: 1500 })),
    ]);
    assert.equal(a.status, 200);
    assert.equal(a.headers['content-type'], 'video/mp2t');
    assert.equal(p1.opened.length - before, 1, 'one upstream connection for two viewers');
    assert.equal(p1.peak, 1);
    checkPackets(a.buf);
    checkPackets(b.buf);
    assert.ok(a.buf.length > 150_000, `viewer A got ${a.buf.length} bytes`);
    const s = seqs(b.buf);
    for (let i = 1; i < s.length; i++) assert.equal(s[i], s[i - 1] + 1, 'no gaps/duplicates for a live viewer');
    assert.ok(!JSON.stringify(a.headers).includes('secret'));
    assert.ok(p1.userAgents.filter(Boolean).every((u) => /VLC/.test(u)), 'provider sees a player-like user agent');
  });

  test('late joiner gets a cushion starting at PAT + keyframe (buf=2)', async () => {
    const live = request(base, '/stream/p1/1.ts', { ms: 3600 });
    await sleep(3000);
    const t0 = Date.now();
    const late = await request(base, '/stream/p1/1.ts?buf=2', { ms: 600 });
    assert.ok(late.times.length > 0 && Date.now() - t0 < 1500);
    // everything that arrives within 250 ms of the first byte is the burst (live data adds <70 KB)
    let burstBytes = 0;
    for (let i = 0; i < late.chunks.length; i++) if (late.times[i] - late.times[0] < 250) burstBytes += late.chunks[i].length;
    const first = late.buf;
    checkPackets(first.subarray(0, Math.floor(first.length / PKT) * PKT));
    // 2000 kbps = 250 KB/s, so 2 s = 500 KB; keyframe alignment may add up to ~1 s more
    assert.ok(burstBytes >= 450_000 && burstBytes <= 850_000, `burst was ${burstBytes} bytes`);
    assert.equal(((first[1] & 0x1f) << 8) | first[2], 0, 'burst starts with a PAT');
    await live;
  });

  test('provider full: 503 when failover is off, other provider used when on, idle slot evicted', async () => {
    // idle timeout is 0.6 s: let the previous test's stream wind down first
    await sleep(900);
    const holder = request(base, '/stream/p1/1.ts', { ms: 3500 });
    await sleep(500);
    const noFail = await request(base, '/stream/p1/3.ts?failover=0');
    assert.equal(noFail.status, 503);
    assert.equal(json(noFail).error, 'provider_limit');
    // CNN exists at provider 2 under another name => served from there
    const before2 = p2.opened.length;
    const viaFail = await request(base, '/stream/p1/2.ts', { ms: 1200 });
    assert.equal(viaFail.status, 200);
    assert.equal(viaFail.headers['x-relay-provider'], 'p2');
    assert.equal(p2.opened.length - before2, 1);
    assert.ok(viaFail.buf.length > 50_000);
    // state endpoint shows usage
    const st = json(await request(base, '/api/state'));
    assert.equal(st.providers.find((x) => x.id === 'p1').active, 1);
    await holder;
    // After the holder leaves, its upstream is idle (not yet timed out). A different channel must evict it at once.
    const t0 = Date.now();
    const sw = await request(base, '/stream/p1/3.ts?failover=0', { ms: 800 });
    assert.equal(sw.status, 200);
    assert.ok(Date.now() - t0 < 1500);
    assert.equal(p1.peak, 1, 'never exceeded the provider limit');
  });

  test('upstream drop: viewer stays connected and data resumes', async () => {
    await sleep(900);
    const before = p1.opened.length;
    const r = await request(base, '/stream/p1/drop.ts?failover=0', { ms: 6000 });
    assert.equal(r.status, 200);
    assert.ok(p1.opened.length - before >= 2, `reconnected (${p1.opened.length - before} connections)`);
    assert.ok(r.buf.length > 600_000, `kept receiving across the drop: ${r.buf.length}`);
    checkPackets(r.buf);
    assert.equal(r.closedByServer === true && r.buf.length < 400_000, false);
  });

  test('bad channels: 404, HTML, empty body fail fast with a clear status', async () => {
    await sleep(900);
    assert.equal((await request(base, '/stream/p1/404.ts?failover=0')).status, 404);
    const h = await request(base, '/stream/p1/html.ts?failover=0');
    assert.equal(h.status, 502);
    assert.match(json(h).message, /playlist|page|MPEG-TS/);
    app.relay.closedAt.clear(); // the grace period for a just-released connection is covered by the 403 test below
    const t0 = Date.now();
    const e = await request(base, '/stream/p1/empty.ts?failover=0');
    assert.equal(e.status, 503);
    assert.ok(Date.now() - t0 < 3000);
    assert.equal((await request(base, '/stream/zzz/1.ts')).status, 404);
  });

  test('provider limit reported as 503 when the PROVIDER refuses (403)', async () => {
    await sleep(900);
    // bypass our own counting by occupying the provider with a direct connection
    const hog = http.get(`${p1.url}/live/u1/secret1/1.ts`);
    await sleep(300);
    const r = await request(base, '/stream/p1/3.ts?failover=0');
    hog.destroy();
    assert.equal(r.status, 503);
    assert.equal(json(r).error, 'provider_limit');
  });

  test('static page and health check', async () => {
    assert.equal((await request(base, '/healthz')).status, 200);
    const idx = await request(base, '/');
    assert.equal(idx.status, 200);
    assert.match(idx.headers['content-type'], /text\/html/);
    assert.equal((await request(base, '/..%2fpackage.json')).status, 403);
    assert.equal((await request(base, '/nope.txt')).status, 404);
  });
});

describe('basic auth', () => {
  test('requires credentials except /healthz', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-auth-'));
    const app = createApp({ dataDir: dir, basicAuth: 'me:pw' });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await request(base, '/api/state')).status, 401);
    assert.equal((await request(base, '/healthz')).status, 200);
    const ok = await request(base, '/api/state', { headers: { Authorization: `Basic ${Buffer.from('me:pw').toString('base64')}` } });
    assert.equal(ok.status, 200);
    const bad = await request(base, '/api/state', { headers: { Authorization: `Basic ${Buffer.from('me:no').toString('base64')}` } });
    assert.equal(bad.status, 401);
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('slow viewers', () => {
  test('a viewer that stops reading is dropped, memory stays bounded', async () => {
    const prov = await new MockProvider({ user: 'u', pass: 'p', max: 2, kbps: 60000 }).listen();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-slow-'));
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ providers: [{ id: 'a', name: 'A', url: prov.url, username: 'u', password: 'p', maxConnections: 2 }] }));
    const app = createApp({ dataDir: dir, basicAuth: '', maxClientQueueMB: 0.2 });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    // a client that never reads (paused socket)
    const slow = http.get(`${base}/stream/a/1.ts`, (res) => res.pause());
    slow.on('error', () => {});
    let viewers = -1;
    for (let i = 0; i < 100 && viewers !== 0; i++) {
      await sleep(100);
      const st = app.relay.state().streams[0];
      viewers = st ? st.viewers : -1;
      if (i < 5 && viewers === -1) continue;
    }
    assert.equal(viewers, 0, 'server dropped the slow viewer');
    // a healthy viewer still gets data from the same upstream
    const ok = await request(base, '/stream/a/1.ts', { ms: 700 });
    assert.ok(ok.buf.length > 100_000);
    slow.destroy();
    app.close();
    await prov.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('accounts and shared multiviews', () => {
  let p1;
  let app;
  let base;
  let dir;
  const cookieOf = (r) => (r.headers['set-cookie'] || [''])[0].split(';')[0];
  const as = (cookie, extra = {}) => ({ headers: { Cookie: cookie, ...extra } });

  before(async () => {
    p1 = await new MockProvider({ user: 'u1', pass: 'pw1', max: 3, kbps: 1000 }).listen();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-acct-'));
    app = createApp({ dataDir: dir, basicAuth: '', relay: { idleMs: 300 } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
  });
  after(async () => {
    app.close();
    await p1.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let admin;
  let viewer;
  let viewer2;

  test('open server: anyone is admin until the first account is created, which logs them in', async () => {
    let r = json(await request(base, '/api/me'));
    assert.equal(r.open, true);
    assert.equal(r.authRequired, false);
    assert.equal(r.admin, true);
    // setup providers while open
    await request(base, '/api/providers', { method: 'PUT', body: { providers: [{ id: 'p1', name: 'One', url: p1.url, username: 'u1', password: 'pw1', maxConnections: 3 }] } });
    const bad = await request(base, '/api/users', { method: 'POST', body: { username: 'boss', password: 'abc' } });
    assert.equal(bad.status, 400);
    const c = await request(base, '/api/users', { method: 'POST', body: { username: 'boss', password: 'hunter22' } });
    assert.equal(c.status, 200);
    admin = cookieOf(c);
    assert.match(c.headers['set-cookie'][0], /HttpOnly/);
    assert.match(c.headers['set-cookie'][0], /SameSite=Lax/);
    r = json(await request(base, '/api/me', as(admin)));
    assert.deepEqual(r.user, { username: 'boss', role: 'admin' });
    // now logins are required
    r = json(await request(base, '/api/me'));
    assert.equal(r.authRequired, true);
    assert.equal(r.user, null);
    assert.equal((await request(base, '/api/providers')).status, 401);
    assert.equal((await request(base, '/stream/p1/1.ts')).status, 401);
    const stored = fs.readFileSync(path.join(dir, 'users.json'), 'utf8');
    assert.ok(!stored.includes('hunter22'), 'passwords are hashed');
    assert.equal(fs.statSync(path.join(dir, 'users.json')).mode & 0o077, 0);
  });

  test('login: wrong password refused, right one works, logout ends the session', async () => {
    let r = await request(base, '/api/login', { method: 'POST', body: { username: 'boss', password: 'nope' } });
    assert.equal(r.status, 401);
    r = await request(base, '/api/login', { method: 'POST', body: { username: 'BOSS', password: 'hunter22' } });
    assert.equal(r.status, 200);
    const c = cookieOf(r);
    assert.equal(json(await request(base, '/api/me', as(c))).user.username, 'boss');
    await request(base, '/api/logout', { method: 'POST', body: {}, ...as(c) });
    assert.equal(json(await request(base, '/api/me', as(c))).user, null);
  });

  test('admin creates viewers; viewers cannot touch admin endpoints or see provider data', async () => {
    let r = await request(base, '/api/users', { method: 'POST', body: { username: 'alice', password: 'alicepw1', role: 'viewer', maxStreams: 2 }, ...as(admin) });
    assert.equal(r.status, 200);
    await request(base, '/api/users', { method: 'POST', body: { username: 'bob', password: 'bobpw123', role: 'viewer' }, ...as(admin) });
    assert.equal((await request(base, '/api/users', { method: 'POST', body: { username: 'ALICE', password: 'whatever1' }, ...as(admin) })).status, 409);
    viewer = cookieOf(await request(base, '/api/login', { method: 'POST', body: { username: 'alice', password: 'alicepw1' } }));
    viewer2 = cookieOf(await request(base, '/api/login', { method: 'POST', body: { username: 'bob', password: 'bobpw123' } }));
    for (const [m, p, b] of [['GET', '/api/providers'], ['GET', '/api/state'], ['GET', '/api/users'], ['GET', '/api/channels?provider=p1'],
      ['PUT', '/api/providers', { providers: [] }], ['POST', '/api/views', { name: 'x', layout: '1', tiles: [] }], ['POST', '/api/users', { username: 'x', password: 'secret12' }]]) {
      const x = await request(base, p, { method: m, body: b, ...as(viewer) });
      assert.equal(x.status, 403, `${m} ${p}`);
    }
    assert.ok(!(await request(base, '/api/users', as(admin))).buf.toString().match(/hash|salt/), 'no hashes returned');
  });

  let viewId;
  test('admin publishes a multiview; viewers see only the ones shared with them', async () => {
    const tiles = [{ p: 'p1', sid: '1', name: 'ESPN' }, { p: 'p1', sid: '2', name: 'CNN' }, null];
    let r = await request(base, '/api/views', { method: 'POST', body: { name: 'Game day', layout: '2x2', tiles }, ...as(admin) });
    assert.equal(r.status, 200);
    viewId = json(r).view.id;
    assert.equal(json(r).view.tiles.length, 9);
    const r2 = await request(base, '/api/views', { method: 'POST', body: { name: 'Alice only', layout: '1', tiles: [{ p: 'p1', sid: '3', name: 'BBC' }], users: ['alice'] }, ...as(admin) });
    assert.equal(r2.status, 200);
    assert.equal((await request(base, '/api/views', { method: 'POST', body: { name: 'x', layout: 'bogus', tiles: [] }, ...as(admin) })).status, 400);
    const a = json(await request(base, '/api/views', as(viewer))).views.map((v) => v.name);
    const b = json(await request(base, '/api/views', as(viewer2))).views.map((v) => v.name);
    const ad = json(await request(base, '/api/views', as(admin))).views.map((v) => v.name);
    assert.deepEqual(a, ['Game day', 'Alice only']);
    assert.deepEqual(b, ['Game day']);
    assert.deepEqual(ad, ['Game day', 'Alice only']);
    assert.equal(json(await request(base, '/api/views', as(viewer))).views[0].users, undefined, 'viewers do not see access lists');
  });

  test('viewers can stream only channels in views shared with them, and share provider connections', async () => {
    assert.equal((await request(base, '/stream/p1/2.ts?buf=0', { ...as(viewer), ms: 300, maxBytes: 2000 })).status, 200);
    assert.equal((await request(base, '/stream/p1/3.ts?buf=0', { ...as(viewer), ms: 300, maxBytes: 2000 })).status, 200);
    const denied = await request(base, '/stream/p1/3.ts?buf=0', as(viewer2));
    assert.equal(denied.status, 403);
    assert.equal(json(denied).error, 'not_allowed');
    assert.equal((await request(base, '/stream/p1/1.ts?buf=0', { ...as(admin), ms: 300, maxBytes: 2000 })).status, 200);
    // both viewers on the same channel use one provider connection
    await sleep(600);
    p1.peak = p1.active;
    const [x, y] = await Promise.all([
      request(base, '/stream/p1/1.ts?buf=0', { ...as(viewer), ms: 700 }),
      request(base, '/stream/p1/1.ts?buf=0', { ...as(viewer2), ms: 700 }),
    ]);
    assert.equal(x.status, 200);
    assert.equal(y.status, 200);
    assert.equal(p1.peak, 1, `peak provider connections ${p1.peak}`);
  });

  test('per-account stream cap', async () => {
    // alice may have 2 streams at once
    const a = request(base, '/stream/p1/1.ts?buf=0', { ...as(viewer), ms: 900 });
    const b = request(base, '/stream/p1/2.ts?buf=0', { ...as(viewer), ms: 900 });
    await sleep(300);
    const c = await request(base, '/stream/p1/3.ts?buf=0', as(viewer));
    assert.equal(c.status, 429);
    assert.equal(json(c).error, 'user_limit');
    assert.equal((await a).status, 200);
    assert.equal((await b).status, 200);
  });

  test('updating a multiview bumps rev; removing a provider clears its tiles', async () => {
    let r = await request(base, `/api/views/${viewId}`, { method: 'PUT', body: { name: 'Game day 2', tiles: [{ p: 'p1', sid: '2', name: 'CNN' }] }, ...as(admin) });
    assert.equal(json(r).view.rev, 2);
    assert.equal(json(r).view.layout, '2x2', 'unspecified fields are kept');
    r = json(await request(base, '/api/views', as(viewer2))).views[0];
    assert.equal(r.name, 'Game day 2');
    assert.equal(r.tiles[1], null);
  });

  test('disabling or deleting a user ends their sessions and streams; last admin is protected', async () => {
    const live = request(base, '/stream/p1/2.ts?buf=0', { ...as(viewer2), ms: 3000 });
    await sleep(300);
    const t0 = Date.now();
    let r = await request(base, '/api/users/bob', { method: 'PUT', body: { disabled: true }, ...as(admin) });
    assert.equal(r.status, 200);
    const done = await live;
    assert.ok(Date.now() - t0 < 2000, 'stream was cut off');
    assert.ok(done.closedByServer);
    assert.equal(json(await request(base, '/api/me', as(viewer2))).user, null);
    assert.equal((await request(base, '/api/login', { method: 'POST', body: { username: 'bob', password: 'bobpw123' } })).status, 401);
    assert.equal((await request(base, '/api/users/boss', { method: 'DELETE', ...as(admin) })).status, 400);
    assert.equal((await request(base, '/api/users/boss', { method: 'PUT', body: { role: 'viewer' }, ...as(admin) })).status, 400);
    r = await request(base, '/api/users/alice', { method: 'PUT', body: { password: 'newpass99' }, ...as(admin) });
    assert.equal(r.status, 200);
    assert.equal(json(await request(base, '/api/me', as(viewer))).user, null, 'password change logs the user out');
    assert.equal((await request(base, '/api/users/bob', { method: 'DELETE', ...as(admin) })).status, 200);
  });

  test('cross-site writes and non-JSON writes are refused; too many bad logins are throttled', async () => {
    let r = await request(base, '/api/views', { method: 'POST', body: { name: 'evil', layout: '1', tiles: [] }, headers: { Cookie: admin, Origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    r = await request(base, '/api/views', { method: 'POST', body: { name: 'evil', layout: '1', tiles: [] }, headers: { Cookie: admin, 'Content-Type': 'text/plain' } });
    assert.equal(r.status, 415);
    let last;
    for (let i = 0; i < 9; i++) last = await request(base, '/api/login', { method: 'POST', body: { username: 'boss', password: 'wrong' + i } });
    assert.equal(last.status, 429);
    const ok = await request(base, '/api/login', { method: 'POST', body: { username: 'boss', password: 'hunter22' } });
    assert.equal(ok.status, 429, 'locked out for a few minutes even with the right password');
  });

  test('sessions survive a restart; ADMIN_USER bootstraps an account', async () => {
    app.users.flush();
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-boot-'));
    const a1 = createApp({ dataDir: d2, basicAuth: '', adminUser: 'root', adminPassword: 'rootpass1' });
    await new Promise((r) => a1.server.listen(0, '127.0.0.1', r));
    const b1 = `http://127.0.0.1:${a1.server.address().port}`;
    const c = cookieOf(await request(b1, '/api/login', { method: 'POST', body: { username: 'root', password: 'rootpass1' } }));
    a1.close();
    const a2 = createApp({ dataDir: d2, basicAuth: '' });
    await new Promise((r) => a2.server.listen(0, '127.0.0.1', r));
    const b2 = `http://127.0.0.1:${a2.server.address().port}`;
    assert.equal(json(await request(b2, '/api/me', { headers: { Cookie: c } })).user.username, 'root');
    a2.close();
    fs.rmSync(d2, { recursive: true, force: true });
  });
});

describe('websocket streams', () => {
  const net = require('node:net');
  const crypto = require('node:crypto');
  let p1;
  let app;
  let port;
  let dir;

  before(async () => {
    p1 = await new MockProvider({ user: 'u1', pass: 'pw1', max: 3, kbps: 1000 }).listen();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-ws-'));
    app = createApp({ dataDir: dir, basicAuth: '', relay: { idleMs: 300 } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    port = app.server.address().port;
    app.config.replace([{ id: 'p1', name: 'One', url: p1.url, username: 'u1', password: 'pw1', maxConnections: 3 }]);
  });
  after(async () => {
    app.close();
    await p1.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // tiny WebSocket client: resolves with { status, frames: [{op, payload}], closeCode, closeReason }
  function wsGet(pathname, { headers = {}, ms = 800, maxFrames = Infinity } = {}) {
    return new Promise((resolve) => {
      const key = crypto.randomBytes(16).toString('base64');
      const sock = net.connect(port, '127.0.0.1');
      const h = Object.assign({ Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', Origin: `http://127.0.0.1:${port}` }, headers);
      sock.write(`GET ${pathname} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      let buf = Buffer.alloc(0);
      let status = 0;
      let accept = '';
      let body = Buffer.alloc(0);
      const frames = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        sock.destroy();
        const close = frames.find((f) => f.op === 8);
        resolve({ status, accept, key, frames, closeCode: close && close.payload.length >= 2 ? close.payload.readUInt16BE(0) : null, closeReason: close ? close.payload.subarray(2).toString() : '' });
      };
      setTimeout(finish, ms);
      sock.on('close', finish);
      sock.on('error', finish);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!status) {
          const i = buf.indexOf('\r\n\r\n');
          if (i < 0) return;
          const head = buf.subarray(0, i).toString();
          status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)[1]);
          accept = (/sec-websocket-accept: (.+)/i.exec(head) || [])[1] || '';
          buf = buf.subarray(i + 4);
        }
        for (;;) {
          if (buf.length < 2) break;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) break; len = buf.readUInt32BE(6); off = 10; }
          if (buf.length < off + len) break;
          frames.push({ op: buf[0] & 0x0f, payload: Buffer.from(buf.subarray(off, off + len)) });
          buf = buf.subarray(off + len);
          if (frames.length >= maxFrames) return finish();
        }
      });
    });
  }

  test('handshake is correct and frames are whole 188-byte TS packets', async () => {
    const r = await wsGet('/ws/stream/p1/1.ts?buf=0', { ms: 900 });
    assert.equal(r.status, 101);
    assert.equal(r.accept, crypto.createHash('sha1').update(r.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'));
    const bin = r.frames.filter((f) => f.op === 2);
    assert.ok(bin.length >= 3, `got ${bin.length} binary frames`);
    checkPackets(Buffer.concat(bin.map((f) => f.payload)));
  });

  test('websocket and http viewers share one provider connection; 9 sockets are fine', async () => {
    await sleep(500);
    p1.peak = p1.active;
    const [a, b] = await Promise.all([wsGet('/ws/stream/p1/2.ts?buf=0', { ms: 1200 }), request(`http://127.0.0.1:${port}`, '/stream/p1/2.ts?buf=0', { ms: 1200 })]);
    assert.equal(a.status, 101);
    assert.equal(b.status, 200);
    assert.equal(p1.peak, 1, `provider saw ${p1.peak} connections`);
    const many = await Promise.all(Array.from({ length: 9 }, () => wsGet('/ws/stream/p1/3.ts?buf=0', { ms: 1200 })));
    assert.ok(many.every((m) => m.status === 101 && m.frames.some((f) => f.op === 2)), 'all nine sockets got video');
  });

  test('unknown channels and the provider limit are reported through the stream-error endpoint', async () => {
    const r = await wsGet('/ws/stream/p1/404.ts', { ms: 1500 });
    assert.equal(r.status, 101);
    assert.equal(r.closeCode, 1011);
    const e = json(await request(`http://127.0.0.1:${port}`, '/api/stream-error?p=p1&sid=404'));
    assert.ok(e.error, 'reason recorded');
    assert.deepEqual(json(await request(`http://127.0.0.1:${port}`, '/api/stream-error?p=p1&sid=404')), {}, 'read once');
  });

  test('foreign origins, non-websocket requests and bad paths are refused', async () => {
    assert.equal((await wsGet('/ws/stream/p1/1.ts', { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await wsGet('/ws/other')).status, 404);
    const r = await request(`http://127.0.0.1:${port}`, '/ws/stream/p1/1.ts');
    assert.ok(r.status === 400 || r.status === 404 || r.status === 200 || r.status === 426 || r.status === 405 || r.status === 403 || r.status === 401);
  });

  test('with logins: no cookie is refused, viewers only get channels shared with them', async () => {
    app.users.create({ username: 'boss', password: 'hunter22', role: 'admin' });
    app.users.create({ username: 'vi', password: 'viewer22', role: 'viewer' });
    app.views.create({ name: 'V', layout: '1', tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }] });
    const login = async (u, p) => (await request(`http://127.0.0.1:${port}`, '/api/login', { method: 'POST', body: { username: u, password: p } })).headers['set-cookie'][0].split(';')[0];
    const boss = await login('boss', 'hunter22');
    const vi = await login('vi', 'viewer22');
    assert.equal((await wsGet('/ws/stream/p1/1.ts')).status, 401);
    const ok = await wsGet('/ws/stream/p1/1.ts?buf=0', { headers: { Cookie: vi }, ms: 800 });
    assert.equal(ok.status, 101);
    assert.ok(ok.frames.some((f) => f.op === 2));
    const no = await wsGet('/ws/stream/p1/2.ts?buf=0', { headers: { Cookie: vi }, ms: 800 });
    assert.equal(no.status, 101);
    assert.equal(no.closeCode, 1011);
    assert.equal(no.closeReason, 'not_allowed');
    const why = json(await request(`http://127.0.0.1:${port}`, '/api/stream-error?p=p1&sid=2', { headers: { Cookie: vi } }));
    assert.equal(why.error, 'not_allowed');
    const adm = await wsGet('/ws/stream/p1/2.ts?buf=0', { headers: { Cookie: boss }, ms: 800 });
    assert.ok(adm.frames.some((f) => f.op === 2), 'admins can play any channel');
  });
});
