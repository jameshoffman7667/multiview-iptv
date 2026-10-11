'use strict';
// Programme guide data. The provider's XMLTV file is the main source (one download covers every channel);
// get_short_epg per channel is the fallback when the file is missing or empty.
const zlib = require('zlib');
const { Readable } = require('stream');
const xtream = require('./xtream');

const TTL_MS = 4 * 3600 * 1000;
const KEEP_BEFORE = 3 * 3600;         // seconds of past programmes kept (the guide can scroll back a little)
const KEEP_AFTER = 36 * 3600;         // seconds of future programmes kept
const MAX_TEXT = 400 * 1024 * 1024;   // refuse absurd files
const SHORT_TTL = 10 * 60 * 1000;

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
function unesc(s) {
  return String(s).replace(/&(?:amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, d, x) => {
    if (d) return String.fromCodePoint(Number(d));
    if (x) return String.fromCodePoint(parseInt(x, 16));
    return ENT[m.toLowerCase()] || m;
  }).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

// "20260101120000 +0100" -> unix seconds
function xmltvTime(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(String(v || '').trim());
  if (!m) return 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  if (m[7]) {
    const sign = m[7][0] === '-' ? -1 : 1;
    t -= sign * (Number(m[7].slice(1, 3)) * 3600 + Number(m[7].slice(3, 5)) * 60);
  }
  return t;
}

// Streaming parse: calls onProg(channel, start, stop, title, desc) for each <programme>.
// Accepts plain or gzip-compressed XML as an async iterable of Buffers.
async function parseXmltv(source, onProg) {
  const it = (source[Symbol.asyncIterator] || source[Symbol.iterator]).call(source);
  const firstRes = await it.next();
  if (firstRes.done) return;
  const first = Buffer.from(firstRes.value);
  const gz = first[0] === 0x1f && first[1] === 0x8b;
  async function* all() {
    yield first;
    for (;;) { const r = await it.next(); if (r.done) return; yield Buffer.from(r.value); }
  }
  let chunks = all();
  if (gz) chunks = Readable.from(all()).pipe(zlib.createGunzip());
  let buf = '';
  let total = 0;
  const dec = new TextDecoder('utf-8');
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  const attr = (s, k) => { const m = new RegExp(`\\b${k}="([^"]*)"`).exec(s); return m ? unesc(m[1]) : ''; };
  const tag = (s, k) => { const m = new RegExp(`<${k}\\b[^>]*>([\\s\\S]*?)</${k}>`).exec(s); return m ? unesc(m[1]).trim() : ''; };
  const flush = () => {
    re.lastIndex = 0;
    let m;
    let last = 0;
    while ((m = re.exec(buf))) {
      last = re.lastIndex;
      const a = m[1];
      onProg(attr(a, 'channel'), xmltvTime(attr(a, 'start')), xmltvTime(attr(a, 'stop')), tag(m[2], 'title'), tag(m[2], 'desc'));
    }
    if (last) buf = buf.slice(last);
    else if (buf.length > 4 * 1024 * 1024) buf = buf.slice(-1024 * 1024); // no programmes in a long stretch
  };
  for await (const c of chunks) {
    total += c.length;
    if (total > MAX_TEXT) throw new Error('guide file is too large');
    buf += dec.decode(c, { stream: true });
    flush();
  }
  buf += dec.decode();
  flush();
}

class Epg {
  constructor(config, lists) {
    this.config = config;
    this.lists = lists;
    this.data = new Map();     // providerId -> { updated, ok, byChan: Map(epgId -> [[s,e,title,desc]]) }
    this.inflight = new Map();
    this.short = new Map();    // "pid:sid" -> { at, list }
    this.timeoutMs = 120000;
  }

  forget(id) {
    this.data.delete(id);
    for (const k of this.short.keys()) if (k.startsWith(id + ':')) this.short.delete(k);
  }

  async download(p) {
    const res = await fetch(xtream.xmltvUrl(p), {
      headers: { 'User-Agent': xtream.ua(p), Accept: '*/*', 'Accept-Encoding': 'gzip' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`guide file: HTTP ${res.status}`);
    const now = Date.now() / 1000;
    const byChan = new Map();
    let n = 0;
    await parseXmltv(Readable.fromWeb(res.body), (ch, s, e, t, d) => {
      if (!ch || !s || !e || !t || e < now - KEEP_BEFORE || s > now + KEEP_AFTER) return;
      let list = byChan.get(ch);
      if (!list) { list = []; byChan.set(ch, list); }
      list.push([s, e, t.slice(0, 200), d.slice(0, 400)]);
      n++;
    });
    for (const list of byChan.values()) list.sort((a, b) => a[0] - b[0]);
    return { updated: Date.now(), ok: n > 0, byChan, count: n };
  }

  // Ensure the provider's guide is loaded; resolves to its entry (maybe empty). Never rejects.
  load(p, refresh = false) {
    const cur = this.data.get(p.id);
    if (cur && !refresh && Date.now() - cur.updated < TTL_MS) return Promise.resolve(cur);
    if (this.inflight.has(p.id)) return this.inflight.get(p.id);
    const job = this.download(p).catch((e) => ({ updated: Date.now() - TTL_MS + 10 * 60 * 1000, ok: false, byChan: new Map(), error: e.message })) // retry in 10 min
      .then((entry) => { this.data.set(p.id, entry); this.inflight.delete(p.id); return entry; });
    this.inflight.set(p.id, job);
    return job;
  }

  // Programmes for some channels overlapping [from, to] (unix seconds): { sid: [[s,e,title,desc]] }
  async forChannels(p, sids, from, to) {
    const entry = await this.load(p);
    const list = this.lists.peek(p);
    const out = {};
    const need = [];
    for (const sid of sids) {
      const ch = list && list.bySid.get(String(sid));
      let progs = ch && ch.e && entry.byChan.get(ch.e);
      if (progs) progs = progs.filter((x) => x[1] > from && x[0] < to);
      if (progs && progs.length) out[sid] = progs; else { out[sid] = []; need.push(String(sid)); }
    }
    if (!entry.ok && need.length) {
      // no usable guide file: ask the provider channel by channel (few at a time, cached)
      const todo = need.slice(0, 30);
      let i = 0;
      const worker = async () => {
        while (i < todo.length) {
          const sid = todo[i++];
          const progs = await this.shortFor(p, sid).catch(() => []);
          out[sid] = progs.filter((x) => x[1] > from && x[0] < to);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    }
    return out;
  }

  async shortFor(p, sid) {
    const key = `${p.id}:${sid}`;
    const hit = this.short.get(key);
    if (hit && Date.now() - hit.at < SHORT_TTL) return hit.list;
    const rows = await xtream.shortEpg(p, sid, 12);
    const list = rows.map((r) => [r.s, r.e, r.t, r.d]);
    this.short.set(key, { at: Date.now(), list });
    if (this.short.size > 5000) for (const [k, v] of this.short) if (Date.now() - v.at > SHORT_TTL) this.short.delete(k);
    return list;
  }

  // Programmes whose title contains every word of q, from now to +24 h. Needs the guide file.
  async search(p, q, limit = 120) {
    const entry = await this.load(p);
    const list = this.lists.peek(p);
    if (!list) return { available: entry.ok, results: [] };
    const toks = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length || !entry.ok) return { available: entry.ok, results: [] };
    const now = Date.now() / 1000;
    const byEpg = new Map();
    for (const ch of list.channels) if (ch.e) { if (!byEpg.has(ch.e)) byEpg.set(ch.e, []); byEpg.get(ch.e).push(ch); }
    const results = [];
    for (const [id, progs] of entry.byChan) {
      const chans = byEpg.get(id);
      if (!chans) continue;
      for (const pr of progs) {
        if (pr[1] < now || pr[0] > now + 24 * 3600) continue;
        const t = pr[2].toLowerCase();
        if (!toks.every((k) => t.includes(k))) continue;
        for (const ch of chans) results.push({ sid: ch.i, name: ch.n, icon: ch.l, s: pr[0], e: pr[1], t: pr[2] });
      }
    }
    results.sort((a, b) => a.s - b.s);
    return { available: true, results: results.slice(0, limit) };
  }
}

module.exports = { Epg, xmltvTime, parseXmltv };
