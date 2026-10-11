'use strict';
const { PKT, SYNC, findAlignment, TsInfo, findBurstStart } = require('./ts');
const { Ring } = require('./ring');
const xtream = require('./xtream');
const { httpError } = require('./config');
const capture = require('./capture');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// One upstream connection to a provider, shared by every viewer of that channel.
class Upstream {
  constructor(mgr, provider, sid) {
    this.mgr = mgr;
    this.provider = provider;
    this.sid = String(sid);
    this.key = `${provider.id}:${this.sid}`;
    this.clients = new Set();
    this.pending = 0; // requests waiting for the first data
    this.ring = new Ring(mgr.opts.ringBytes);
    this.info = new TsInfo();
    this.state = 'connecting'; // connecting | live | reconnecting | closed
    this.closed = false;
    this.carry = Buffer.alloc(0);
    this.aligned = false;
    this.unaligned = 0;
    this.attempt = 0;
    this.bytes = 0;
    this.startedAt = Date.now();
    this.lastData = Date.now();
    this.samples = [];
    this.lastError = '';
    this.abort = null;
    this.idleTimer = null;
    this.wake = null;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {}); // rejection is consumed by whoever awaits it
    this.readyTimer = setTimeout(() => this.fail(httpError(504, 'Provider did not start the stream in time')), mgr.opts.readyTimeoutMs);
    this.run();
  }

  get active() { return !this.closed; }
  get idle() { return !this.closed && this.clients.size === 0 && this.pending === 0; }

  bytesPerSec() {
    const s = this.samples;
    if (s.length < 2) return 0;
    const a = s[0];
    const b = s[s.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt >= 1 ? (b.bytes - a.bytes) / dt : 0;
  }

  async run() {
    while (!this.closed) {
      this.abort = new AbortController();
      try {
        await this.pump(this.abort.signal);
        this.lastError = 'provider ended the stream';
      } catch (e) {
        if (this.closed) return;
        this.lastError = this.stalled ? 'stalled (no data)' : (e.status ? `HTTP ${e.status}` : (e.cause && e.cause.code) || e.message || String(e));
        this.stalled = false;
        this.lastErrObj = e;
        if (e.fatal) return this.fail(e);
      }
      if (this.closed) return;
      if (this.idle) return this.close('no viewers');
      this.attempt++;
      const settling = !this.everLive && this.lastErrObj && this.lastErrObj.limit;
      // before the first data fail fast so failover can kick in, except while the provider releases our previous connection
      const allowed = this.everLive ? this.mgr.opts.maxRetries : settling ? 4 : 1;
      if (this.attempt > allowed) {
        const err = httpError(settling ? 503 : 502, `${this.provider.name}: ${this.lastError}`);
        err.limit = !!settling;
        return this.fail(err);
      }
      this.state = 'reconnecting';
      const wait = settling ? 500 * this.attempt : Math.min(8000, 500 * 2 ** (this.attempt - 1));
      log(`[${this.provider.name}] ${this.sid} ${this.lastError}; retry ${this.attempt} in ${wait}ms`);
      await new Promise((r) => { this.wake = r; setTimeout(r, wait); });
      this.wake = null;
    }
  }

  // Capture-card provider: run ffmpeg and use its stdout as the upstream.
  openLocal(signal) {
    const src = (this.provider.sources || []).find((x) => x.id === this.sid);
    if (!src) { const e = httpError(404, 'No such capture source'); e.fatal = true; throw e; }
    const cap = capture.start(src);
    signal.addEventListener('abort', cap.kill, { once: true });
    return cap;
  }

  async pump(signal) {
    let body;
    let cap = null;
    if (this.provider.type === 'local') {
      cap = this.openLocal(signal);
      body = cap.body;
    } else {
      const res = await fetch(xtream.streamUrl(this.provider, this.sid), {
        signal,
        redirect: 'follow',
        headers: { 'User-Agent': xtream.ua(this.provider), Accept: '*/*' },
      });
      if (!res.ok) {
        const e = httpError(502, `HTTP ${res.status}`);
        e.status = res.status;
        e.limit = res.status === 403 || res.status === 429 || res.status === 509;
        // a refusal right after we released a connection is usually the provider not having noticed yet
        const settling = e.limit && this.mgr.recentlyClosed(this.provider.id);
        e.fatal = !settling && this.state === 'connecting' && ((res.status >= 400 && res.status < 500) || res.status === 509);
        throw e;
      }
      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('mpegurl') || ct.includes('text/html')) {
        const e = httpError(502, 'provider returned a playlist/page instead of an MPEG-TS stream');
        e.fatal = true;
        throw e;
      }
      body = res.body;
    }
    this.carry = Buffer.alloc(0);
    this.aligned = false;
    this.unaligned = 0;
    this.ring.clear();
    this.samples = [];
    const connectedAt = Date.now();
    this.lastData = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - this.lastData > this.mgr.opts.stallMs) { this.stalled = true; this.abort.abort(); }
    }, 2000);
    try {
      for await (const chunk of body) {
        this.lastData = Date.now();
        this.onChunk(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if (this.attempt && Date.now() - connectedAt > 10000) this.attempt = 0;
      }
    } finally {
      clearInterval(watchdog);
      if (cap) cap.kill();
    }
    if (this.bytes === 0 && this.state === 'connecting') {
      if (cap) {
        const spawnErr = await Promise.race([cap.error, cap.exited.then(() => null), sleep(2500).then(() => null)]);
        const e = httpError(502, spawnErr && spawnErr.code === 'ENOENT' ? 'ffmpeg is not installed in this container' : `ffmpeg stopped: ${cap.stderrTail() || 'no output (is the device in use or unplugged?)'}`);
        e.fatal = true;
        throw e;
      }
      // some panels answer 200 and hang up at once when the account is out of connections
      const e = httpError(502, 'provider closed the connection without data (connection limit?)');
      e.fatal = !this.mgr.recentlyClosed(this.provider.id);
      e.limit = true;
      throw e;
    }
  }

  onChunk(chunk) {
    let buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    if (!this.aligned) {
      const off = findAlignment(buf);
      if (off < 0) {
        this.unaligned += chunk.length;
        if (this.unaligned > 512 * 1024) {
          const e = httpError(502, 'provider data is not MPEG-TS');
          e.fatal = this.state === 'connecting';
          throw e;
        }
        this.carry = buf.length > 64 * 1024 ? buf.subarray(buf.length - 64 * 1024) : buf;
        return;
      }
      buf = buf.subarray(off);
      this.aligned = true;
    }
    const usable = buf.length - (buf.length % PKT);
    if (usable === 0) { this.carry = Buffer.from(buf); return; }
    // lost sync mid-stream? realign instead of forwarding garbage
    if (buf[0] !== SYNC || buf[usable - PKT] !== SYNC) { this.aligned = false; this.carry = Buffer.from(buf); return; }
    this.carry = usable < buf.length ? Buffer.from(buf.subarray(usable)) : Buffer.alloc(0);
    this.deliver(buf.subarray(0, usable));
  }

  deliver(out) {
    const now = Date.now();
    this.bytes += out.length;
    this.samples.push({ t: now, bytes: this.bytes });
    while (this.samples.length > 2 && now - this.samples[0].t > 10000) this.samples.shift();
    this.ring.write(out);
    this.info.feed(out);
    for (const c of this.clients) c.send(out);
    if (this.state !== 'live') {
      this.state = 'live';
      this.everLive = true;
      clearTimeout(this.readyTimer);
      this.resolveReady();
    }
  }

  // Bytes a late joiner receives first: roughly `seconds` of media starting at a keyframe.
  burst(seconds) {
    const bps = this.bytesPerSec();
    if (!(seconds > 0) || !bps || !this.ring.size) return null;
    const want = Math.min(Math.floor(bps * seconds / PKT) * PKT, this.ring.size);
    const extra = Math.min(Math.floor(bps * 4 / PKT) * PKT, this.ring.size - want);
    const buf = this.ring.tail(want + extra);
    if (!buf.length) return null;
    const targetPkt = Math.floor((buf.length - Math.min(want, buf.length)) / PKT);
    return buf.subarray(findBurstStart(buf, targetPkt, this.info) * PKT);
  }

  attach(client, burstSeconds) {
    this.pending = Math.max(0, this.pending - 1);
    clearTimeout(this.idleTimer);
    const b = this.burst(burstSeconds);
    if (b && b.length) { client.grace(b.length); client.send(b); }
    this.clients.add(client);
  }

  unpend() {
    this.pending = Math.max(0, this.pending - 1);
    this.maybeIdle();
  }

  detach(client) {
    this.clients.delete(client);
    this.maybeIdle();
  }

  maybeIdle() {
    if (!this.idle) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (this.idle) this.close('idle'); }, this.mgr.opts.idleMs);
  }

  fail(err) {
    this.error = err;
    log(`[${this.provider.name}] ${this.sid} failed: ${err.message}`);
    this.rejectReady(err);
    this.close('failed');
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    clearTimeout(this.idleTimer);
    clearTimeout(this.readyTimer);
    if (this.abort) { this.abort.abort(); this.mgr.markClosed(this.provider.id); }
    if (this.wake) this.wake();
    this.rejectReady(httpError(502, `stream closed (${reason})`));
    for (const c of this.clients) c.end();
    this.clients.clear();
    if (this.mgr.map.get(this.key) === this) this.mgr.map.delete(this.key);
    log(`[${this.provider.name}] ${this.sid} closed (${reason})`);
  }
}

