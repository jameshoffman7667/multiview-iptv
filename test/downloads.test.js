'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MockProvider } = require('./mock-xtream');
const { createApp } = require('../src/server');
const { Downloads } = require('../src/downloads');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function request(base, pathname, { method = 'GET', body, headers = {}, ms = 0, abortFirst = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base);
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(u, { method, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers) }, (res) => {
      const chunks = [];
      let done = false;
      const finish = () => { if (done) return; done = true; resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }); };
      res.on('data', (c) => { chunks.push(c); if (abortFirst) { req.destroy(); finish(); } });
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
const cookieOf = (r) => (r.headers['set-cookie'] || [''])[0].split(';')[0];

describe('Downloads class', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-dl-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('the cap is clamped, persisted and 0 means off', () => {
    const d = new Downloads(dir);
    assert.equal(d.cap, 0);
    assert.equal(d.setCap('3'), 3);
    assert.equal(d.setCap(-4), 0);
    assert.equal(d.setCap(9999), 50);
    d.setCap(2);
    assert.equal(new Downloads(dir).cap, 2);
    d.setCap(0);
  });

  test('one provider connection is always kept free for watching', () => {
    const d = new Downloads(dir);
    const p3 = { id: 'a', name: 'A', maxConnections: 3 };
    assert.equal(d.mustWait(p3, 0), '');
    assert.equal(d.mustWait(p3, 1), '');
    assert.match(d.mustWait(p3, 2), /free connection/);
    d.ticket('u', 'a', 'x'); // a ticket not yet used already counts
    assert.match(d.mustWait(p3, 1), /free connection/);
    const p1 = { id: 'b', name: 'B', maxConnections: 1 };
    assert.equal(d.mustWait(p1, 0), '');
    assert.match(d.mustWait(p1, 1), /free connection/);
  });

  test('the server cap makes extra downloads wait', () => {
    const d = new Downloads(dir);
    d.setCap(1);
    const p = { id: 'c', name: 'C', maxConnections: 6 };
    assert.equal(d.mustWait(p, 0), '');
    const id = d.ticket('u', 'c', 'x');
    assert.match(d.mustWait(p, 0), /1 download at once/);
    d.start(id);
    assert.ok(d.mustWait(p, 1));
    d.end(id, true);
    assert.equal(d.mustWait(p, 0), '');
    assert.equal(d.states('u')[id], 'done');
    d.setCap(0);
  });

  test('unused tickets expire and finished jobs are forgotten', () => {
    const d = new Downloads(dir);
    const id = d.ticket('u', 'a', 'x');
    assert.equal(d.valid(id, 'u'), true);
    assert.equal(d.valid(id, 'someone-else'), false);
    d.prune(Date.now() + 61 * 1000);
    assert.equal(d.states('u')[id], 'expired');
    assert.equal(d.valid(id, 'u'), false);
    d.prune(Date.now() + 12 * 60 * 1000);
    assert.equal(d.states('u')[id], undefined);
  });
});

