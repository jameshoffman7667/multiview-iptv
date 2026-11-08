'use strict';
// Fantasy Manager link (P-26): event stream in, admin-only stream out, headshot proxy, token never shown.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { SseParser, cleanEvent, cleanBase } = require('../src/fantasy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TOKEN = 'secret-token-123';

function ev(id, extra = {}) {
  return Object.assign({ id, detectedAt: new Date().toISOString(), playerId: '6794', name: "Ja'Marr Chase", pos: 'WR', nflTeam: 'CIN', delta: 6.4, points: 24.3, reason: null,
    leagues: [{ leagueId: '123', name: 'The Forgotten Titans', side: 'mine', delta: 6.4, mineBefore: 96.4, mineAfter: 102.8, oppBefore: 78.2, oppAfter: 78.2, colour: 'green' },
      { leagueId: '456', name: 'IRONMAN FF', side: 'opp', delta: 6.4, mineBefore: 48.5, mineAfter: 48.5, oppBefore: 83.9, oppAfter: 90.3, colour: 'red' }] }, extra);
}

// A stand-in for Fantasy Manager's ticker API.
function mockFm() {
  const m = { clients: new Set(), connects: [], seenAuth: [] };
  m.server = http.createServer((req, res) => {
    m.seenAuth.push(req.headers.authorization);
    if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end(); }
    if (req.url === '/api/ticker/stream') {
      m.connects.push(req.headers['last-event-id'] || '');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': hb\n\n');
      m.clients.add(res);
      req.on('close', () => m.clients.delete(res));
      return;
    }
    if (req.url === '/api/headshot/6794') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    res.writeHead(404); res.end();
  });
  m.send = (e) => { for (const c of m.clients) c.write(`id: ${e.id}\nevent: score\ndata: ${JSON.stringify(e)}\n\n`); };
  m.dropAll = () => { for (const c of m.clients) c.destroy(); };
  return m;
}

function request(base, p, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(new URL(p, base), { method, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const cookieOf = (r) => String(r.headers['set-cookie'] || '').split(';')[0];

// Reads the page-side event stream and collects messages.
function listen(base, p, headers = {}) {
  const out = { events: [], statuses: [], status: 0, close: null };
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(p, base), { headers }, (res) => {
      out.status = res.statusCode;
      if (res.statusCode !== 200) { res.resume(); return resolve(out); }
      const parser = new SseParser((m) => { (m.event === 'score' ? out.events : out.statuses).push(JSON.parse(m.data)); });
      res.setEncoding('utf8');
      res.on('data', (c) => parser.push(c));
      out.close = () => req.destroy();
      resolve(out);
    });
    req.on('error', reject);
  });
}

describe('event parsing', () => {
  test('the SSE parser handles ids, events, comments, split chunks and CRLF', () => {
    const got = [];
    const p = new SseParser((m) => got.push(m));
    p.push(': hb\n\nid: e1\nevent: score\nda');
    p.push('ta: {"a":1}\r\n\r\nid: e2\ndata: x\ndata: y\n\n');
    assert.deepEqual(got, [{ id: 'e1', event: 'score', data: '{"a":1}' }, { id: 'e2', event: 'message', data: 'x\ny' }]);
  });

  test('cleanEvent keeps what the pop-up needs and drops corrections, negatives and nonsense', () => {
    const c = cleanEvent(ev('e1'));
    assert.equal(c.playerId, '6794');
    assert.equal(c.delta, 6.4);
    assert.equal(c.leagues.length, 2);
    assert.equal(c.leagues[1].side, 'opp');
    assert.equal(cleanEvent(ev('e2', { correction: true })), null);
    assert.equal(cleanEvent(ev('e3', { leagues: [{ leagueId: '1', name: 'x', side: 'mine', delta: -2 }] })), null);
    assert.equal(cleanEvent(ev('e4', { playerId: '../x' })).playerId, 'x');
    assert.equal(cleanEvent(ev('e5', { playerId: '' })), null);
    assert.equal(cleanEvent(null), null);
    assert.equal(cleanBase('http://10.0.0.5:5000/'), 'http://10.0.0.5:5000');
    assert.equal(cleanBase('javascript:alert(1)'), '');
  });
});

