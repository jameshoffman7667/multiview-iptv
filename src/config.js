'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[a-z0-9_-]{1,32}$/;

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function normalizeBase(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { throw httpError(400, 'Provider URL is not valid'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw httpError(400, 'Provider URL must start with http:// or https://');
  let p = u.pathname.replace(/\/+$/, '');
  p = p.replace(/\/(player_api\.php|get\.php|c)$/i, '');
  return `${u.protocol}//${u.host}${p}`;
}

const ENCODERS = ['x264', 'vaapi', 'nvenc'];
const INPUT_FORMATS = ['', 'mjpeg', 'yuyv422', 'h264', 'nv12'];

// One capture source of a local provider. Device names end up on an ffmpeg command line, so they are strictly checked.
function cleanSource(input, taken) {
  const name = String(input.name || '').trim().slice(0, 60);
  if (!name) throw httpError(400, 'Each capture source needs a name');
  let id = String(input.id || '').toLowerCase();
  if (!/^[a-z0-9_-]{1,24}$/.test(id) || taken.some((t) => t.id === id)) {
    do { id = crypto.randomBytes(3).toString('hex'); } while (taken.some((t) => t.id === id));
  }
  const video = String(input.video || '').trim();
  if (video !== 'test' && !/^\/dev\/video\d{1,3}$/.test(video)) throw httpError(400, `"${name}": video device must look like /dev/video0 (or "test" for the test pattern)`);
  const audio = String(input.audio || '').trim();
  if (audio && audio !== 'test' && !/^(?:plug)?hw:[0-9A-Za-z_]{1,24}(?:,\d{1,2})?$|^default$/.test(audio)) throw httpError(400, `"${name}": audio device must look like hw:1,0, plughw:1,0 or default`);
  const size = String(input.size || '1280x720').trim();
  if (!/^\d{3,4}x\d{3,4}$/.test(size)) throw httpError(400, `"${name}": resolution must look like 1280x720`);
  const fps = Math.floor(Number(input.fps) || 30);
  const bitrate = Math.floor(Number(input.bitrate) || 4000);
  const encoder = ENCODERS.includes(input.encoder) ? input.encoder : 'x264';
  const inputFormat = INPUT_FORMATS.includes(input.inputFormat) ? input.inputFormat : '';
  return { id, name, video, audio, size, fps: Math.min(60, Math.max(5, fps)), bitrate: Math.min(20000, Math.max(500, bitrate)), encoder, inputFormat };
}

class Config {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'providers.json');
    this.providers = [];
    fs.mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  load() {
    let raw = { providers: [] };
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') console.error('providers.json unreadable:', e.message);
    }
    const list = Array.isArray(raw.providers) ? raw.providers : [];
    this.providers = [];
    for (const p of list) {
      try { this.providers.push(this.clean(p, this.providers)); } catch (e) { console.error('Skipping provider in providers.json:', e.message); }
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ providers: this.providers }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(id) { return this.providers.find((p) => p.id === id); }
  enabled() { return this.providers.filter((p) => p.enabled); }

  // Validate one provider record; `taken` = providers already accepted (for id uniqueness).
  clean(input, taken) {
    if (input.type === 'local') return this.cleanLocal(input, taken);
    const name = String(input.name || '').trim().slice(0, 60);
    const username = String(input.username || '').trim();
    const password = String(input.password || '');
    if (!name) throw httpError(400, 'Each provider needs a name');
    if (!username) throw httpError(400, `Provider "${name}" needs a username`);
    if (!password) throw httpError(400, `Provider "${name}" needs a password`);
    let id = String(input.id || '').toLowerCase();
    if (!ID_RE.test(id) || taken.some((t) => t.id === id)) {
      do { id = crypto.randomBytes(3).toString('hex'); } while (taken.some((t) => t.id === id));
    }
    const max = Math.floor(Number(input.maxConnections));
    return {
      id,
      name,
      url: normalizeBase(input.url),
      username,
      password,
      maxConnections: Number.isFinite(max) && max >= 1 ? Math.min(max, 50) : 1,
      enabled: input.enabled !== false,
      type: 'xtream',
      userAgent: String(input.userAgent || '').trim().slice(0, 200),
      urlStyle: input.urlStyle === 'plain' ? 'plain' : 'live',
    };
  }

  cleanLocal(input, taken) {
    const name = String(input.name || '').trim().slice(0, 60);
    if (!name) throw httpError(400, 'Each provider needs a name');
    let id = String(input.id || '').toLowerCase();
    if (!ID_RE.test(id) || taken.some((t) => t.id === id)) {
      do { id = crypto.randomBytes(3).toString('hex'); } while (taken.some((t) => t.id === id));
    }
    const src = Array.isArray(input.sources) ? input.sources : [];
    if (src.length > 12) throw httpError(400, 'At most 12 capture sources per provider');
    const sources = [];
    for (const s of src) sources.push(cleanSource(s || {}, sources));
    return {
      id, name, type: 'local', url: '', username: '', password: '', sources,
      maxConnections: Math.max(1, sources.length), enabled: input.enabled !== false, userAgent: '', urlStyle: 'live',
    };
  }

  // Replace the whole list from the UI. Blank passwords keep the stored one.
  // Returns { removed:[ids], changed:[ids] } so callers can drop affected streams.
  replace(list) {
    if (!Array.isArray(list)) throw httpError(400, 'providers must be an array');
    if (list.length > 20) throw httpError(400, 'At most 20 providers');
    const next = [];
    for (const input of list) {
      const old = input && input.id ? this.get(String(input.id)) : undefined;
      const merged = Object.assign({}, old ? { userAgent: old.userAgent, urlStyle: old.urlStyle } : {}, input);
      if (old && !input.password) merged.password = old.password;
      next.push(this.clean(merged, next));
    }
    const removed = this.providers.filter((o) => !next.some((n) => n.id === o.id)).map((o) => o.id);
    const changed = next.filter((n) => {
      const o = this.get(n.id);
      return o && (JSON.stringify(o.sources || []) !== JSON.stringify(n.sources || []) || o.url !== n.url || o.username !== n.username || o.password !== n.password || o.enabled !== n.enabled || o.urlStyle !== n.urlStyle);
    }).map((n) => n.id);
    this.providers = next;
    this.save();
    return { removed, changed };
  }

  // Provider record built from a test request (may reuse the stored password).
  forTest(input) {
    const old = input && input.id ? this.get(String(input.id)) : undefined;
    const merged = Object.assign({}, old && old.type === 'local' ? old : {}, input);
    if (old && !input.password) merged.password = old.password;
    return this.clean(Object.assign({ name: 'test' }, merged), []);
  }

  view(p) {
    return {
      id: p.id, name: p.name, url: p.url, username: p.username, hasPassword: !!p.password,
      maxConnections: p.maxConnections, enabled: p.enabled, userAgent: p.userAgent, urlStyle: p.urlStyle,
      type: p.type || 'xtream', sources: p.sources || [],
    };
  }
}

module.exports = { Config, httpError, ENCODERS };
