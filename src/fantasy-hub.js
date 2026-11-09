'use strict';
// Per-user Fantasy Manager connections (P-27). Each admin saves their own address and read-only token. The token is
// encrypted at rest (AES-256-GCM) with a random key in /data/fantasy.key, is never sent back to a page (only its last 4
// characters) and is never logged. A connection to Fantasy Manager exists only while that admin has a page open; a
// user with nothing saved causes no requests. Only private, LAN and Tailscale addresses are accepted (no SSRF to the
// internet or to this machine): the address is checked when saved and again each time the name is resolved.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { httpError } = require('./config');
const { Fantasy, cleanBase, probe } = require('./fantasy');

function v4ok(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
// 10/8, 172.16/12, 192.168/16, Tailscale 100.64/10 and IPv6 unique-local (fc00::/7, which includes Tailscale's fd7a:...).
// Refused: 127.x / ::1, 0.0.0.0, 169.254.x (link-local, cloud metadata), public addresses, everything else.
function ipAllowed(ip) {
  const s = String(ip || '').toLowerCase();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) return v4ok(m[1]);
  if (net.isIPv4(s)) return v4ok(s);
  if (net.isIPv6(s)) return /^f[cd]/.test(s);
  return false;
}

function parseAddress(raw, allowLoopback) {
  const s = String(raw || '').trim();
  if (!s) throw httpError(400, 'Enter the Fantasy Manager address, for example http://192.168.4.11:5000', 'bad_address');
  if (s.length > 200) throw httpError(400, 'That address is too long', 'bad_address');
  let u;
  try { u = new URL(s); } catch { throw httpError(400, 'That is not a web address (use http://host:port)', 'bad_address'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw httpError(400, 'Only http:// and https:// addresses are allowed', 'bad_address');
  if (u.username || u.password) throw httpError(400, 'Leave the user name and password out of the address', 'bad_address');
  if (u.search || u.hash) throw httpError(400, 'Leave anything after the path (? or #) out of the address', 'bad_address');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowLoopback && (host === 'localhost' || host.endsWith('.localhost'))) throw httpError(400, 'localhost is not allowed; use the LAN address of the machine that runs Fantasy Manager', 'bad_address');
  if (net.isIP(host) && !(ipAllowed(host) || (allowLoopback && (host === '127.0.0.1' || host === '::1')))) {
    throw httpError(400, 'Only private LAN (10.x, 172.16-31.x, 192.168.x) and Tailscale (100.64-127.x) addresses are allowed', 'bad_address');
  }
  return { base: cleanBase(`${u.protocol}//${u.host}${u.pathname}`), host };
}

// DNS lookup used for every request: a name must resolve only to allowed addresses (stops DNS rebinding too).
function guardLookup(allowLoopback) {
  const ok = (ip) => ipAllowed(ip) || (allowLoopback && (ip === '127.0.0.1' || ip === '::1'));
  return (hostname, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      const bad = addrs.find((a) => !ok(a.address));
      if (bad || !addrs.length) { const e = new Error('That name points to an address that is not private, LAN or Tailscale'); e.guard = true; e.code = 'EGUARD'; return cb(e); }
      if (opts && opts.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

function writePrivate(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

class FantasyHub {
  constructor(opts = {}) {
    this.dir = opts.dataDir;
    this.file = path.join(this.dir, 'fantasy.json');
    this.keyFile = path.join(this.dir, 'fantasy.key');
    this.allowLoopback = !!opts.allowLoopback;     // tests only (never from the environment)
    this.reconnectMs = opts.reconnectMs;
    this.summaryMs = opts.summaryMs;
    this.idleMs = opts.idleMs || 60000;            // no page for this long: the connection is closed
    this.cacheMs = opts.cacheMs || 60000;          // the last summary stays available this long after that
    this.lookup = guardLookup(this.allowLoopback);
    this.sessions = new Map();                     // user -> { f: Fantasy, holds, idle }
    this.cache = new Map();                        // user -> { summary, at }
    this.lastTest = new Map();
    this.users = {};
    try { this.users = JSON.parse(fs.readFileSync(this.file, 'utf8')).users || {}; } catch { this.users = {}; }
  }

  userKey(me) { return (me && me.username) || '_open'; }

  // ---- encryption
  key(create) {
    try { const k = fs.readFileSync(this.keyFile); if (k.length === 32) return k; } catch { /* none yet */ }
    if (!create) return null;
    fs.mkdirSync(this.dir, { recursive: true });
    const k = crypto.randomBytes(32);
    writePrivate(this.keyFile, k);
    return k;
  }
  seal(token) {
    const k = this.key(true);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', k, iv);
    const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
  }
  unseal(text) {
    try {
      const [v, iv, tag, ct] = String(text).split('.');
      const k = this.key(false);
      if (v !== 'v1' || !k) return null;
      const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    } catch { return null; }
  }
  save() { fs.mkdirSync(this.dir, { recursive: true }); writePrivate(this.file, JSON.stringify({ users: this.users }, null, 2)); }

  // ---- what a page may see (never the token)
  info(user) {
    const r = this.users[user];
    if (!r) return { configured: false, url: '', tokenSaved: false, tokenLast4: '' };
    return { configured: true, url: r.url, tokenSaved: true, tokenLast4: r.last4 || '', readable: this.unseal(r.tok) !== null };
  }

  async checked(raw) {
    const a = parseAddress(raw, this.allowLoopback);
    if (!net.isIP(a.host)) {
      await new Promise((resolve, reject) => this.lookup(a.host, { all: true }, (e) => (e ? reject(httpError(400, e.guard ? e.message : 'Cannot find that host (' + (e.code || 'DNS error') + ')', 'bad_address')) : resolve())));
    }
    return a.base;
  }
  cleanToken(t) {
    const s = String(t || '').trim();
    if (!s) return '';
    if (s.length < 8 || s.length > 400 || !/^[A-Za-z0-9._~+/=-]+$/.test(s)) throw httpError(400, 'That does not look like a token (copy it again from Fantasy Manager > Account > Multiview access)', 'bad_token');
    return s;
  }

  async set(user, urlRaw, tokenRaw) {
    const base = await this.checked(urlRaw);
    let token = this.cleanToken(tokenRaw);
    const old = this.users[user];
    if (!token) {
      // an unchanged address may keep its saved token; a new address always needs the token typed again
      if (old && old.url === base && this.unseal(old.tok) !== null) token = this.unseal(old.tok);
      else throw httpError(400, 'Enter the token', 'bad_token');
    }
    this.users[user] = { url: base, tok: this.seal(token), last4: token.slice(-4) };
    this.save();
    this.closeSession(user);
    this.cache.delete(user);
    return this.info(user);
  }

  remove(user) {
    this.closeSession(user);
    this.cache.delete(user);
    if (this.users[user]) { delete this.users[user]; this.save(); }
    return this.info(user);
  }

  async test(user, urlRaw, tokenRaw) {
    const t = Date.now();
    if (t - (this.lastTest.get(user) || 0) < 1500) throw httpError(429, 'Wait a moment before testing again', 'rate_limited');
    this.lastTest.set(user, t);
    const old = this.users[user];
    let base; let token = this.cleanToken(tokenRaw);
    try { base = await this.checked(urlRaw || (old && old.url)); } catch (e) { return { ok: false, error: e.message }; }
    if (!token) {
      if (old && old.url === base && this.unseal(old.tok) !== null) token = this.unseal(old.tok);
      else return { ok: false, error: 'Enter the token' };
    }
    return probe(base, token, this.lookup);
  }

  // ---- live connections
  status(user) {
    const r = this.users[user];
    if (!r) return { enabled: false, connected: false, lastEventAt: null, summaryAt: null, error: '' };
    const s = this.sessions.get(user);
    if (s) return s.f.status();
    if (this.unseal(r.tok) === null) return { enabled: true, connected: false, lastEventAt: null, summaryAt: null, error: 'The saved token cannot be read (fantasy.key is missing or changed). Enter it again.' };
    return { enabled: true, connected: false, lastEventAt: null, summaryAt: null, error: '' };
  }

  // The user's connection, started now if needed; null when nothing is saved for them.
  session(user) {
    const r = this.users[user];
    if (!r) return null;
    let s = this.sessions.get(user);
    if (!s) {
      const token = this.unseal(r.tok);
      if (token === null) throw httpError(409, 'The saved token cannot be read (fantasy.key is missing or changed). Enter it again in Settings.', 'fantasy_token');
      const f = new Fantasy({ url: r.url, token, reconnectMs: this.reconnectMs, summaryMs: this.summaryMs, lookup: this.lookup });
      const c = this.cache.get(user);
      if (c && Date.now() - c.at < this.cacheMs) { f.summary = c.summary; f.summaryAt = c.at; }
      s = { f, holds: 0, idle: null };
      this.sessions.set(user, s);
    }
    this.arm(user, s);
    return s.f;
  }
  arm(user, s) {
    clearTimeout(s.idle);
    if (s.holds > 0) return;
    s.idle = setTimeout(() => { if (s.holds === 0) this.closeSession(user, s); }, this.idleMs);
    if (s.idle.unref) s.idle.unref();
  }
  hold(user) { const f = this.session(user); if (f) this.sessions.get(user).holds++; return f; }
  release(user, f) {
    const s = this.sessions.get(user);
    if (!s || s.f !== f) return;
    s.holds = Math.max(0, s.holds - 1);
    this.arm(user, s);
  }
  closeSession(user, only) {
    const s = this.sessions.get(user);
    if (!s || (only && s !== only)) return;
    clearTimeout(s.idle);
    if (s.f.summary) this.cache.set(user, { summary: s.f.summary, at: s.f.summaryAt });
    this.sessions.delete(user);
    s.f.close();
  }
  get active() { return this.sessions.size; }
  close() { for (const u of [...this.sessions.keys()]) this.closeSession(u); }
}

module.exports = { FantasyHub, parseAddress, ipAllowed, guardLookup };
