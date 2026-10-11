'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { MockProvider, PKT } = require('./mock-xtream');
const { createApp } = require('../src/server');
const { parseXmltv } = require('../src/epg');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(base, pathname, { method = 'GET', body, headers = {}, ms = 0, maxBytes = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base);
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(u, { method, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers) }, (res) => {
      const chunks = [];
      let total = 0;
      let done = false;
      const finish = () => { if (done) return; done = true; resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }); };
      res.on('data', (c) => { chunks.push(c); total += c.length; if (total >= maxBytes) { req.destroy(); finish(); } });
      res.on('end', finish);
      res.on('close', finish);
      if (ms) setTimeout(() => { req.destroy(); finish(); }, ms);
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    if (data) req.write(data);
    req.end();
  });
}
const json = (r) => JSON.parse(r.buf.toString('utf8'));

async function boot(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-feat-'));
  const app = createApp({ dataDir: dir, basicAuth: '', relay: { idleMs: 300, vodLingerMs: 400, ...(opts.relay || {}) } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return { app, dir, base: `http://127.0.0.1:${app.server.address().port}` };
}
async function shutdown(ctx, ...providers) {
  ctx.app.close();
  for (const p of providers) await p.close();
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}
const saveProviders = (base, list) => request(base, '/api/providers', { method: 'PUT', body: { providers: list } }).then(json);

describe('programme guide', () => {
  let ctx; let prov;
  before(async () => {
    prov = await new MockProvider({ user: 'u', pass: 'p', max: 2 }).listen();
    ctx = await boot();
    await saveProviders(ctx.base, [{ id: 'a', name: 'A', url: prov.url, username: 'u', password: 'p', maxConnections: 2 }]);
    await request(ctx.base, '/api/channels?provider=a');
  });
  after(() => shutdown(ctx, prov));

  test('live channels carry the provider guide id', async () => {
    const r = json(await request(ctx.base, '/api/channels?provider=a'));
    assert.equal(r.channels[0].e, 'ch1.test');
  });

  test('guide comes from the XMLTV file, entities decoded, descriptions only on request', async () => {
    const r = json(await request(ctx.base, '/api/epg?provider=a&sids=1,2'));
    assert.equal(r.available, true);
    const titles = r.programmes['1'].map((x) => x[2]);
    assert.ok(titles.includes('Now Show 1-1 & Friends'), titles.join('|'));
    assert.equal(r.programmes['1'][0].length, 3);
    const d = json(await request(ctx.base, '/api/epg?provider=a&sids=1&desc=1'));
    assert.equal(d.programmes['1'][0][3], 'About <it>');
    assert.equal(prov.xmltvHits, 1, 'the file is downloaded once and cached');
  });

  test('programme search finds titles across channels', async () => {
    const r = json(await request(ctx.base, '/api/epg-search?provider=a&q=now+show+2'));
    assert.equal(r.available, true);
    assert.ok(r.results.some((x) => x.sid === '2' && /Now Show 2/.test(x.t)));
    assert.deepEqual(json(await request(ctx.base, '/api/epg-search?provider=a&q=zzzznothing')).results, []);
  });

  test('gzip-compressed XMLTV parses too', async () => {
    const out = [];
    const xml = Buffer.from('<tv><programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="x"><title>Gz</title></programme></tv>');
    await parseXmltv([zlib.gzipSync(xml)], (...a) => out.push(a));
    assert.equal(out.length, 1);
    assert.equal(out[0][3], 'Gz');
  });
});

describe('guide fallback to get_short_epg', () => {
  let ctx; let prov;
  before(async () => {
    prov = await new MockProvider({ user: 'u', pass: 'p', max: 2, xmltv: false }).listen();
    ctx = await boot();
    await saveProviders(ctx.base, [{ id: 'a', name: 'A', url: prov.url, username: 'u', password: 'p', maxConnections: 2 }]);
    await request(ctx.base, '/api/channels?provider=a');
  });
  after(() => shutdown(ctx, prov));

  test('without an XMLTV file the per-channel guide is used', async () => {
    const r = json(await request(ctx.base, '/api/epg?provider=a&sids=1'));
    assert.equal(r.available, true);
    assert.equal(r.programmes['1'][0][2], 'Short Now');
  });
});

describe('movies and series', () => {
  let ctx; let prov; let admin; let viewer;
  const cookieOf = (r) => (r.headers['set-cookie'] || [''])[0].split(';')[0];
  before(async () => {
    prov = await new MockProvider({ user: 'u', pass: 'p', max: 1, kbps: 500 }).listen();
    ctx = await boot();
    await saveProviders(ctx.base, [{ id: 'a', name: 'A', url: prov.url, username: 'u', password: 'p', maxConnections: 1 }]);
  });
  after(() => shutdown(ctx, prov));

  test('movie and series lists, with container extensions', async () => {
    const m = json(await request(ctx.base, '/api/vod?provider=a&kind=movie'));
    assert.deepEqual(m.categories.map((c) => c.name), ['Action', 'Comedy']);
    assert.deepEqual(m.items.map((x) => [x.i, x.n, x.x]), [['501', 'Big Movie', 'mp4'], ['502', 'Funny Film', 'mkv']]);
    const s = json(await request(ctx.base, '/api/vod?provider=a&kind=series'));
    assert.equal(s.items[0].n, 'Long Show');
    const info = json(await request(ctx.base, '/api/series?provider=a&id=700'));
    assert.deepEqual(info.seasons.map((x) => [x.season, x.episodes.length]), [[1, 2], [2, 1]]);
    assert.equal(info.seasons[0].episodes[0].minutes, 45);
    assert.equal(info.seasons[1].episodes[0].ext, 'mkv');
    assert.equal((await request(ctx.base, '/api/series?provider=a&id=../x')).status, 400);
  });

  test('range requests are passed through and counted as a provider connection', async () => {
    const full = await request(ctx.base, '/vod/a/movie%3A501.mp4');
    assert.equal(full.status, 200);
    assert.equal(full.buf.length, 100000);
    const part = await request(ctx.base, '/vod/a/movie%3A501.mp4', { headers: { Range: 'bytes=1000-1999' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], 'bytes 1000-1999/100000');
    assert.equal(part.buf.length, 1000);
    assert.equal(part.buf[0], 1000 % 251);
    assert.equal(prov.vodRequests.at(-1).range, 'bytes=1000-1999');
    const ep = await request(ctx.base, '/vod/a/series%3A9001.mp4', { headers: { Range: 'bytes=0-9' } });
    assert.equal(ep.status, 206);
    assert.equal(prov.vodRequests.at(-1).kind, 'series');
    // the slot lingers briefly after the last request (bridging range requests) but can be taken over at once
    assert.equal(ctx.app.relay.activeCount('a'), 1);
    const live = await request(ctx.base, '/stream/a/1.ts?failover=0', { ms: 500 });
    assert.equal(live.status, 200, 'a finished movie does not block live TV');
    await sleep(900);
    assert.equal(ctx.app.relay.activeCount('a'), 0);
  });

  test('a movie that is playing holds the only connection until it ends', async () => {
    const release = ctx.app.relay.acquireVod(ctx.app.config.get('a'), 'movie:1');
    assert.equal(ctx.app.relay.state().streams.some((s) => s.vod), true);
    assert.equal((await request(ctx.base, '/stream/a/1.ts?failover=0', { ms: 400 })).status, 503);
    assert.equal((await request(ctx.base, '/vod/a/movie%3A502.mkv')).status, 503);
    release();
    assert.equal((await request(ctx.base, '/stream/a/1.ts?failover=0', { ms: 400 })).status, 200);
  });

  test('a movie is refused while live TV uses the only connection', async () => {
    const live = request(ctx.base, '/stream/a/1.ts?failover=0', { ms: 1500 });
    await sleep(500);
    const r = await request(ctx.base, '/vod/a/movie%3A501.mp4');
    assert.equal(r.status, 503);
    assert.equal(json(r).error, 'provider_limit');
    await live;
  });

  test('bad names are refused and viewers need the title in a shared multiview', async () => {
    assert.equal((await request(ctx.base, '/vod/a/movie%3A..%2Fx.mp4')).status, 404);
    assert.equal((await request(ctx.base, '/vod/zzz/movie%3A501.mp4')).status, 404);
    await sleep(700);
    const mk = await request(ctx.base, '/api/users', { method: 'POST', body: { username: 'boss', password: 'secret1' } });
    admin = cookieOf(mk);
    await request(ctx.base, '/api/users', { method: 'POST', body: { username: 'guest', password: 'secret2' }, headers: { Cookie: admin } });
    viewer = cookieOf(await request(ctx.base, '/api/login', { method: 'POST', body: { username: 'guest', password: 'secret2' } }));
    assert.equal((await request(ctx.base, '/vod/a/movie%3A501.mp4', { headers: { Cookie: viewer } })).status, 403);
    const v = json(await request(ctx.base, '/api/views', { method: 'POST', headers: { Cookie: admin }, body: { name: 'Movies', layout: '1', tiles: [{ p: 'a', sid: 'movie:501', name: 'Big Movie', vod: 'movie', ext: 'mp4' }] } }));
    assert.equal(v.view.tiles[0].vod, 'movie');
    assert.equal(v.view.tiles[0].ext, 'mp4');
    const ok = await request(ctx.base, '/vod/a/movie%3A501.mp4', { headers: { Cookie: viewer, Range: 'bytes=0-9' } });
    assert.equal(ok.status, 206);
    assert.equal((await request(ctx.base, '/vod/a/movie%3A502.mkv', { headers: { Cookie: viewer } })).status, 403);
    assert.equal((await request(ctx.base, '/api/vod?provider=a&kind=movie', { headers: { Cookie: viewer } })).status, 403);
  });

  test('guide data for viewers is limited to channels in their multiviews', async () => {
    await request(ctx.base, '/api/channels?provider=a', { headers: { Cookie: admin } });
    const r = json(await request(ctx.base, '/api/epg?provider=a&sids=1,2', { headers: { Cookie: viewer } }));
    assert.deepEqual(Object.keys(r.programmes), []);
  });
});

describe('long buffer', () => {
  test('the server accepts a burst request of several minutes (capped at 300 s)', async () => {
    const prov = await new MockProvider({ user: 'u', pass: 'p', max: 2, kbps: 1000 }).listen();
    const ctx = await boot();
    await saveProviders(ctx.base, [{ id: 'a', name: 'A', url: prov.url, username: 'u', password: 'p', maxConnections: 2 }]);
    const r = await request(ctx.base, '/stream/a/1.ts?buf=240', { ms: 800 });
    assert.equal(r.status, 200);
    assert.ok(r.buf.length > 0);
    await shutdown(ctx, prov);
  });
});

describe('capture card provider', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(() => shutdown(ctx));

  test('device names are validated before they can reach a command line', async () => {
    const bad = (src) => request(ctx.base, '/api/providers', { method: 'PUT', body: { providers: [{ name: 'Cap', type: 'local', sources: [src] }] } });
    assert.equal((await bad({ name: 'x', video: '/dev/video0; rm -rf /' })).status, 400);
    assert.equal((await bad({ name: 'x', video: '/dev/video0', audio: 'hw:1,0 -f x' })).status, 400);
    assert.equal((await bad({ name: 'x', video: '/dev/video0', size: '1280x720;' })).status, 400);
    assert.equal((await bad({ name: 'x', video: '../../etc/passwd' })).status, 400);
    assert.equal((await bad({ name: '', video: '/dev/video0' })).status, 400);
  });

  test('a local provider needs no URL or password and lists its sources as channels', async () => {
    const r = await request(ctx.base, '/api/providers', { method: 'PUT', body: { providers: [{ id: 'cap', name: 'Capture', type: 'local', sources: [
      { id: 'hdmi', name: 'HDMI in', video: '/dev/video0', audio: 'hw:1,0', size: '1920x1080', fps: 30, bitrate: 6000 },
      { id: 'test', name: 'Test pattern', video: 'test', audio: 'test' },
    ] }] } });
    assert.equal(r.status, 200);
    const p = json(r).providers[0];
    assert.equal(p.type, 'local');
    assert.equal(p.sources.length, 2);
    assert.equal(p.maxConnections, 2);
    const ch = json(await request(ctx.base, '/api/channels?provider=cap'));
    assert.deepEqual(ch.channels.map((c) => [c.i, c.n]), [['hdmi', 'HDMI in'], ['test', 'Test pattern']]);
    assert.equal(ch.categories[0].name, 'Capture cards');
    const dev = json(await request(ctx.base, '/api/devices'));
    assert.ok(Array.isArray(dev.video) && Array.isArray(dev.audio));
    const t = json(await request(ctx.base, '/api/providers/test', { method: 'POST', body: { provider: { id: 'cap' } } }));
    assert.equal(t.ok, false, 'the sandbox has no /dev/video0');
    assert.match(t.error, /dev\/video0|ffmpeg/);
  });

  const hasFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '';
  test('ffmpeg turns the test pattern into MPEG-TS that the relay serves, shared between viewers', { skip: !/libx264/.test(hasFfmpeg) && 'ffmpeg with libx264 not installed' }, async () => {
    const a = request(ctx.base, '/stream/cap/test.ts', { ms: 5000 });
    await sleep(2500);
    const b = request(ctx.base, '/stream/cap/test.ts', { ms: 1500 });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 200);
    assert.ok(ra.buf.length > 20000, `only ${ra.buf.length} bytes`);
    assert.equal(ra.buf.length % PKT, 0);
    for (let o = 0; o < ra.buf.length; o += PKT) assert.equal(ra.buf[o], 0x47);
    assert.equal(rb.status, 200);
    assert.ok(rb.buf.length > 0);
    const st = json(await request(ctx.base, '/api/state'));
    assert.ok(st.streams.length <= 1, 'one encode serves both viewers');
  });

  test('a missing device fails fast with a readable reason', async () => {
    const r = await request(ctx.base, '/stream/cap/hdmi.ts', { ms: 8000 });
    assert.equal(r.status, 502);
    assert.match(json(r).message, /ffmpeg|device|video0/i);
  });
});

describe('slow-viewer limit and long bursts', () => {
  test('a long burst does not get the viewer dropped while it drains', () => {
    const { Client } = require('../src/relay');
    const res = { destroyed: false, writableLength: 0, written: 0, write(c) { this.written += c.length; this.writableLength += c.length; }, destroy() { this.destroyed = true; }, end() {} };
    const c = new Client(res, 1000);
    c.grace(50000);
    c.send(Buffer.alloc(50000));       // the burst
    c.send(Buffer.alloc(188));         // live data right behind it
    assert.equal(res.destroyed, false);
    const plain = { ...res, destroyed: false, writableLength: 5000, write() {}, destroy() { this.destroyed = true; } };
    new Client(plain, 1000).send(Buffer.alloc(188));
    assert.equal(plain.destroyed, true, 'without the grace a backed-up viewer is still dropped');
  });
});
