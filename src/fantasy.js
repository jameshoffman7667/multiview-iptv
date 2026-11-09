'use strict';
// Fantasy Manager link (P-26, per user since P-27): one Fantasy object is one read-only connection to a Fantasy Manager's
// score event stream (GET /api/ticker/stream, Server-Sent Events) and summary. src/fantasy-hub.js creates one per admin
// who has saved an address and token, only while that admin has a page open. The address and token never leave the
// server. Nothing here writes to Fantasy Manager.
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const KEEP_MS = 10 * 60 * 1000;      // events kept so a page that reconnects can catch up
const SILENT_MS = 45 * 1000;         // Fantasy Manager sends a heartbeat every 15 s; this long with nothing = reconnect
const HEAD_TTL = 24 * 3600 * 1000;
const HEAD_MAX = 300;                // headshots kept in memory

function cleanBase(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  let url;
  try { url = new URL(s); } catch { return ''; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

// Reads "id:", "event:" and "data:" lines, one message per blank line (comments like ": hb" only count as activity).
class SseParser {
  constructor(onMessage) { this.buf = ''; this.cur = { id: '', event: 'message', data: [] }; this.onMessage = onMessage; }
  push(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.search(/\r\n|\n|\r/)) >= 0) {
      const m = /^(\r\n|\n|\r)/.exec(this.buf.slice(i));
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + m[1].length);
      this.line(line);
    }
  }
  line(l) {
    if (l === '') {
      if (this.cur.data.length) this.onMessage({ id: this.cur.id, event: this.cur.event, data: this.cur.data.join('\n') });
      this.cur = { id: this.cur.id, event: 'message', data: [] };
      return;
    }
    if (l[0] === ':') return;
    const k = l.indexOf(':');
    const field = k < 0 ? l : l.slice(0, k);
    let val = k < 0 ? '' : l.slice(k + 1);
    if (val[0] === ' ') val = val.slice(1);
    if (field === 'id') this.cur.id = val;
    else if (field === 'event') this.cur.event = val;
    else if (field === 'data') this.cur.data.push(val);
  }
}

// Matchup summary (GET /api/ticker/summary), reduced to what the ticker shows. Starters only.
function cleanSummary(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.leagues)) return null;
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const str = (x, n) => String(x == null ? '' : x).slice(0, n);
  const colour = (c) => (c === 'green' || c === 'amber' || c === 'red' ? c : '');
  const status = (x) => (x === 'pre' || x === 'live' || x === 'final' ? x : 'pre');
  const team = (t) => ({ name: str(t && t.name, 40), points: num(t && t.points), projected: num(t && t.projected) });
  const statKeys = ['passCmp', 'passAtt', 'passYds', 'passTd', 'int', 'rushAtt', 'rushYds', 'rushTd', 'rec', 'recYds', 'recTd', 'fgm', 'xpm', 'sacks'];
  const leagues = raw.leagues.slice(0, 30).map((l) => ({
    leagueId: str(l.leagueId, 40),
    name: str(l.name, 80),
    status: status(l.status),
    colour: colour(l.colour),
    mine: team(l.mine),
    opp: team(l.opp),
    players: (Array.isArray(l.players) ? l.players : []).filter((p) => p && p.starter !== false && p.slot !== 'BN').slice(0, 40).map((p) => {
      let stats = null;
      if (p.stats && typeof p.stats === 'object') { stats = {}; for (const k of statKeys) if (p.stats[k] !== undefined) stats[k] = num(p.stats[k]); }
      return {
        playerId: str(p.playerId, 24).replace(/[^A-Za-z0-9_-]/g, ''),
        name: str(p.name, 60), pos: str(p.pos, 6), nflTeam: str(p.nflTeam, 6),
        side: p.side === 'opp' ? 'opp' : 'mine',
        slot: str(p.slot, 12), slotOrder: Number.isFinite(Number(p.slotOrder)) && p.slotOrder !== null ? Number(p.slotOrder) : 99,
        kickoffAt: p.kickoffAt ? str(p.kickoffAt, 30) : null,
        points: num(p.points), projected: num(p.projected),
        gameStatus: status(p.gameStatus), gameClock: p.gameClock ? str(p.gameClock, 20) : '',
        stats,
      };
    }).filter((p) => p.playerId),
  })).filter((l) => l.leagueId);
  return { generatedAt: str(raw.generatedAt, 30), season: num(raw.season), week: num(raw.week), leagues };
}