describe('Fantasy Manager link', () => {
  let fm; let app; let base; let dir; let admin; let viewer;
  before(async () => {
    fm = mockFm();
    await new Promise((r) => fm.server.listen(0, '127.0.0.1', r));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-fant-'));
    app = createApp({ dataDir: dir, basicAuth: '', adminUser: 'boss', adminPassword: 'hunter22', fantasyUrl: `http://127.0.0.1:${fm.server.address().port}`, fantasyToken: TOKEN, fantasyReconnectMs: 150 });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    admin = cookieOf(await request(base, '/api/login', { method: 'POST', body: { username: 'boss', password: 'hunter22' } }));
    await request(base, '/api/users', { method: 'POST', headers: { Cookie: admin }, body: { username: 'guest', password: 'secret22' } });
    viewer = cookieOf(await request(base, '/api/login', { method: 'POST', body: { username: 'guest', password: 'secret22' } }));
    for (let i = 0; i < 50 && !app.fantasy.connected; i++) await sleep(50);
  });
  after(() => { app.close(); fm.server.close(); fm.server.closeAllConnections(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('connects with the bearer token and reports status to admins only', async () => {
    assert.ok(fm.seenAuth.every((a) => a === 'Bearer ' + TOKEN));
    const r = await request(base, '/api/fantasy/status', { headers: { Cookie: admin } });
    const j = JSON.parse(r.body);
    assert.equal(j.enabled, true);
    assert.equal(j.connected, true);
    assert.equal(JSON.stringify(j).includes(TOKEN), false, 'the token is never sent to a page');
    assert.equal((await request(base, '/api/fantasy/status', { headers: { Cookie: viewer } })).status, 403);
    assert.equal((await request(base, '/api/fantasy/stream', { headers: { Cookie: viewer } })).status, 403);
    assert.equal((await request(base, '/api/fantasy/headshot/6794', { headers: { Cookie: viewer } })).status, 403);
    assert.equal((await request(base, '/api/fantasy/status')).status, 401);
  });

  test('an admin page gets score events with their age; corrections and negatives never arrive; repeats are ignored', async () => {
    const a = await listen(base, '/api/fantasy/stream', { Cookie: admin });
    assert.equal(a.status, 200);
    await sleep(100);
    fm.send(ev('evt_1'));
    fm.send(ev('evt_2', { correction: true }));
    fm.send(ev('evt_3', { leagues: [{ leagueId: '1', name: 'x', side: 'mine', delta: -3, mineBefore: 1, mineAfter: 0, oppBefore: 0, oppAfter: 0 }] }));
    fm.send(ev('evt_1'));
    await sleep(250);
    assert.equal(a.events.length, 1);
    assert.equal(a.events[0].id, 'evt_1');
    assert.equal(a.events[0].delta, 6.4);
    assert.equal(a.events[0].leagues[0].mineAfter, 102.8);
    assert.ok(a.events[0].age >= 0 && a.events[0].age < 2000);
    assert.ok(a.statuses.length >= 1 && a.statuses[0].connected === true);
    // a page that connects later can catch up on the last few seconds, but only if it asks
    const late = await listen(base, '/api/fantasy/stream?recent=10', { Cookie: admin });
    const none = await listen(base, '/api/fantasy/stream', { Cookie: admin });
    await sleep(150);
    assert.equal(late.events.length, 1);
    assert.equal(none.events.length, 0);
    a.close(); late.close(); none.close();
  });

  test('headshots are proxied with the token, cached, and unknown players give 404', async () => {
    const r = await request(base, '/api/fantasy/headshot/6794', { headers: { Cookie: admin } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.deepEqual(r.body, PNG);
    const before = fm.seenAuth.length;
    await request(base, '/api/fantasy/headshot/6794', { headers: { Cookie: admin } });
    assert.equal(fm.seenAuth.length, before, 'second request comes from the cache');
    assert.equal((await request(base, '/api/fantasy/headshot/9999', { headers: { Cookie: admin } })).status, 404);
    assert.equal((await request(base, '/api/fantasy/headshot/..%2Fetc', { headers: { Cookie: admin } })).status === 200, false);
  });

  test('a dropped connection is picked up again and resumes from the last event id', async () => {
    const n = fm.connects.length;
    fm.dropAll();
    for (let i = 0; i < 60 && fm.connects.length === n; i++) await sleep(50);
    assert.ok(fm.connects.length > n, 'reconnected');
    assert.equal(fm.connects[fm.connects.length - 1], 'evt_1', 'Last-Event-ID is sent');
    for (let i = 0; i < 40 && !app.fantasy.connected; i++) await sleep(50);
    assert.equal(app.fantasy.connected, true);
  });
});

describe('Fantasy Manager link: off or refused', () => {
  test('with no address the feature is off and the stream route says so', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-fant0-'));
    const app = createApp({ dataDir: dir, basicAuth: '', fantasyUrl: '', fantasyToken: '' });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    assert.deepEqual(JSON.parse((await request(base, '/api/fantasy/status')).body), { enabled: false, connected: false, lastEventAt: null, error: '' });
    assert.equal((await request(base, '/api/fantasy/stream')).status, 404);
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a wrong token shows a readable error and keeps retrying without spamming', async () => {
    const fm = mockFm();
    await new Promise((r) => fm.server.listen(0, '127.0.0.1', r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-fant1-'));
    const app = createApp({ dataDir: dir, basicAuth: '', fantasyUrl: `http://127.0.0.1:${fm.server.address().port}`, fantasyToken: 'wrong', fantasyReconnectMs: 100 });
    await sleep(600);
    const s = app.fantasy.status();
    assert.equal(s.connected, false);
    assert.match(s.error, /refused the token/);
    assert.ok(fm.seenAuth.length >= 2 && fm.seenAuth.length < 12, 'backs off between tries: ' + fm.seenAuth.length);
    app.close();
    fm.server.close();
    fm.server.closeAllConnections();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
