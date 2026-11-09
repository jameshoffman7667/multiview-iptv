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
const { parseAddress, ipAllowed } = require('../src/fantasy-hub');

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
    if (req.url === '/api/ticker/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok', version: '4.17.1', lastProviderUpdate: null })); }
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
  const out = { events: [], statuses: [], status: 0, close: null, ended: false };
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(p, base), { headers }, (res) => {
      out.status = res.statusCode;
      if (res.statusCode !== 200) { res.resume(); return resolve(out); }
      const parser = new SseParser((m) => { (m.event === 'score' ? out.events : out.statuses).push(JSON.parse(m.data)); });
      res.setEncoding('utf8');
      res.on('end', () => { out.ended = true; });
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

describe('address rules (SSRF)', () => {
  const bad = (u, re) => assert.throws(() => parseAddress(u), (e) => e.status === 400 && (!re || re.test(e.message)), u);
  test('only http and https, no credentials, query or fragment', () => {
    bad('', /Enter/);
    bad('ftp://192.168.1.5', /http/);
    bad('file:///etc/passwd', /http/);
    bad('javascript:alert(1)', /http|web address/);
    bad('192.168.1.5:5000', /http|web address/);
    bad('http://user:pw@192.168.1.5', /user name/);
    bad('http://192.168.1.5/?x=1', /\?/);
    bad('http://192.168.1.5/#a', /\?|#/);
    assert.equal(parseAddress('http://192.168.4.11:5000/').base, 'http://192.168.4.11:5000');
    assert.equal(parseAddress('https://fm.lan:8443/app/').base, 'https://fm.lan:8443/app');
  });
  test('localhost, loopback, link-local, public and odd forms are refused; LAN and Tailscale are accepted', () => {
    for (const u of ['http://localhost:5000', 'http://foo.localhost', 'http://127.0.0.1:5000', 'http://127.1.2.3', 'http://[::1]:5000', 'http://0.0.0.0', 'http://2130706433', 'http://0x7f.0.0.1',
      'http://169.254.169.254/latest', 'http://8.8.8.8', 'http://1.1.1.1:80', 'http://172.32.0.1', 'http://172.15.0.1', 'http://100.63.0.1', 'http://100.128.0.1', 'http://11.0.0.1', 'http://[::ffff:127.0.0.1]', 'http://[fe80::1]', 'http://[2001:4860::1]']) bad(u, /allowed|localhost/);
    for (const u of ['http://10.1.2.3:5000', 'http://172.16.0.9', 'http://172.31.255.1', 'http://192.168.0.2:5000', 'http://100.64.0.1:5000', 'http://100.127.255.254', 'http://[fd7a:115c:a1e0::1]:5000', 'http://[fc00::5]']) assert.ok(parseAddress(u).base, u);
    assert.equal(ipAllowed('::ffff:192.168.1.1'), true);
    assert.equal(ipAllowed('::ffff:8.8.8.8'), false);
  });
  test('the server refuses such addresses and a name that is not LAN', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-fantv-'));
    const app = createApp({ dataDir: dir, basicAuth: '', adminUser: 'boss', adminPassword: 'hunter22' });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const admin = cookieOf(await request(base, '/api/login', { method: 'POST', body: { username: 'boss', password: 'hunter22' } }));
    const put = (url, token = 'abcdefgh1234', path2 = '/api/fantasy/config') => request(base, path2, { method: 'POST', headers: { Cookie: admin }, body: { url, token } });
    for (const u of ['http://127.0.0.1:5000', 'http://localhost:5000', 'http://8.8.8.8', 'ftp://10.0.0.1', 'http://169.254.169.254']) assert.equal((await put(u)).status, 400, u);
    const t = JSON.parse((await put('http://127.0.0.1:5000', 'abcdefgh1234', '/api/fantasy/test')).body);
    assert.equal(t.ok, false, 'the connection test refuses it too, without making a request');
    assert.equal((await put('http://10.255.255.1:5000')).status, 200, 'LAN address saves');
    assert.equal(JSON.parse((await request(base, '/api/fantasy/status', { headers: { Cookie: admin } })).body).connected, false, 'saving does not connect');
    assert.equal((await put('http://100.100.1.1:5000')).status, 200, 'Tailscale address saves');
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Fantasy Manager link (per user)', () => {
  let fm; let app; let base; let dir; let admin; let admin2; let viewer; let url;
  const H = (c) => ({ headers: { Cookie: c } });
  const post = (p, c, body) => request(base, p, { method: 'POST', headers: { Cookie: c }, body });
  const json = (r) => JSON.parse(r.body);
  before(async () => {
    fm = mockFm();
    await new Promise((r) => fm.server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${fm.server.address().port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-fant-'));
    app = createApp({ dataDir: dir, basicAuth: '', adminUser: 'boss', adminPassword: 'hunter22', fantasyAllowLoopback: true, fantasyReconnectMs: 150, fantasySummaryMs: 150, fantasyIdleMs: 700 });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    admin = cookieOf(await request(base, '/api/login', { method: 'POST', body: { username: 'boss', password: 'hunter22' } }));
    await request(base, '/api/users', { method: 'POST', headers: { Cookie: admin }, body: { username: 'second', password: 'secret22', role: 'admin' } });
    await request(base, '/api/users', { method: 'POST', headers: { Cookie: admin }, body: { username: 'guest', password: 'secret22' } });
    admin2 = cookieOf(await request(base, '/api/login', { method: 'POST', body: { username: 'second', password: 'secret22' } }));
    viewer = cookieOf(await request(base, '/api/login', { method: 'POST', body: { username: 'guest', password: 'secret22' } }));
  });
  after(() => { app.close(); fm.server.close(); fm.server.closeAllConnections(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('with nothing saved there is no connection and no request to Fantasy Manager', async () => {
    const st = json(await request(base, '/api/fantasy/status', H(admin)));
    assert.deepEqual(st, { enabled: false, connected: false, lastEventAt: null, summaryAt: null, error: '' });
    assert.equal((await request(base, '/api/fantasy/stream', H(admin))).status, 404);
    assert.equal((await request(base, '/api/fantasy/summary', H(admin))).status, 404);
    assert.equal((await request(base, '/api/fantasy/headshot/6794', H(admin))).status, 404);
    assert.deepEqual(json(await request(base, '/api/fantasy/config', H(admin))), { configured: false, url: '', tokenSaved: false, tokenLast4: '' });
    await sleep(300);
    assert.equal(fm.seenAuth.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'fantasy.key')), false, 'no key file until something is saved');
  });

  test('only admins can see, set, test, remove or use a connection', async () => {
    for (const [m, p] of [['GET', '/api/fantasy/status'], ['GET', '/api/fantasy/config'], ['POST', '/api/fantasy/config'], ['DELETE', '/api/fantasy/config'], ['POST', '/api/fantasy/test'], ['GET', '/api/fantasy/summary'], ['GET', '/api/fantasy/stream'], ['GET', '/api/fantasy/headshot/6794']]) {
      const body = m === 'POST' ? { url, token: TOKEN } : undefined;
      assert.equal((await request(base, p, { method: m, headers: { Cookie: viewer }, body })).status, 403, m + ' ' + p);
      assert.equal((await request(base, p, { method: m, body })).status, 401, 'anonymous ' + m + ' ' + p);
    }
    assert.equal(fm.seenAuth.length, 0);
  });

  test('test connection says ok or why not; saving keeps the token on the server, encrypted, and shows only the last 4', async () => {
    let t = json(await post('/api/fantasy/test', admin, { url, token: 'wrong-token-xx' }));
    assert.equal(t.ok, false);
    assert.match(t.error, /refused the token/);
    await sleep(1600);
    t = json(await post('/api/fantasy/test', admin, { url: 'http://127.0.0.1:1', token: TOKEN }));
    assert.equal(t.ok, false);
    assert.match(t.error, /Cannot reach/);
    await sleep(1600);
    t = json(await post('/api/fantasy/test', admin, { url, token: TOKEN }));
    assert.deepEqual(t, { ok: true, version: '4.17.1' });
    assert.equal((await post('/api/fantasy/test', admin, { url, token: TOKEN })).status, 429, 'testing is rate limited');
    assert.equal((await post('/api/fantasy/config', admin, { url, token: '' })).status, 400, 'a token is needed the first time');
    assert.equal((await post('/api/fantasy/config', admin, { url, token: 'has space in it' })).status, 400);
    const r = await post('/api/fantasy/config', admin, { url, token: TOKEN });
    assert.equal(r.status, 200);
    assert.deepEqual(json(r), { configured: true, url, tokenSaved: true, tokenLast4: TOKEN.slice(-4), readable: true });
    for (const x of [r, await request(base, '/api/fantasy/config', H(admin)), await request(base, '/api/fantasy/status', H(admin))]) assert.equal(x.body.toString().includes(TOKEN), false, 'the token never comes back');
    // on disk: no plain token anywhere in the data folder, key file is private
    const all = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => fs.readFileSync(path.join(dir, f))).map((b) => b.toString('latin1')).join('\n');
    assert.equal(all.includes(TOKEN), false, 'token is encrypted at rest');
    assert.match(fs.readFileSync(path.join(dir, 'fantasy.json'), 'utf8'), /"tok": "v1\./);
    assert.equal(fs.statSync(path.join(dir, 'fantasy.key')).size, 32);
    assert.equal(fs.statSync(path.join(dir, 'fantasy.key')).mode & 0o077, 0, 'key file is 0600');
    assert.equal(fs.statSync(path.join(dir, 'fantasy.json')).mode & 0o077, 0);
    // a changed address needs the token typed again (the saved one is never sent to a new host)
    assert.equal((await post('/api/fantasy/config', admin, { url: url + '/x', token: '' })).status, 400);
    assert.equal((await post('/api/fantasy/config', admin, { url, token: '' })).status, 200, 'same address keeps the saved token');
  });

  test('saving does not connect; the connection opens when a page asks, and is per user', async () => {
    await sleep(200);
    assert.equal(fm.connects.length, 0);
    const sum = json(await request(base, '/api/fantasy/summary', H(admin)));
    assert.equal(sum.leagues.length, 1);
    assert.equal(sum.leagues[0].players.length, 3, 'starters only');
    assert.equal(JSON.stringify(sum).includes(TOKEN), false);
    // the other admin has nothing saved: nothing for them, and no extra request
    const before = fm.seenAuth.length;
    assert.equal((await request(base, '/api/fantasy/summary', H(admin2))).status, 404);
    assert.equal((await request(base, '/api/fantasy/stream', H(admin2))).status, 404);
    assert.equal(json(await request(base, '/api/fantasy/status', H(admin2))).enabled, false);
    assert.equal(json(await request(base, '/api/fantasy/config', H(admin2))).configured, false);
    await sleep(100);
    assert.ok(fm.seenAuth.length >= before);
    assert.equal(fm.seenAuth.filter((a) => a !== 'Bearer ' + TOKEN).length, 1, 'only the one deliberate wrong-token test call used another token');
    assert.equal(app.fantasy.active, 1);
  });

  test('the matchup summary is cleaned to starters and refreshed', async () => {
    const hits = fm.summaryHits;
    fm.summary.leagues[0].mine.points = 99.9;
    for (let i = 0; i < 40 && json(await request(base, '/api/fantasy/summary', H(admin))).leagues[0].mine.points !== 99.9; i++) await sleep(50);
    assert.equal(json(await request(base, '/api/fantasy/summary', H(admin))).leagues[0].mine.points, 99.9);
    assert.ok(fm.summaryHits > hits);
    fm.summary = summaryDoc();
  });

  test('an admin page gets score events with their age; corrections and negatives never arrive; repeats are ignored', async () => {
    const a = await listen(base, '/api/fantasy/stream', { Cookie: admin });
    assert.equal(a.status, 200);
    for (let i = 0; i < 40 && !fm.clients.size; i++) await sleep(50);
    fm.send(ev('evt_1'));
    fm.send(ev('evt_2', { correction: true }));
    fm.send(ev('evt_3', { leagues: [{ leagueId: '1', name: 'x', side: 'mine', delta: -3, mineBefore: 1, mineAfter: 0, oppBefore: 0, oppAfter: 0 }] }));
    fm.send(ev('evt_1'));
    await sleep(250);
    assert.equal(a.events.length, 1);
    assert.equal(a.events[0].id, 'evt_1');
    assert.equal(a.events[0].leagues[0].mineAfter, 102.8);
    assert.ok(a.events[0].age >= 0 && a.events[0].age < 2000);
    assert.ok(a.statuses.length >= 1);
    const late = await listen(base, '/api/fantasy/stream?recent=10', { Cookie: admin });
    const none = await listen(base, '/api/fantasy/stream', { Cookie: admin });
    await sleep(150);
    assert.equal(late.events.length, 1);
    assert.equal(none.events.length, 0);
    a.close(); late.close(); none.close();
  });

  test('headshots are proxied with the token, cached, and unknown players give 404', async () => {
    const r = await request(base, '/api/fantasy/headshot/6794', H(admin));
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.deepEqual(r.body, PNG);
    const before = fm.seenAuth.length;
    await request(base, '/api/fantasy/headshot/6794', H(admin));
    assert.equal(fm.seenAuth.length, before, 'second request comes from the cache');
    assert.equal((await request(base, '/api/fantasy/headshot/SF', H(admin))).headers['content-type'], 'image/svg+xml');
    assert.equal((await request(base, '/api/fantasy/headshot/9999', H(admin))).status, 404);
    assert.equal((await request(base, '/api/fantasy/headshot/..%2Fetc', H(admin))).status === 200, false);
  });

  test('a score event makes the summary refresh soon', async () => {
    const a = await listen(base, '/api/fantasy/stream', { Cookie: admin });
    await sleep(100);
    const f = app.fantasy.sessions.get('boss').f;
    f.sumMs = 60000;
    clearTimeout(f.sumTimer);
    f.sumTimer = setTimeout(() => f.pollSummary(), 60000);
    const hits = fm.summaryHits;
    fm.send(ev('evt_sum1'));
    for (let i = 0; i < 40 && fm.summaryHits === hits; i++) await sleep(100);
    assert.ok(fm.summaryHits > hits, 'refreshed after the score event');
    f.sumMs = 150;
    a.close();
  });

  test('a dropped connection is picked up again and resumes from the last event id', async () => {
    const hold = await listen(base, '/api/fantasy/stream', { Cookie: admin });
    const n = fm.connects.length;
    fm.dropAll();
    for (let i = 0; i < 60 && fm.connects.length === n; i++) await sleep(50);
    assert.ok(fm.connects.length > n, 'reconnected');
    assert.match(fm.connects[fm.connects.length - 1], /^evt_/, 'Last-Event-ID is sent');
    hold.close();
  });

  test('the connection closes when the user has no page open, and the last summary stays for a minute', async () => {
    for (let i = 0; i < 60 && app.fantasy.active; i++) await sleep(100);
    assert.equal(app.fantasy.active, 0, 'closed after the idle time');
    for (let i = 0; i < 20 && fm.clients.size; i++) await sleep(50);
    assert.equal(fm.clients.size, 0, 'Fantasy Manager sees no connection');
    const hits = fm.summaryHits;
    await sleep(400);
    assert.equal(fm.summaryHits, hits, 'no polling while nobody has a page open');
    assert.equal(json(await request(base, '/api/fantasy/config', H(admin))).configured, true, 'the saved connection stays');
    assert.ok(app.fantasy.cache.has('boss'));
    const f = app.fantasy.session('boss');
    assert.ok(f.summary && f.summary.leagues.length === 1, 'cached summary is there at once');
    app.fantasy.closeSession('boss');
  });

  test('changing or removing the connection ends open pages and the saved data goes away', async () => {
    const a = await listen(base, '/api/fantasy/stream', { Cookie: admin });
    assert.equal(a.status, 200);
    const r = await request(base, '/api/fantasy/config', { method: 'DELETE', headers: { Cookie: admin } });
    assert.equal(r.status, 200);
    assert.equal(json(r).configured, false);
    for (let i = 0; i < 20 && !a.ended; i++) await sleep(50);
    assert.equal(a.ended, true, 'the open stream ended');
    assert.equal(json(await request(base, '/api/fantasy/status', H(admin))).enabled, false);
    assert.equal((await request(base, '/api/fantasy/summary', H(admin))).status, 404);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'fantasy.json'), 'utf8')).users.boss, undefined);
    assert.equal(app.fantasy.active, 0);
  });

  test('if the key file is lost the saved token reads as unreadable and must be entered again', async () => {
    await post('/api/fantasy/config', admin, { url, token: TOKEN });
    fs.rmSync(path.join(dir, 'fantasy.key'));
    const st = json(await request(base, '/api/fantasy/status', H(admin)));
    assert.equal(st.enabled, true);
    assert.match(st.error, /cannot be read/);
    assert.equal(json(await request(base, '/api/fantasy/config', H(admin))).readable, false);
    assert.equal((await request(base, '/api/fantasy/summary', H(admin))).status, 409);
    assert.equal((await post('/api/fantasy/config', admin, { url, token: '' })).status, 400, 'cannot keep an unreadable token');
    assert.equal((await post('/api/fantasy/config', admin, { url, token: TOKEN })).status, 200, 'entering it again fixes it');
    assert.equal(json(await request(base, '/api/fantasy/config', H(admin))).readable, true);
  });

  test('a wrong token shows a readable error and keeps retrying without spamming', async () => {
    await post('/api/fantasy/config', admin, { url, token: 'wrong-token-xx' });
    const before = fm.seenAuth.length;
    const page = await listen(base, '/api/fantasy/stream', { Cookie: admin });
    await sleep(700);
    const s = json(await request(base, '/api/fantasy/status', H(admin)));
    assert.equal(s.connected, false);
    assert.match(s.error, /refused the token/);
    const n = fm.seenAuth.length - before;
    assert.ok(n >= 2 && n < 14, 'backs off between tries: ' + n);
    page.close();
    await request(base, '/api/fantasy/config', { method: 'DELETE', headers: { Cookie: admin } });
  });
});
