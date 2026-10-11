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

// Rough quality rank from the tags in a channel name: 1 = SD / low, 2 = untagged or HD, 3 = FHD, 4 = 4K.
function qualityOf(name) {
  const n = String(name).toLowerCase();
  if (/\b(?:4k|uhd|2160p?)\b/.test(n)) return 4;
  if (/\b(?:fhd|1080p?)\b/.test(n)) return 3;
  if (/\b(?:sd|lq|low|480p?|360p?)\b/.test(n)) return 1;
  return 2;
}

function sigOf(p) {
  return crypto.createHash('sha1').update(`2|${p.url}|${p.username}`).digest('hex').slice(0, 12);
}

const KINDS = {
  live: [xtream.liveCategories, xtream.liveStreams],
  movie: [xtream.vodCategories, xtream.vodStreams],
  series: [xtream.seriesCategories, xtream.seriesList],
};

// A capture-card provider has no remote list: its channels are the sources configured for it.
function localEntry(p) {
  const channels = (p.sources || []).map((s) => ({ i: s.id, n: s.name, c: 'local', l: '', e: '' }));
  return { sig: 'local', updated: Date.now(), categories: [{ id: 'local', name: 'Capture cards' }], channels };
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
    for (const k of this.mem.keys()) if (k === providerId || k.startsWith(providerId + ':')) this.mem.delete(k);
    for (const kind of Object.keys(KINDS)) { try { fs.unlinkSync(this.file(providerId, kind)); } catch { /* none */ } }
  }

  file(id, kind) { return path.join(this.dir, kind === 'live' ? `${id}.json` : `${id}.${kind}.json`); }
  memKey(id, kind) { return kind === 'live' ? id : `${id}:${kind}`; }

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

  fromDisk(p, kind) {
    try {
      const j = JSON.parse(fs.readFileSync(this.file(p.id, kind), 'utf8'));
      if (j.sig !== sigOf(p) || !Array.isArray(j.channels)) return null;
      return this.index(j);
    } catch { return null; }
  }

  // Cached entry without any network access (memory, then disk), or null.
  peek(p, kind = 'live') {
    if (p.type === 'local') { const e = this.index(localEntry(p)); return e; }
    const key = this.memKey(p.id, kind);
    const m = this.mem.get(key);
    if (m && m.sig === sigOf(p)) return m;
    const d = this.fromDisk(p, kind);
    if (d) this.mem.set(key, d);
    return d;
  }

  async get(p, refresh = false, kind = 'live') {
    if (p.type === 'local') return this.peek(p);
    const cached = this.peek(p, kind);
    if (cached && !refresh && Date.now() - cached.updated < TTL_MS) return cached;
    const key = this.memKey(p.id, kind);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const job = (async () => {
      try {
        const [catFn, listFn] = KINDS[kind];
        const [categories, channels] = await Promise.all([catFn(p), listFn(p)]);
        const entry = this.index({ sig: sigOf(p), updated: Date.now(), categories, channels });
        this.mem.set(key, entry);
        const file = this.file(p.id, kind);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ sig: entry.sig, updated: entry.updated, categories, channels }));
        fs.renameSync(`${file}.tmp`, file);
        return entry;
      } catch (e) {
        if (cached) return cached; // stale list beats no list
        throw e;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, job);
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

  // The lowest-quality version of the same channel (same provider first), when one is clearly lower than the chosen one.
  lowerVariant(providerId, sid) {
    const p = this.config.get(providerId);
    const e = p && this.peek(p);
    const ch = e && e.bySid.get(String(sid));
    if (!ch) return null;
    const key = normName(ch.n);
    if (key.length < 2) return null;
    const mine = qualityOf(ch.n);
    let best = null;
    const provs = [p, ...this.config.enabled().filter((o) => o.id !== providerId)];
    for (const o of provs) {
      const oe = this.peek(o);
      for (const c of (oe && oe.byNorm.get(key)) || []) {
        if (o.id === providerId && c.i === ch.i) continue;
        const q = qualityOf(c.n);
        if (q >= mine) continue;
        if (!best || q < best.q) best = { providerId: o.id, sid: c.i, name: c.n, q };
      }
    }
    return best;
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

module.exports = { Lists, normName, qualityOf, KINDS };
