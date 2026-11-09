'use strict';
// Diagnostics (P-28): per-channel relay numbers, viewer queues, server health, the speed block, admin only, no addresses.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MockProvider } = require('./mock-xtream');
const { createApp } = require('../src/server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function get(base, p, { headers = {}, ms = 0, pause = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(p, base), { headers }, (res) => {
      const parts = [];
      let n = 0;
      if (pause) res.pause();
      res.on('data', (c) => { parts.push(c); n += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(parts), n, headers: res.headers }));
      res.on('close', () => resolve({ status: res.statusCode, buf: Buffer.concat(parts), n, headers: res.headers }));
      if (ms) setTimeout(() => { req.destroy(); resolve({ status: res.statusCode, buf: Buffer.concat(parts), n, headers: res.headers }); }, ms);
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}
function send(base, p, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request(new URL(p, base), { method, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(parts), headers: res.headers }));
    });
    req.on('error', reject); req.end(data);
  });
}
const json = (r) => JSON.parse(r.buf.toString('utf8'));

describe('diagnostics', () => {
  let prov; let app; let base; let dir; let admin; let viewer;
  before(async () => {
    prov = await new MockProvider({ user: 'u1', pass: 'pw1', max: 2, kbps: 2000, channels: [{ id: 1, name: 'US| ESPN HD', cat: '10' }] }).listen();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-diag-'));
    app = createApp({ dataDir: dir, basicAuth: '', relay: { idleMs: 600, stallMs: 4000 } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    await send(base, '/api/providers', 'PUT', { providers: [{ id: 'p1', name: 'One', url: prov.url, username: 'u1', password: 'pw1', maxConnections: 2 }] });
    const c = await send(base, '/api/users', 'POST', { username: 'boss', password: 'hunter22' });
    admin = c.headers['set-cookie'][0].split(';')[0];
    await send(base, '/api/users', 'POST', { username: 'guest', password: 'secret22' }, { Cookie: admin });
    const v = await send(base, '/api/login', 'POST', { username: 'guest', password: 'secret22' });
    viewer = v.headers['set-cookie'][0].split(';')[0];
  });
  after(async () => { app.close(); await prov.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('admin only: viewers get 403, anonymous 401', async () => {
    for (const p of ['/api/diag', '/api/diag/speed?mb=1']) {
      assert.equal((await get(base, p, { headers: { Cookie: viewer } })).status, 403, p);
      assert.equal((await get(base, p)).status, 401, p);
    }
  });

  test('a running channel shows upstream bitrate, connect and first-byte times, viewers and queue; no provider address anywhere', async () => {
    const watch = get(base, '/stream/p1/1.ts?buf=0', { headers: { Cookie: admin }, ms: 2500 });
    await sleep(1800);
    const r = await get(base, '/api/diag', { headers: { Cookie: admin } });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.buf.toString());
    assert.equal(j.streams.length, 1);
    const s = j.streams[0];
    assert.equal(s.provider, 'One');
    assert.match(s.name, /ESPN/);
    assert.equal(s.state, 'live');
    assert.ok(s.kbps > 500, 'upstream kbps ' + s.kbps);
    assert.ok(s.connectMs >= 0 && s.firstByteMs >= 0 && s.firstByteMs < 3000);
    assert.equal(s.viewerCount, 1);
    assert.equal(s.viewers.length, 1);
    assert.ok(s.viewers[0].kbpsSent > 100 && s.viewers[0].backups === 0 && s.viewers[0].peakKB >= 0);
    assert.ok(s.reconnects === 0 && Array.isArray(s.errors));
    assert.ok(typeof s.maxGapMs === 'number');
    const text = r.buf.toString();
    assert.equal(text.includes(prov.url), false, 'no provider address');
    assert.equal(text.includes('pw1'), false);
    assert.ok(j.server.rssMB > 10 && j.server.cores >= 1 && j.server.loopLagP99Ms >= 0 && 'cpuPct' in j.server);
    await watch;
  });

  test('a viewer whose queue grows is counted as backed up once per episode, and the peak is kept', () => {
    const { Client } = require('../src/relay');
    const res = { writableLength: 0, destroyed: false, write() {}, destroy() { this.destroyed = true; }, end() {} };
    const c = new Client(res, 8 * 1024 * 1024);
    const chunk = Buffer.alloc(1000);
    c.send(chunk);
    res.writableLength = 300 * 1024; c.send(chunk); c.send(chunk);
    res.writableLength = 10 * 1024; c.send(chunk);
    res.writableLength = 400 * 1024; c.send(chunk);
    const d = c.diag();
    assert.equal(d.backups, 2);
    assert.equal(d.peakKB, 400);
    assert.equal(d.queueKB, 400);
    assert.ok(d.kbpsSent >= 0);
  });

  test('the speed block has exactly the size asked, capped at 32 MB', async () => {
    const r = await get(base, '/api/diag/speed?mb=2', { headers: { Cookie: admin } });
    assert.equal(r.status, 200);
    assert.equal(r.n, 2 * 1024 * 1024);
    assert.equal(r.headers['cache-control'], 'no-store');
    const r2 = await get(base, '/api/diag/speed?mb=999', { headers: { Cookie: admin }, ms: 300 });
    assert.equal(Number(r2.headers['content-length']), 32 * 1024 * 1024);
  });
});