class Relay {
  constructor(config, lists, opts) {
    this.config = config;
    this.lists = lists;
    this.opts = Object.assign({
      ringBytes: 16 * 1024 * 1024,
      idleMs: 8000,
      stallMs: 15000,
      maxRetries: 4,
      readyTimeoutMs: 25000,
      cooldownMs: 10000,
      vodLingerMs: 15000,
    }, opts);
    this.map = new Map();
    this.cool = new Map(); // providerId -> time until we avoid it after a limit-like refusal
    this.closedAt = new Map(); // providerId -> when we last released a connection
    this.vod = new Map(); // "providerId|key" -> { provider, n, timer }: movies/episodes being played (each holds a provider slot)
  }

  vodCount(providerId) {
    let n = 0;
    for (const v of this.vod.values()) if (v.provider.id === providerId) n++;
    return n;
  }

  // Hold a provider connection slot for a movie or episode. Returns a release function.
  // The slot is kept for a few seconds after the last request so a player's range requests do not lose it.
  acquireVod(provider, key) {
    const k = `${provider.id}|${key}`;
    let v = this.vod.get(k);
    if (!v) {
      if (!this.makeRoom(provider)) {
        const e = httpError(503, `No free connection at ${provider.name} (${this.activeCount(provider.id)}/${provider.maxConnections} in use)`, 'provider_limit');
        e.limit = true;
        throw e;
      }
      v = { provider, n: 0, timer: null };
      this.vod.set(k, v);
    }
    clearTimeout(v.timer);
    v.n++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      v.n--;
      if (v.n <= 0) {
        v.timer = setTimeout(() => { if (v.n <= 0 && this.vod.get(k) === v) { this.vod.delete(k); this.markClosed(provider.id); } }, this.opts.vodLingerMs);
        if (v.timer.unref) v.timer.unref();
      }
    };
  }

  markClosed(providerId) { this.closedAt.set(providerId, Date.now()); }
  recentlyClosed(providerId, ms = 10000) { return Date.now() - (this.closedAt.get(providerId) || 0) < ms; }

  activeCount(providerId) {
    let n = 0;
    for (const u of this.map.values()) if (u.provider.id === providerId && u.active) n++;
    return n + this.vodCount(providerId);
  }

  // Free a slot for this provider if possible (evicting streams nobody is watching).
  makeRoom(provider) {
    if ((this.cool.get(provider.id) || 0) > Date.now()) return false;
    const max = Math.max(1, provider.maxConnections);
    if (this.activeCount(provider.id) < max) return true;
    // a movie whose last request finished a moment ago only lingers to bridge range requests: it can be replaced
    for (const [k, v] of [...this.vod]) {
      if (v.provider.id === provider.id && v.n <= 0) {
        clearTimeout(v.timer);
        this.vod.delete(k);
        if (this.activeCount(provider.id) < max) return true;
      }
    }
    const idle = [...this.map.values()].filter((u) => u.provider.id === provider.id && u.idle);
    for (const u of idle) {
      u.close('evicted for a new stream');
      if (this.activeCount(provider.id) < max) return true;
    }
    return false;
  }

  start(provider, sid) {
    const up = new Upstream(this, provider, sid);
    this.map.set(up.key, up);
    log(`[${provider.name}] ${sid} opening (${this.activeCount(provider.id)}/${provider.maxConnections})`);
    return up;
  }

  // Resolves to an Upstream that already has data (pending count held until attach/unpend).
  async open(providerId, sid, { failover = true } = {}) {
    const primary = this.config.get(providerId);
    if (!primary || !primary.enabled) throw httpError(404, 'Unknown or disabled provider');
    sid = String(sid);
    const cands = [{ provider: primary, sid }];
    if (failover) {
      for (const a of this.lists.alternates(providerId, sid)) {
        const p = this.config.get(a.providerId);
        if (p) cands.push({ provider: p, sid: a.sid });
      }
    }
    const tried = new Set();
    let lastErr = null;
    let waited = false;
    for (let round = 0; round < cands.length + 2; round++) {
      let pick = null;
      for (const c of cands) { // 1. share a stream that is already running
        const key = `${c.provider.id}:${c.sid}`;
        const up = this.map.get(key);
        if (up && up.active && !tried.has(key)) { pick = up; break; }
      }
      if (!pick) { // 2. open a new one where a connection is free
        for (const c of cands) {
          const key = `${c.provider.id}:${c.sid}`;
          if (tried.has(key) || !c.provider.enabled) continue;
          if (this.makeRoom(c.provider)) { pick = this.start(c.provider, c.sid); break; }
        }
      }
      if (!pick && !waited && this.map.size) {
        // a viewer that just left may not have been noticed yet (e.g. tile switching): give slots a moment to free up
        waited = true;
        await sleep(350);
        continue;
      }
      if (!pick) break;
      pick.pending++;
      try {
        await pick.ready;
        if (pick.provider.id !== providerId) log(`[failover] ${primary.name} -> ${pick.provider.name} for ${sid}`);
        return pick;
      } catch (e) {
        pick.unpend();
        tried.add(pick.key);
        lastErr = e;
        if (e.limit) this.cool.set(pick.provider.id, Date.now() + this.opts.cooldownMs);
        if (!failover) break;
      }
    }
    if (lastErr) throw lastErr;
    const e = httpError(503, `No free connection at ${primary.name} (${this.activeCount(primary.id)}/${primary.maxConnections} in use)`, 'provider_limit');
    throw e;
  }

  state() {
    const streams = [...this.map.values()].filter((u) => u.active).map((u) => ({
      key: u.key,
      providerId: u.provider.id,
      provider: u.provider.name,
      sid: u.sid,
      name: this.lists.nameOf(u.provider.id, u.sid),
      viewers: u.clients.size,
      state: u.state,
      kbps: Math.round(u.bytesPerSec() * 8 / 1000),
      seconds: Math.round((Date.now() - u.startedAt) / 1000),
      error: u.state === 'reconnecting' ? u.lastError : '',
    }));
    for (const [k, v] of this.vod) {
      if (v.n <= 0) continue;
      const key = k.slice(k.indexOf('|') + 1);
      streams.push({ key: k, providerId: v.provider.id, provider: v.provider.name, sid: key, name: key.replace(/^(movie|series):/, '$1 '), viewers: v.n, state: 'live', kbps: 0, seconds: 0, error: '', vod: true });
    }
    const providers = this.config.providers.map((p) => ({
      id: p.id, name: p.name, enabled: p.enabled, max: p.maxConnections, active: this.activeCount(p.id), local: p.type === 'local',
    }));
    return { providers, streams };
  }

  closeProvider(providerId, reason) {
    for (const [k, v] of [...this.vod]) if (v.provider.id === providerId) { clearTimeout(v.timer); this.vod.delete(k); }
    for (const u of [...this.map.values()]) if (u.provider.id === providerId) u.close(reason);
  }

  closeAll() {
    for (const u of [...this.map.values()]) u.close('shutdown');
  }
}

// One HTTP viewer. send() drops viewers that cannot keep up instead of buffering without limit.
class Client {
  constructor(res, maxQueue) {
    this.res = res;
    this.maxQueue = maxQueue;
    this.dead = false;
  }

  // A long burst (minutes of video) is written in one go; do not count it against the slow-viewer limit while it drains.
  grace(bytes) {
    this.extra = (this.extra || 0) + bytes;
    const t = setTimeout(() => { this.extra -= bytes; }, 60000);
    if (t.unref) t.unref();
  }

  send(chunk) {
    if (this.dead || this.res.destroyed) return;
    if (this.res.writableLength > this.maxQueue + (this.extra || 0)) {
      this.dead = true;
      log('viewer too slow; dropping it');
      this.res.destroy();
      return;
    }
    this.res.write(chunk);
  }

  end() {
    if (this.dead) return;
    this.dead = true;
    this.res.end();
  }
}

module.exports = { Relay, Client, Upstream };