// One score event from Fantasy Manager, reduced to what the page needs.
function cleanEvent(raw, id) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.correction) return null;                       // stat corrections and negative changes never pop up
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const colour = (c) => (c === 'green' || c === 'amber' || c === 'red' ? c : '');
  const leagues = (Array.isArray(raw.leagues) ? raw.leagues : []).map((l) => ({
    leagueId: String(l.leagueId || '').slice(0, 40),
    name: String(l.name || '').slice(0, 80),
    side: l.side === 'opp' ? 'opp' : 'mine',
    delta: num(l.delta !== undefined ? l.delta : raw.delta),
    mineBefore: num(l.mineBefore), mineAfter: num(l.mineAfter),
    oppBefore: num(l.oppBefore), oppAfter: num(l.oppAfter),
    colour: colour(l.colour),
  })).filter((l) => l.delta > 0).slice(0, 12);
  if (!leagues.length) return null;
  const playerId = String(raw.playerId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  if (!playerId) return null;
  return {
    id: String(raw.id || id || ''),
    playerId,
    name: String(raw.name || '').slice(0, 60),
    pos: String(raw.pos || '').slice(0, 6),
    nflTeam: String(raw.nflTeam || '').slice(0, 6),
    reason: raw.reason ? String(raw.reason).slice(0, 30) : '',
    delta: Math.max(...leagues.map((l) => l.delta)),
    leagues,
  };
}

class Fantasy extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.base = cleanBase(opts.url);
    this.lookup = opts.lookup || null;      // DNS guard (only private, LAN and Tailscale addresses)
    this.token = String(opts.token || '').trim();
    this.enabled = !!(this.base && this.token);
    this.connected = false;
    this.lastEventAt = 0;
    this.lastError = '';
    this.log = [];                    // [{ at, ev }]
    this.lastId = '';
    this.req = null;
    this.timer = null;
    this.watch = null;
    this.closed = false;
    this.summary = null;               // latest cleaned matchup summary
    this.summaryAt = 0;
    this.sumTimer = null;
    this.sumBusy = false;
    this.sumMs = opts.summaryMs || 0;  // tests set a short poll; normally 15 s during games, 60 s otherwise
    this.heads = new Map();           // playerId -> { at, type, body } (or { at, none: true })
    this.minBackoff = opts.reconnectMs || 2000;
    this.backoff = this.minBackoff;
    if (this.enabled) { this.connect(); this.pollSummary(); }
  }

  status() {
    return { enabled: this.enabled, connected: this.connected, lastEventAt: this.lastEventAt || null, summaryAt: this.summaryAt || null, error: this.connected ? '' : this.lastError };
  }

  lib() { return this.base.startsWith('https:') ? https : http; }

  request(path, headers, cb) {
    const u = new URL(this.base + path);
    return this.lib().request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'GET', headers: { Authorization: 'Bearer ' + this.token, ...headers }, timeout: 20000, ...(this.lookup ? { lookup: this.lookup } : {}) }, cb);
  }

  connect() {
    if (this.closed) return;
    clearTimeout(this.timer);
    const headers = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
    if (this.lastId) headers['Last-Event-ID'] = this.lastId;
    const req = this.request('/api/ticker/stream', headers, (res) => {
      if (res.statusCode !== 200) {
        this.lastError = res.statusCode === 401 || res.statusCode === 403 ? 'Fantasy Manager refused the token' : `Fantasy Manager answered ${res.statusCode}`;
        res.resume();
        return this.retry();
      }
      this.connected = true;
      this.lastError = '';
      this.backoff = this.minBackoff;
      this.emit('status');
      res.setEncoding('utf8');
      const parser = new SseParser((m) => this.message(m));
      const kick = () => { clearTimeout(this.watch); this.watch = setTimeout(() => req.destroy(new Error('no data from Fantasy Manager')), SILENT_MS); };
      kick();
      res.on('data', (c) => { kick(); parser.push(c); });
      res.on('end', () => this.retry());
      res.on('error', () => this.retry());
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { this.lastError = 'Cannot reach Fantasy Manager (' + (e.code || e.message) + ')'; this.retry(); });
    req.end();
    this.req = req;
  }

  // Matchup summary: every 15 s while any game is live, every 60 s otherwise (Fantasy Manager caches it either way).
  pollSummary() {
    if (this.closed || !this.enabled) return;
    clearTimeout(this.sumTimer);
    if (this.sumBusy) return;
    this.sumBusy = true;
    const done = (sum) => {
      this.sumBusy = false;
      if (sum) { this.summary = sum; this.summaryAt = Date.now(); this.lastError = this.connected ? '' : this.lastError; this.emit('summary'); }
      if (this.closed) return;
      const live = this.summary && this.summary.leagues.some((l) => l.status === 'live');
      this.sumTimer = setTimeout(() => this.pollSummary(), this.sumMs || (live ? 15000 : 60000));
    };
    const req = this.request('/api/ticker/summary', { Accept: 'application/json' }, (res) => {
      if (res.statusCode !== 200) { res.resume(); if (res.statusCode === 401 || res.statusCode === 403) this.lastError = 'Fantasy Manager refused the token'; return done(null); }
      const parts = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > 2 * 1024 * 1024) req.destroy(); else parts.push(c); });
      res.on('end', () => { let j = null; try { j = cleanSummary(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { /* bad answer */ } done(j); });
      res.on('error', () => done(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(null));
    req.end();
  }

  retry() {
    if (this.closed) return;
    clearTimeout(this.watch);
    const was = this.connected;
    this.connected = false;
    if (this.req) { try { this.req.destroy(); } catch { /* gone */ } this.req = null; }
    if (was) this.emit('status');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(30000, Math.round(this.backoff * 1.7));
  }

  message(m) {
    if (m.id) this.lastId = m.id;
    if (m.event !== 'score') return;
    let raw;
    try { raw = JSON.parse(m.data); } catch { return; }
    const ev = cleanEvent(raw, m.id);
    if (!ev) return;
    if (ev.id && this.log.some((x) => x.ev.id === ev.id)) return;
    const now = Date.now();
    this.lastEventAt = now;
    this.log.push({ at: now, ev });
    while (this.log.length && this.log[0].at < now - KEEP_MS) this.log.shift();
    this.emit('score', ev, now);
    // a score just changed: refresh the summary soon so the ticker follows
    clearTimeout(this.sumTimer);
    this.sumTimer = setTimeout(() => this.pollSummary(), 1500);
  }

  // Events the server saw at or after `sinceMs` (a page that reconnects asks for the last few seconds only).
  since(sinceMs) { return this.log.filter((x) => x.at >= sinceMs); }

  // Headshot proxy: the token stays here; images are cached in memory for a day.
  headshot(id, cb) {
    const hit = this.heads.get(id);
    const now = Date.now();
    if (hit && now - hit.at < HEAD_TTL) return cb(hit.none ? null : hit);
    if (!this.enabled) return cb(null);
    const req = this.request('/api/headshot/' + encodeURIComponent(id), {}, (res) => {
      if (res.statusCode !== 200) { res.resume(); return cb(null); }
      const type = String(res.headers['content-type'] || 'image/png').split(';')[0];
      if (!/^image\/(png|jpe?g|webp|svg\+xml)$/.test(type)) { res.resume(); return cb(null); }
      const parts = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > 1024 * 1024) { req.destroy(); } else parts.push(c); });
      res.on('end', () => {
        if (n > 1024 * 1024) return cb(null);
        const rec = { at: Date.now(), type, body: Buffer.concat(parts) };
        this.heads.set(id, rec);
        if (this.heads.size > HEAD_MAX) this.heads.delete(this.heads.keys().next().value);
        cb(rec);
      });
      res.on('error', () => cb(null));
    });
    req.on('error', () => cb(null));
    req.on('timeout', () => req.destroy());
    req.end();
  }

  // resolves when a summary is there (or after ms)
  waitSummary(ms) {
    if (this.summary) return Promise.resolve(this.summary);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.off('summary', on); resolve(this.summary); }, ms);
      const on = () => { clearTimeout(t); resolve(this.summary); };
      this.once('summary', on);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('closed');
    clearTimeout(this.timer);
    clearTimeout(this.watch);
    clearTimeout(this.sumTimer);
    if (this.req) { try { this.req.destroy(); } catch { /* gone */ } }
    this.removeAllListeners();
  }
}

