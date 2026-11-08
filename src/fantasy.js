'use strict';
// Fantasy Manager link (P-26): this server holds one read-only connection to Fantasy Manager's score event stream
// (GET /api/ticker/stream, Server-Sent Events) and hands the events on to admin pages. The address and token never
// leave the server. Nothing here writes to Fantasy Manager.
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
    this.heads = new Map();           // playerId -> { at, type, body } (or { at, none: true })
    this.minBackoff = opts.reconnectMs || 2000;
    this.backoff = this.minBackoff;
    if (this.enabled) this.connect();
  }

  status() {
    return { enabled: this.enabled, connected: this.connected, lastEventAt: this.lastEventAt || null, error: this.connected ? '' : this.lastError };
  }

  lib() { return this.base.startsWith('https:') ? https : http; }

  request(path, headers, cb) {
    const u = new URL(this.base + path);
    return this.lib().request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'GET', headers: { Authorization: 'Bearer ' + this.token, ...headers }, timeout: 20000 }, cb);
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

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.watch);
    if (this.req) { try { this.req.destroy(); } catch { /* gone */ } }
    this.removeAllListeners();
  }
}

module.exports = { Fantasy, SseParser, cleanEvent, cleanBase };