describe('download API', () => {
  let prov; let ctx; let admin; let guest;
  before(async () => {
    prov = await new MockProvider({ user: 'u', pass: 'p', max: 3, kbps: 500, vodBytes: 40 * 1024 * 1024 }).listen();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-dlapi-'));
    const app = createApp({ dataDir: dir, basicAuth: '', relay: { idleMs: 300, vodLingerMs: 200 } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    ctx = { app, dir, base: `http://127.0.0.1:${app.server.address().port}` };
    await request(ctx.base, '/api/providers', { method: 'PUT', body: { providers: [{ id: 'a', name: 'A', url: prov.url, username: 'u', password: 'p', maxConnections: 3 }] } });
    admin = cookieOf(await request(ctx.base, '/api/users', { method: 'POST', body: { username: 'boss', password: 'secret1' } }));
    await request(ctx.base, '/api/users', { method: 'POST', headers: { Cookie: admin }, body: { username: 'guest', password: 'secret2' } });
    guest = cookieOf(await request(ctx.base, '/api/login', { method: 'POST', body: { username: 'guest', password: 'secret2' } }));
    await request(ctx.base, '/api/views', { method: 'POST', headers: { Cookie: admin }, body: { name: 'Movies', layout: '1', tiles: [{ p: 'a', sid: 'movie:501', name: 'Big Movie', vod: 'movie', ext: 'mp4' }] } });
  });
  after(async () => { ctx.app.close(); await prov.close(); fs.rmSync(ctx.dir, { recursive: true, force: true }); });

  const ticket = (cookie, sid = 'movie:501', extra = {}) => request(ctx.base, '/api/dl/ticket', { method: 'POST', headers: { Cookie: cookie }, body: { p: 'a', sid, ext: 'mp4', name: 'Big Movie', ...extra } });

  test('a login is needed and only movies and episodes get tickets', async () => {
    assert.equal((await request(ctx.base, '/api/dl/ticket', { method: 'POST', body: { p: 'a', sid: 'movie:501' } })).status, 401);
    assert.equal((await ticket(admin, '12')).status, 400);
    assert.equal((await ticket(admin, 'movie:501', { p: 'zzz' })).status, 404);
  });

  test('a ticket gives a one-time download url that is tracked until the file ends', async () => {
    const t = json(await ticket(admin));
    assert.equal(t.ok, true);
    assert.match(t.url, /^\/vod\/a\/movie%3A501\.mp4\?dl=1&job=[0-9a-f]+&name=Big%20Movie$/);
    const st = async () => json(await request(ctx.base, '/api/dl/state', { headers: { Cookie: admin } })).jobs[t.job];
    assert.equal(await st(), 'ticket');
    const r = await request(ctx.base, t.url, { headers: { Cookie: admin } });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-disposition'] || '', /attachment/);
    assert.equal(r.buf.length, 40 * 1024 * 1024);
    await sleep(100);
    assert.equal(await st(), 'done');
    // another login cannot see or use it
    assert.deepEqual(json(await request(ctx.base, '/api/dl/state', { headers: { Cookie: guest } })).jobs, {});
  });

  test('a download that is cut off is marked failed', async () => {
    const t = json(await ticket(admin));
    await request(ctx.base, t.url, { headers: { Cookie: admin }, abortFirst: true });
    await sleep(200);
    const s = json(await request(ctx.base, '/api/dl/state', { headers: { Cookie: admin } })).jobs[t.job];
    assert.equal(s, 'failed');
  });

  test('a ticket that is not valid is refused', async () => {
    const r = await request(ctx.base, '/vod/a/movie%3A501.mp4?dl=1&job=nope', { headers: { Cookie: admin } });
    assert.equal(r.status, 410);
    const t = json(await ticket(admin));
    assert.equal((await request(ctx.base, t.url, { headers: { Cookie: guest } })).status, 410);
  });

  test('the cap is admin only, persists, and makes the next download wait', async () => {
    assert.equal((await request(ctx.base, '/api/dl/settings', { headers: { Cookie: guest } })).status, 403);
    const set = json(await request(ctx.base, '/api/dl/settings', { method: 'PUT', headers: { Cookie: admin }, body: { cap: 1 } }));
    assert.equal(set.cap, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'downloads.json'), 'utf8')).cap, 1);
    ctx.app.downloads.prune(Date.now() + 120000);
    const first = json(await ticket(admin));
    assert.equal(first.ok, true);
    const second = json(await ticket(admin));
    assert.equal(second.wait, true);
    assert.match(second.reason, /1 download at once/);
    await request(ctx.base, '/api/dl/settings', { method: 'PUT', headers: { Cookie: admin }, body: { cap: 0 } });
    ctx.app.downloads.prune(Date.now() + 120000);
    assert.equal(json(await ticket(admin)).ok, true);
  });

  test('a login with downloads switched off is refused everywhere', async () => {
    assert.equal(json(await request(ctx.base, '/api/me', { headers: { Cookie: guest } })).download, true);
    await request(ctx.base, '/api/users/guest', { method: 'PUT', headers: { Cookie: admin }, body: { download: false } });
    guest = cookieOf(await request(ctx.base, '/api/login', { method: 'POST', body: { username: 'guest', password: 'secret2' } }));
    assert.equal(json(await request(ctx.base, '/api/me', { headers: { Cookie: guest } })).download, false);
    const list = json(await request(ctx.base, '/api/users', { headers: { Cookie: admin } })).users;
    assert.equal(list.find((u) => u.username === 'guest').download, false);
    const r = await ticket(guest);
    assert.equal(r.status, 403);
    assert.equal(json(r).error, 'download_off');
    assert.equal((await request(ctx.base, '/vod/a/movie%3A501.mp4?dl=1', { headers: { Cookie: guest } })).status, 403);
    // watching is unaffected
    assert.equal((await request(ctx.base, '/vod/a/movie%3A501.mp4', { headers: { Cookie: guest, Range: 'bytes=0-9' } })).status, 206);
    await request(ctx.base, '/api/users/guest', { method: 'PUT', headers: { Cookie: admin }, body: { download: true } });
    assert.equal(json(await request(ctx.base, '/api/me', { headers: { Cookie: guest } })).download, true);
    ctx.app.downloads.prune(Date.now() + 120000);
    assert.equal(json(await ticket(guest)).ok, true);
  });

  test('a download waits when only one provider connection is left', async () => {
    ctx.app.downloads.prune(Date.now() + 120000); // earlier unused tickets no longer count
    const hold = [];
    for (let i = 0; i < 2; i++) hold.push(ctx.app.relay.acquireVod(ctx.app.config.get('a'), `movie:${600 + i}`));
    const r = json(await ticket(admin));
    assert.equal(r.wait, true);
    assert.match(r.reason, /free connection/);
    hold.forEach((f) => f());
  });
});
