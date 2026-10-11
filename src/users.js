'use strict';
// Accounts, login sessions and published ("broadcast") multiviews.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { httpError } = require('./config');

const SESSION_MS = 30 * 24 * 3600 * 1000;
const SLOTS = 9;
const LAYOUT_KEYS = ['1', '2x2', '1+5', '3x3', '1+7'];

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

class Users {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'users.json');
    this.sessFile = path.join(dataDir, 'sessions.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.users = (readJson(this.file, { users: [] }).users || []).filter((u) => u && u.username);
    const s = readJson(this.sessFile, {});
    this.sessions = new Map(Object.entries(s).filter(([, v]) => v && v.exp > Date.now()));
    this.sessTimer = null;
  }

  get enabled() { return this.users.length > 0; }

  find(name) {
    const n = String(name || '').trim().toLowerCase();
    return this.users.find((u) => u.username.toLowerCase() === n) || null;
  }

  view(u) {
    return { username: u.username, role: u.role, maxStreams: u.maxStreams, disabled: !!u.disabled };
  }

  list() { return this.users.map((u) => this.view(u)); }

  save() { writeAtomic(this.file, JSON.stringify({ users: this.users }, null, 2)); }

  validName(name) {
    const n = String(name || '').trim();
    if (!/^[A-Za-z0-9_.@-]{1,40}$/.test(n)) throw httpError(400, 'Username: 1-40 letters, digits and _ . @ -');
    return n;
  }
  validPass(pw) {
    if (typeof pw !== 'string' || pw.length < 6) throw httpError(400, 'Password must be at least 6 characters');
    if (pw.length > 200) throw httpError(400, 'Password is too long');
    return pw;
  }
  maxStreams(v, role) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) return role === 'admin' ? 0 : 9;
    return Math.min(n, 50);
  }

  create({ username, password, role, maxStreams }) {
    const name = this.validName(username);
    if (this.find(name)) throw httpError(409, 'That username already exists');
    const r = role === 'admin' ? 'admin' : 'viewer';
    const u = { username: name, role: r, ...hashPassword(this.validPass(password)), maxStreams: this.maxStreams(maxStreams, r), disabled: false, created: Date.now() };
    this.users.push(u);
    this.save();
    return u;
  }

  update(name, patch) {
    const u = this.find(name);
    if (!u) throw httpError(404, 'No such user');
    const next = { ...u };
    if (patch.password) Object.assign(next, hashPassword(this.validPass(patch.password)));
    if (patch.role === 'admin' || patch.role === 'viewer') next.role = patch.role;
    if (patch.maxStreams !== undefined) next.maxStreams = this.maxStreams(patch.maxStreams, next.role);
    if (patch.disabled !== undefined) next.disabled = !!patch.disabled;
    const wasAdmin = u.role === 'admin' && !u.disabled;
    if (wasAdmin && !(next.role === 'admin' && !next.disabled) && !this.users.some((x) => x !== u && x.role === 'admin' && !x.disabled)) {
      throw httpError(400, 'There must be at least one active admin');
    }
    Object.assign(u, next);
    this.save();
    if (patch.password || u.disabled || patch.role) this.revoke(u.username);
    return u;
  }

  remove(name) {
    const u = this.find(name);
    if (!u) throw httpError(404, 'No such user');
    if (u.role === 'admin' && !this.users.some((x) => x !== u && x.role === 'admin' && !x.disabled)) throw httpError(400, 'There must be at least one active admin');
    this.users = this.users.filter((x) => x !== u);
    this.save();
    this.revoke(u.username);
    return u;
  }

  verify(name, password) {
    const u = this.find(name);
    // Always do the hash work so timing does not reveal whether the user exists.
    const salt = u ? u.salt : '00'.repeat(16);
    const got = hashPassword(String(password || '').slice(0, 200), salt).hash;
    if (!u || u.disabled) return null;
    const a = Buffer.from(got, 'hex');
    const b = Buffer.from(u.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? u : null;
  }

  // ---- sessions (only a hash of the token is stored)
  login(u) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(sha(token), { user: u.username, exp: Date.now() + SESSION_MS });
    this.saveSessions();
    return token;
  }
  userForToken(token) {
    if (!token) return null;
    const s = this.sessions.get(sha(token));
    if (!s) return null;
    if (s.exp < Date.now()) { this.sessions.delete(sha(token)); return null; }
    const u = this.find(s.user);
    return u && !u.disabled ? u : null;
  }
  logout(token) {
    if (token && this.sessions.delete(sha(token))) this.saveSessions();
  }
  revoke(username) {
    let n = 0;
    for (const [k, v] of this.sessions) if (v.user === username) { this.sessions.delete(k); n++; }
    if (n) this.saveSessions();
  }
  saveSessions() {
    clearTimeout(this.sessTimer);
    this.sessTimer = setTimeout(() => {
      try { writeAtomic(this.sessFile, JSON.stringify(Object.fromEntries(this.sessions))); } catch { /* best effort */ }
    }, 300);
    if (this.sessTimer.unref) this.sessTimer.unref();
  }
  flush() {
    clearTimeout(this.sessTimer);
    try { writeAtomic(this.sessFile, JSON.stringify(Object.fromEntries(this.sessions))); } catch { /* best effort */ }
  }
}

