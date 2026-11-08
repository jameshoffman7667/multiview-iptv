'use strict';
// Fantasy Manager link (P-26): event stream in, admin-only stream out, headshot proxy, token never shown.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { SseParser, cleanEvent, cleanSummary, cleanBase } = require('../src/fantasy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TOKEN = 'secret-token-123';

function ev(id, extra = {}) {
  return Object.assign({ id, detectedAt: new Date().toISOString(), playerId: '6794', name: "Ja'Marr Chase", pos: 'WR', nflTeam: 'CIN', delta: 6.4, points: 24.3, reason: null,
    leagues: [{ leagueId: '123', name: 'The Forgotten Titans', side: 'mine', delta: 6.4, mineBefore: 96.4, mineAfter: 102.8, oppBefore: 78.2, oppAfter: 78.2, colour: 'green' },
      { leagueId: '456', name: 'IRONMAN FF', side: 'opp', delta: 6.4, mineBefore: 48.5, mineAfter: 48.5, oppBefore: 83.9, oppAfter: 90.3, colour: 'red' }] }, extra);
}

// A stand-in for Fantasy Manager's ticker API.
function summaryDoc() {
  const pl = (id, name, pos, side, slot, slotOrder, pts, st, extra = {}) => Object.assign({ playerId: id, name, pos, nflTeam: 'CIN', side, starter: true, slot, slotOrder, kickoffAt: '2026-11-08T18:00:00Z', points: pts, projected: 12, gameStatus: st, gameClock: null, stats: null }, extra);
  return { generatedAt: '2026-11-08T18:02:11Z', season: 2026, week: 9, leagues: [{
    leagueId: '123', name: 'The Forgotten Titans', platform: 'sleeper', status: 'live', colour: 'green',
    colourBasis: { points: 96.4, projected: 134.6 },
    mine: { teamId: '1', name: 'The All Days', points: 96.4, projected: 134.6 }, opp: { teamId: '4', name: 'Bills Mafia', points: 78.2, projected: 120.1 },
    players: [
      pl('3', 'Wide Receiver', 'WR', 'mine', 'WR', 3, 24.3, 'live', { stats: { rec: 6, recYds: 98, recTd: 1 } }),
      pl('1', 'Quarterback One', 'QB', 'mine', 'QB', 1, 18.4, 'final', { stats: { passCmp: 21, passAtt: 31, passYds: 250, passTd: 2, int: 1, rushAtt: 3, rushYds: 12, rushTd: 0 } }),
      pl('9', 'Bench Guy', 'RB', 'mine', 'BN', 9, 2, 'live', { starter: false }),
      pl('7', 'Runner Opp', 'RB', 'opp', 'RB', 2, 0, 'pre', { stats: null, kickoffAt: '2026-11-08T21:25:00Z' })] }] };
}

function mockFm() {
  const m = { clients: new Set(), connects: [], seenAuth: [], summary: summaryDoc(), summaryHits: 0 };
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
    if (req.url.startsWith('/api/ticker/summary')) { m.summaryHits++; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(m.summary)); }
    if (req.url === '/api/headshot/SF') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); }
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

describe('summary cleaning', () => {
  test('bad answers give null, odd values are tamed, unknown keys dropped', () => {
    assert.equal(cleanSummary(null), null);
    assert.equal(cleanSummary({ leagues: 'x' }), null);
    const c = cleanSummary({ leagues: [{ leagueId: 'L1', name: 'A', status: 'weird', colour: 'purple', mine: {}, opp: { name: 'B', points: 'x' },
      players: [{ playerId: 'a b!', name: 'P', side: 'opp', starter: true, slot: 'QB', slotOrder: null, points: '4.5', stats: { passYds: 10, secret: 1 } }, { playerId: '' }] }, { name: 'no id' }] });
    assert.equal(c.leagues.length, 1);
    assert.equal(c.leagues[0].status, 'pre');
    assert.equal(c.leagues[0].colour, '');
    assert.equal(c.leagues[0].opp.points, 0);
    assert.equal(c.leagues[0].players.length, 1);
    assert.equal(c.leagues[0].players[0].playerId, 'ab');
    assert.equal(c.leagues[0].players[0].slotOrder, 99);
    assert.equal(c.leagues[0].players[0].points, 4.5);
    assert.deepEqual(c.leagues[0].players[0].stats, { passYds: 10 });
  });
});

