'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xtream = require('./xtream');

const TTL_MS = 6 * 3600 * 1000;

// "US| ESPN HD [FHD]" and "ESPN" both become "espn" so the same channel can be found at another provider.
function normName(name) {
  let s = String(name).toLowerCase();
  s = s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
  s = s.replace(/^\s*(?:[a-z]{2}|usa)\s*[|:]\s*/, '');
  s = s.replace(/[|:]+/g, ' ');
  s = s.replace(/\b(?:4k|uhd|fhd|hd|sd|hevc|h\.?26[45]|raw|1080p?|720p?|50fps|60fps|multi|backup)\b/g, ' ');
  return s.replace(/[^a-z0-9]+/g, '');
}

function sigOf(p) {
  return crypto.createHash('sha1').update(`${p.url}|${p.username}`).digest('hex').slice(0, 12);
}

class Lists {
  constructor(config, dataDir) {
    this.config = config;
    this.dir = path.join(dataDir, 'cache');
    fs.mkdirSync(this.dir, { recursive: true });
    this.mem = new Map();      // providerId -> { sig, updated, categories, channels, bySid, byNorm }
    this.inflight = new Map(); // providerId -> Promise
  }

  forget(providerId) {
    this.mem.delete(providerId);
    try { fs.unlinkSync(path.join(this.dir, `${providerId}.json`)); } catch { /* none */ }
  }

  index(entry) {
    entry.bySid = new Map();
    entry.byNorm = new Map();
    for (const ch of entry.channels) {
      entry.bySid.set(ch.i, ch);
      const k = normName(ch.n);
      if (k.length < 2) continue;
      if (!entry.byNorm.has(k)) entry.byNorm.set(k, []);
      entry.byNorm.get(k).push(ch);
    }
    return entry;
  }

  fromDisk(p) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.dir, `${p.id}.json`), 'utf8'));
      if (j.sig !== sigOf(p) || !Array.isArray(j.channels)) return null;
      return this.index(j);
    } catch { return null; }
  }

  // Cached entry without any network access (memory, then disk), or null.
  peek(p) {
    const m = this.mem.get(p.id);
    if (m && m.sig === sigOf(p)) return m;
    const d = this.fromDisk(p);
    if (d) this.mem.set(p.id, d);
    return d;
  }

  async get(p, refresh = false) {
    const cached = this.peek(p);
    if (cached && !refresh && Date.now() - cached.updated < TTL_MS) return cached;
    if (this.inflight.has(p.id)) return this.inflight.get(p.id);
    const job = (async () => {
      try {
        const [categories, channels] = await Promise.all([xtream.liveCategories(p), xtream.liveStreams(p)]);
        const entry = this.index({ sig: sigOf(p), updated: Date.now(), categories, channels });
        this.mem.set(p.id, entry);
        const tmp = path.join(this.dir, `${p.id}.json.tmp`);
        fs.writeFileSync(tmp, JSON.stringify({ sig: entry.sig, updated: entry.updated, categories, channels }));
        fs.renameSync(tmp, path.join(this.dir, `${p.id}.json`));
        return entry;
      } catch (e) {
        if (cached) return cached; // stale list beats no list
        throw e;
      } finally {
        this.inflight.delete(p.id);
      }
    })();
    this.inflight.set(p.id, job);
    return job;
  }

  preload() {
    for (const p of this.config.enabled()) {
      this.get(p).catch((e) => console.warn(`[lists] ${p.name}: ${e.message}`));
    }
  }

  nameOf(providerId, sid) {
    const p = this.config.get(providerId);
    const e = p && this.peek(p);
    const ch = e && e.bySid.get(String(sid));
    return ch ? ch.n : '';
  }

  // Same channel (by normalised name) at the other enabled providers, from cached lists only.
  alternates(providerId, sid) {
    const p = this.config.get(providerId);
    const e = p && this.peek(p);
    const ch = e && e.bySid.get(String(sid));
    if (!ch) return [];
    const key = normName(ch.n);
    if (key.length < 2) return [];
    const out = [];
    for (const o of this.config.enabled()) {
      if (o.id === providerId) continue;
      const oe = this.peek(o);
      const hits = oe && oe.byNorm.get(key);
      if (!hits) continue;
      // prefer the candidate whose original name is closest (same quality tags)
      const best = hits.slice().sort((a, b) => Number(b.n.toLowerCase() === ch.n.toLowerCase()) - Number(a.n.toLowerCase() === ch.n.toLowerCase()))[0];
      out.push({ providerId: o.id, sid: best.i, name: best.n });
    }
    return out;
  }
}

module.exports = { Lists, normName };