// One quick check of an address and token without keeping a connection: GET /api/ticker/health.
function probe(base, token, lookup) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(base + '/api/ticker/health'); } catch { return resolve({ ok: false, error: 'Bad address' }); }
    const lib = u.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const req = lib.request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname, method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, timeout: 8000, ...(lookup ? { lookup } : {}) }, (res) => {
      if (res.statusCode === 401 || res.statusCode === 403) { res.resume(); return done({ ok: false, error: 'Fantasy Manager refused the token' }); }
      if (res.statusCode === 404) { res.resume(); return done({ ok: false, error: 'That address answers, but it is not a Fantasy Manager with the ticker API (needs 4.17.0 or later)' }); }
      if (res.statusCode !== 200) { res.resume(); return done({ ok: false, error: 'Fantasy Manager answered ' + res.statusCode }); }
      const parts = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n < 65536) parts.push(c); });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { /* not json */ }
        if (!j || j.status !== 'ok') return done({ ok: false, error: 'That address did not answer like Fantasy Manager' });
        done({ ok: true, version: String(j.version || '').slice(0, 20) });
      });
      res.on('error', () => done({ ok: false, error: 'Connection dropped' }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => done({ ok: false, error: e && e.guard ? e.message : 'Cannot reach Fantasy Manager (' + ((e && (e.code || e.message)) || 'error') + ')' }));
    req.end();
  });
}

module.exports = { probe, Fantasy, SseParser, cleanEvent, cleanSummary, cleanBase };