describe('Fantasy Manager 4.17.1 doc examples', () => {
  test('the exact score event from the doc is accepted, a DEF event keeps its team abbreviation, null reason and providerAt are fine', () => {
    const doc = { id: 'evt_1794078131000', detectedAt: '2026-11-08T18:02:11Z', providerAt: null, playerId: '6794', name: "Ja'Marr Chase", pos: 'WR', nflTeam: 'CIN', delta: 6.4, points: 24.3, reason: null, headshot: '/api/headshot/6794',
      leagues: [{ leagueId: '123', name: 'The Forgotten Titans', side: 'mine', delta: 6.4, mineBefore: 96.4, mineAfter: 102.8, oppBefore: 78.2, oppAfter: 78.2, colour: 'green' }] };
    const c = cleanEvent(doc);
    assert.equal(c.id, 'evt_1794078131000');
    assert.equal(c.leagues[0].mineAfter, 102.8);
    assert.equal(c.reason, '');
    assert.equal(cleanEvent(Object.assign({}, doc, { playerId: 'SF', name: '49ers', pos: 'DEF', nflTeam: 'SF' })).playerId, 'SF');
  });
});

describe('Fantasy Manager link', () => {
  let fm; let app; let base; let dir; let admin; let viewer;
  before(async () => {
    fm = mockFm();
    await new Promise((r) => fm.server.listen(0, '127.0.0.1', r));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-fant-'));
    app = createApp({ dataDir: dir, basicAuth: '', adminUser: 'boss', adminPassword: 'hunter22', fantasyUrl: `http://127.0.0.1:${fm.server.address().port}`, fantasyToken: TOKEN, fantasyReconnectMs: 150, fantasySummaryMs: 150 });
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

  test('the matchup summary is polled, cleaned to starters, served to admins only and refreshed', async () => {
    for (let i = 0; i < 40 && !app.fantasy.summary; i++) await sleep(50);
    const r = await request(base, '/api/fantasy/summary', { headers: { Cookie: admin } });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.leagues.length, 1);
    const l = j.leagues[0];
    assert.equal(l.colour, 'green');
    assert.equal(l.mine.name, 'The All Days');
    assert.equal(l.players.length, 3, 'bench players are left out');
    assert.equal(l.players.some((p) => p.slot === 'BN'), false);
    assert.equal(l.players[0].stats.rec, 6);
    assert.equal(JSON.stringify(j).includes(TOKEN), false);
    assert.equal((await request(base, '/api/fantasy/summary', { headers: { Cookie: viewer } })).status, 403);
    assert.equal((await request(base, '/api/fantasy/summary')).status, 401);
    const hits = fm.summaryHits;
    fm.summary.leagues[0].mine.points = 99.9;
    for (let i = 0; i < 40 && JSON.parse((await request(base, '/api/fantasy/summary', { headers: { Cookie: admin } })).body).leagues[0].mine.points !== 99.9; i++) await sleep(50);
    assert.equal(JSON.parse((await request(base, '/api/fantasy/summary', { headers: { Cookie: admin } })).body).leagues[0].mine.points, 99.9);
    assert.ok(fm.summaryHits > hits);
    fm.summary = summaryDoc();
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
    const logo = await request(base, '/api/fantasy/headshot/SF', { headers: { Cookie: admin } });
    assert.equal(logo.status, 200, 'a DEF logo (team abbreviation) works');
    assert.equal(logo.headers['content-type'], 'image/svg+xml');
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

  test('a score event makes the summary refresh soon', async () => {
    const a = await listen(base, '/api/fantasy/stream', { Cookie: admin });
    await sleep(100);
    const hits = fm.summaryHits;
    app.fantasy.sumMs = 60000;
    clearTimeout(app.fantasy.sumTimer);
    app.fantasy.sumTimer = setTimeout(() => app.fantasy.pollSummary(), 60000);
    fm.send(ev('evt_sum1'));
    for (let i = 0; i < 40 && fm.summaryHits === hits; i++) await sleep(100);
    assert.ok(fm.summaryHits > hits, 'refreshed after the score event');
    app.fantasy.sumMs = 150;
    a.close();
  });
});

describe('Fantasy Manager link: off or refused', () => {
  test('with no address the feature is off and the stream route says so', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-fant0-'));
    const app = createApp({ dataDir: dir, basicAuth: '', fantasyUrl: '', fantasyToken: '' });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    assert.deepEqual(JSON.parse((await request(base, '/api/fantasy/status')).body), { enabled: false, connected: false, lastEventAt: null, summaryAt: null, error: '' });
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