class Views {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'views.json');
    this.views = (readJson(this.file, { views: [] }).views || []).filter((v) => v && v.id);
  }

  save() { writeAtomic(this.file, JSON.stringify({ views: this.views }, null, 2)); }

  clean(body, old) {
    const name = String(body.name !== undefined ? body.name : (old && old.name) || '').trim().slice(0, 60);
    if (!name) throw httpError(400, 'Give the multiview a name');
    const layout = body.layout !== undefined ? body.layout : old && old.layout;
    if (!LAYOUT_KEYS.includes(layout)) throw httpError(400, 'Unknown layout');
    const src = Array.isArray(body.tiles) ? body.tiles : (old && old.tiles) || [];
    const tiles = [];
    for (let i = 0; i < SLOTS; i++) {
      const t = src[i];
      tiles.push(t && typeof t.p === 'string' && t.p && t.sid != null && String(t.sid)
        ? { p: t.p, sid: String(t.sid), name: String(t.name || '').slice(0, 120), icon: String(t.icon || '').slice(0, 500) }
        : null);
    }
    const users = body.users !== undefined ? body.users : (old && old.users) || [];
    if (!Array.isArray(users)) throw httpError(400, 'users must be a list');
    return { name, layout, tiles, users: [...new Set(users.map((u) => String(u)).filter(Boolean))].slice(0, 500) };
  }

  create(body) {
    const v = { id: crypto.randomBytes(6).toString('hex'), ...this.clean(body), rev: 1, updated: Date.now() };
    this.views.push(v);
    this.save();
    return v;
  }
  update(id, body) {
    const v = this.get(id);
    if (!v) throw httpError(404, 'No such multiview');
    Object.assign(v, this.clean(body, v));
    v.rev++;
    v.updated = Date.now();
    this.save();
    return v;
  }
  remove(id) {
    const v = this.get(id);
    if (!v) throw httpError(404, 'No such multiview');
    this.views = this.views.filter((x) => x !== v);
    this.save();
  }
  get(id) { return this.views.find((v) => v.id === id) || null; }

  // Empty `users` list = every viewer. Admins see everything.
  canSee(v, user) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return !v.users.length || v.users.some((n) => n.toLowerCase() === user.username.toLowerCase());
  }
  visible(user) { return this.views.filter((v) => this.canSee(v, user)); }
  allows(user, provider, sid) {
    return this.visible(user).some((v) => v.tiles.some((t) => t && t.p === provider && t.sid === String(sid)));
  }
  forgetProvider(id) {
    let any = false;
    for (const v of this.views) {
      let changed = false;
      v.tiles = v.tiles.map((t) => { if (t && t.p === id) { changed = true; return null; } return t; });
      if (changed) { v.rev++; any = true; }
    }
    if (any) this.save();
  }
}

module.exports = { Users, Views, LAYOUT_KEYS };
