'use strict';
// Server-side composing: one ffmpeg per "job" turns several relay streams into ONE video stream.
//  - kind 'compose': a whole multiview (up to 9 tiles) as a single picture for weak devices.
//  - kind 'tile':    one channel re-encoded to a lower resolution (a 1-tile job).
// A job only runs while somebody watches it. Decoding and scaling happen on the CPU; the encoder can be the GPU.
//
// Inputs are fed to ffmpeg through pipes from the relay (so every channel still uses ONE provider connection).
// Before ffmpeg is started each input is checked for decodable video with ffprobe; an input that has none (yet)
// is left out and its tile stays black. Such an input keeps being watched and joins by restarting the composite
// as soon as it delivers video. One bad input must never fail the whole composite.
const crypto = require('crypto');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { httpError } = require('./config');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RES = { 480: [854, 480, 1200], 720: [1280, 720, 2800], 1080: [1920, 1080, 5000] }; // width at 16:9, height, kbps
const FPS = 25;
const SID_RE = /^[A-Za-z0-9_:-]{1,40}$/;
const even = (n) => Math.round(n) & ~1;
const MIN_ASPECT = 1;
const MAX_ASPECT = 2.4;

// A whole number >= 0 from the environment; anything else (text, negative, 1.5) is reported and replaced by the default.
function intEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    log(`[compose] ${name}="${raw}" is not a whole number of 0 or more; using ${def}`);
    return def;
  }
  return n;
}

// Validate and normalise a request from the page. Throws a 400 on anything odd.
function cleanSpec(raw) {
  const bad = (m) => httpError(400, m, 'bad_spec');
  if (!raw || typeof raw !== 'object') throw bad('Missing job description');
  const res = Number(raw.res);
  if (!RES[res]) throw bad('Resolution must be 480, 720 or 1080');
  const cols = Math.floor(Number(raw.cols));
  const rows = Math.floor(Number(raw.rows));
  if (!(cols >= 1 && cols <= 4 && rows >= 1 && rows <= 4)) throw bad('Bad grid size');
  if (!Array.isArray(raw.cells) || raw.cells.length < 1 || raw.cells.length > 9) throw bad('1 to 9 tiles are allowed');
  const cells = raw.cells.map((c) => {
    const o = { x: Math.floor(Number(c && c.x)), y: Math.floor(Number(c && c.y)), w: Math.floor(Number(c && c.w)), h: Math.floor(Number(c && c.h)), p: String(c && c.p || ''), sid: String(c && c.sid != null ? c.sid : ''), sd: !!(c && c.sd) };
    if (!(o.x >= 1 && o.y >= 1 && o.w >= 1 && o.h >= 1 && o.x + o.w - 1 <= cols && o.y + o.h - 1 <= rows)) throw bad('A tile is outside the grid');
    if (!o.p || o.p.length > 64 || !SID_RE.test(o.sid)) throw bad('Bad channel');
    return o;
  });
  const audio = Math.floor(Number(raw.audio));
  const kind = raw.kind === 'tile' && cells.length === 1 ? 'tile' : 'compose';
  // The picture must have the same shape as the grid the page draws its tiles in, or the tiles are offset.
  let aspect = Number(raw.aspect);
  aspect = Number.isFinite(aspect) && aspect > 0 ? Math.round(Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect)) * 1000) / 1000 : 16 / 9;
  const fit = raw.fit === 'cover' ? 'cover' : 'contain';
  const spec = { kind, res, cols, rows, cells, audio: audio >= 0 && audio < cells.length ? audio : -1, aspect, fit };
  spec.id = crypto.createHash('sha1').update(JSON.stringify([spec.kind, res, cols, rows, cells, spec.audio, aspect, fit])).digest('hex').slice(0, 16);
  return spec;
}

function canvasOf(spec) {
  const h = RES[spec.res][1];
  const w = Math.max(2, 2 * Math.round((h * (spec.aspect || 16 / 9)) / 2));
  return [w, h, RES[spec.res][2]];
}

function vaapiDevice() { return process.env.VAAPI_DEVICE || '/dev/dri/renderD128'; }

function encoderInfo() {
  const want = (process.env.COMPOSE_ENCODER || 'auto').toLowerCase();
  const present = fs.existsSync(vaapiDevice());
  let enc = want;
  if (want === 'auto') enc = present ? 'vaapi' : 'x264';
  if (!['x264', 'vaapi', 'nvenc'].includes(enc)) enc = 'x264';
  return { want, encoder: enc, vaapiDevice: vaapiDevice(), vaapiPresent: present };
}

function ffmpegVersion() {
  try {
    const r = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? String(r.stdout).split('\n')[0].trim() : '';
  } catch { return ''; }
}

function encoderArgs(enc, kbps) {
  const kb = `${kbps}k`;
  const gop = String(FPS * 2);
  if (enc === 'vaapi') return ['-c:v', 'h264_vaapi', '-b:v', kb, '-maxrate', kb, '-g', gop, '-bf', '0'];
  if (enc === 'nvenc') return ['-pix_fmt', 'yuv420p', '-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-b:v', kb, '-maxrate', kb, '-g', gop];
  return ['-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', kb, '-maxrate', kb, '-bufsize', `${kbps * 2}k`, '-g', gop, '-sc_threshold', '0'];
}

// live: array of cell indexes that have an input pipe (pipe:3, pipe:4, ... in that order).
// Timestamps: ffmpeg already shifts every input so that its own start is 0 (audio and video of one input share that
// shift), and the black base canvas runs from 0 in real time, so no per-stream setpts is used (it would move the
// video of the sound tile relative to its audio).
function ffmpegArgs(spec, live, enc) {
  const [W, H, kbps] = canvasOf(spec);
  const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (enc === 'vaapi') a.push('-vaapi_device', vaapiDevice());
  live.forEach((_, k) => a.push('-fflags', '+genpts+discardcorrupt', '-probesize', '2000000', '-analyzeduration', '1000000', '-i', `pipe:${3 + k}`));
  a.push('-re', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${FPS}`);
  const base = live.length;
  const f = [];
  let prev = `${base}:v`;
  live.forEach((ci, k) => {
    const c = spec.cells[ci];
    const x0 = even(((c.x - 1) * W) / spec.cols);
    const y0 = even(((c.y - 1) * H) / spec.rows);
    const x1 = c.x + c.w - 1 === spec.cols ? W : even(((c.x - 1 + c.w) * W) / spec.cols);
    const y1 = c.y + c.h - 1 === spec.rows ? H : even(((c.y - 1 + c.h) * H) / spec.rows);
    const w = Math.max(2, x1 - x0);
    const h = Math.max(2, y1 - y0);
    const fitChain = spec.fit === 'cover'
      ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
      : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;
    f.push(`[${k}:v:0]${fitChain},setsar=1,fps=${FPS}[t${k}]`);
    f.push(`[${prev}][t${k}]overlay=${x0}:${y0}:eof_action=pass[o${k}]`);
    prev = `o${k}`;
  });
  f.push(enc === 'vaapi' ? `[${prev}]format=nv12,hwupload[vout]` : `[${prev}]null[vout]`);
  a.push('-filter_complex', f.join(';'), '-map', '[vout]');
  const ai = live.indexOf(spec.audio);
  if (ai >= 0) a.push('-map', `${ai}:a:0?`, '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-af', 'aresample=async=1000');
  else a.push('-an');
  a.push(...encoderArgs(enc, kbps));
  a.push('-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1', '-pat_period', '0.5', 'pipe:1');
  return a;
}

// A short, readable reason out of ffmpeg's stderr (the filter graph it prints first is long and useless to a viewer).
function shortReason(tail) {
  const lines = String(tail || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const msgs = lines.filter((l) => !/^\[?[a-z0-9_ ]*@ ?0x/i.test(l) || l.length < 160).slice(-2).map((l) => {
    const m = /^(.*?)\s+in filtergraph description\b/.exec(l);
    const s = m ? `${m[1]} (an input has no usable video)` : l.replace(/\[[^\]]{1,40}@ 0x[0-9a-f]+\]\s*/gi, '');
    return s.length > 140 ? `${s.slice(0, 140)}...` : s;
  });
  return msgs.join(' | ') || 'ffmpeg stopped';
}

// Does this piece of MPEG-TS contain a decodable video stream? ffprobe reads the bytes we already hold, so this takes
// a fraction of a second instead of waiting for the stream in real time.
function probeVideo(buf) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    let child;
    try {
      child = spawn(FFPROBE, ['-v', 'error', '-probesize', '3000000', '-analyzeduration', '3000000', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(false); }, 8000);
    child.on('error', (e) => finish(e.code === 'ENOENT' ? null : false)); // null: no ffprobe, caller falls back to the PMT
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.on('error', () => {});
    child.on('close', () => finish(/\w+,\d+,\d+/.test(out)));
    child.stdin.end(buf);
  });
}

const QUEUE_MIN = 12 * 1024 * 1024;
const QUEUE_MAX = 64 * 1024 * 1024;

// What the relay sees as a viewer. It keeps its own queue in front of ffmpeg's input pipe. When ffmpeg falls far behind
// (more than ~20 s of this channel), the queue is replaced by the newest keyframe-aligned data instead of dropping the
// input for good: the tile freezes for a moment and goes on.
class PipeClient {
  constructor(stream, opts = {}) {
    this.stream = stream;
    this.up = opts.up;
    this.label = opts.label || 'input';
    this.onEnd = opts.onEnd || (() => {});
    this.queueSeconds = opts.queueSeconds || 20;
    this.queueMin = opts.queueMin || QUEUE_MIN;
    this.q = [];
    this.qBytes = 0;
    this.dead = false;
    this.ending = false;
    this.resyncs = 0;
    stream.on('error', () => {});
    stream.on('drain', () => this.pump());
  }

  grace() {}

  limit() {
    const bps = (this.up && this.up.bytesPerSec && this.up.bytesPerSec()) || 0;
    return Math.min(QUEUE_MAX, Math.max(this.queueMin, bps * this.queueSeconds));
  }

  send(chunk) {
    if (this.dead || this.ending || this.stream.destroyed) return;
    this.q.push(chunk);
    this.qBytes += chunk.length;
    if (this.qBytes > this.limit()) this.resync();
    this.pump();
  }

  resync() {
    const before = this.qBytes;
    const b = this.up && this.up.burst ? this.up.burst(2) : null;
    this.q = b && b.length ? [b] : [];
    this.qBytes = b && b.length ? b.length : 0;
    this.resyncs++;
    if (this.resyncs <= 3 || this.resyncs % 10 === 0) {
      log(`[compose] ${this.label}: ffmpeg is ${(before / 1048576).toFixed(1)} MB behind; skipping ahead to the latest keyframe (#${this.resyncs})`);
    }
  }

  pump() {
    while (this.q.length && !this.stream.destroyed && !this.stream.writableNeedDrain) {
      const c = this.q.shift();
      this.qBytes -= c.length;
      this.stream.write(c);
    }
    if (this.ending && !this.q.length) this.finish();
  }

  finish() {
    try { this.stream.end(); } catch { /* closed */ }
  }

  // The relay ended this viewer (the channel closed): let ffmpeg see the end of the input after the queue is written.
  end() {
    if (this.dead || this.ending) return;
    this.ending = true;
    this.onEnd();
    this.pump();
  }

  // Our own teardown.
  release() {
    this.dead = true;
    this.q = [];
    this.qBytes = 0;
    try { this.stream.destroy(); } catch { /* closed */ }
  }
}

// Receives a channel's bytes and throws them away; keeps the provider connection of a black tile alive and watched.
class NullClient {
  constructor(onEnd) { this.onEnd = onEnd; this.dead = false; }
  grace() {}
  send() {}
  end() { if (!this.dead) { this.dead = true; this.onEnd(); } }
  release() { this.dead = true; }
}

class Job {
  constructor(mgr, spec) {
    this.mgr = mgr;
    this.spec = spec;
    this.id = spec.id;
    this.viewers = new Set();
    this.slots = spec.cells.map((cell, ci) => ({ ci, cell, up: null, client: null, state: 'idle', why: '', inFfmpeg: false, openedAt: 0, tries: 0, retryAt: 0, probedAt: 0, video: null }));
    this.child = null;
    this.state = 'idle'; // idle | starting | live | closed
    this.closed = false;
    this.startedAt = 0;
    this.lastBuild = 0;
    this.encoder = '';
    this.readyP = null;
    this.gen = 0;
    this.watchTimer = null;
  }

  label(ci) {
    const c = this.spec.cells[ci];
    const name = this.mgr.relay.lists.nameOf(c.p, c.sid);
    return `[compose ${this.id}] screen ${ci + 1} (${c.p}/${c.sid}${name ? ` "${name}"` : ''})`;
  }

  // Resolves when the first picture has been produced; rejects with an HTTP error when it cannot start.
  ready() {
    if (!this.readyP) {
      this.readyP = this.run();
      this.readyP.catch(() => {});
    }
    return this.readyP;
  }

  // ---- inputs
  openSlot(s) {
    if (this.closed || s.state === 'opening') return;
    const { relay } = this.mgr;
    s.state = 'opening';
    s.why = '';
    s.tries++;
    const gen = this.gen;
    relay.open(s.cell.p, s.cell.sid, { failover: true, sd: s.cell.sd }).then((up) => {
      if (this.closed || s.up) { up.unpend(); return; }
      s.up = up;
      s.held = true; // the relay keeps the channel open until we attach (or unpend)
      s.openedAt = Date.now();
      s.state = 'ready'; // has data, not probed yet
    }, (e) => {
      s.state = 'black';
      s.why = e.message;
      s.retryAt = Date.now() + Math.min(60000, 10000 * s.tries);
      if (!this.closed) log(`${this.label(s.ci)}: could not be opened (${e.message}); the tile stays black, retrying in ${Math.round((s.retryAt - Date.now()) / 1000)} s`);
    }).finally(() => { void gen; });
  }

  async probeSlot(s) {
    if (!s.up || s.probedAt > Date.now() - 1000) return s.video;
    const up = s.up;
    let buf = up.burst(3);
    if (!buf || buf.length < 188 * 200) buf = up.ring.tail(Math.min(up.ring.size, 3 * 1024 * 1024));
    const waited = Date.now() - s.openedAt;
    if (!buf || buf.length < 188 * (waited > 2000 ? 10 : 100)) return null; // not enough data yet
    s.probedAt = Date.now();
    let v = await probeVideo(buf);
    if (v === null) v = up.info.videoPids.size > 0; // no ffprobe: trust the program table
    return v;
  }

  // ---- (re)starting
  async run() {
    const gen = ++this.gen;
    this.state = 'starting';
    const deadline = Date.now() + this.mgr.gateMs;
    for (const s of this.slots) if (!s.up && s.state !== 'opening') this.openSlot(s);
    // wait until every input has either data or a failure, but not for ever
    while (Date.now() < deadline && !this.closed && this.slots.some((s) => s.state === 'opening')) await sleep(100);
    // probe what has data, give slow ones until the deadline
    for (;;) {
      if (this.closed) throw httpError(499, 'cancelled');
      const todo = this.slots.filter((s) => s.up && s.video !== true && !(s.video === false && s.probedAt && Date.now() - s.probedAt < 60000));
      await Promise.all(todo.map(async (s) => { s.video = await this.probeSlot(s); }));
      const undecided = this.slots.filter((s) => (s.up && s.video === null) || s.state === 'opening');
      if (!undecided.length || Date.now() >= deadline) break;
      await sleep(300);
    }
    if (this.closed) throw httpError(499, 'cancelled');
    if (gen !== this.gen) throw httpError(499, 'replaced');
    const live = this.slots.filter((s) => s.up && s.video === true);
    for (const s of this.slots) {
      if (live.includes(s)) continue;
      if (s.up) { s.state = 'black'; s.why = s.video === false ? 'no video in this channel' : 'no picture yet'; } // kept attached, watched
      else if (s.state === 'opening') s.why = 'no data yet';
    }
    if (!live.length) {
      const names = this.slots.map((s) => `${s.cell.sid}: ${s.why || 'no data'}`).join('; ');
      const rel = this.slots.find((s) => s.why && /provider|connection|No free/i.test(s.why));
      this.stopFfmpeg();
      throw httpError(rel ? 503 : 502, `No channel delivered a picture (${names.slice(0, 160)})`, rel ? 'provider_limit' : 'compose_failed');
    }
    return this.spawn(live, gen);
  }

  spawn(liveSlots, gen) {
    const enc = this.mgr.encoderFor(this.spec.kind);
    this.encoder = enc;
    const liveIdx = liveSlots.map((s) => s.ci);
    const args = ffmpegArgs(this.spec, liveIdx, enc);
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe', ...liveIdx.map(() => 'pipe')] });
    this.child = child;
    this.lastBuild = Date.now();
    if (!this.startedAt) this.startedAt = Date.now();
    let tail = '';
    let err = '';
    child.stderr.on('data', (d) => { tail = (tail + d).slice(-2000); });
    child.on('error', (e) => { err = e.code === 'ENOENT' ? 'ffmpeg is not installed in this container' : e.message; });
    // attach the new pipes first, then let go of the old ones, so the provider connection never idles in between
    liveSlots.forEach((s, k) => {
      const old = s.client;
      const label = this.label(s.ci);
      const client = new PipeClient(child.stdio[3 + k], { up: s.up, label, queueSeconds: this.mgr.queueSeconds, queueMin: this.mgr.queueMin, onEnd: () => this.inputEnded(s, client) });
      s.client = client;
      s.inFfmpeg = true;
      s.state = 'live';
      this.attach(s, client, 2);
      if (old) { s.up.detach(old); old.release(); }
    });
    for (const s of this.slots) {
      if (liveSlots.includes(s)) continue;
      s.inFfmpeg = false;
      if (s.up && !(s.client instanceof NullClient && !s.client.dead)) { // black tile: keep the channel connected and watched
        const old = s.client;
        s.client = new NullClient(() => this.inputEnded(s, s.client));
        this.attach(s, s.client, 0);
        if (old) { s.up.detach(old); old.release(); }
      }
    }
    const sum = this.slots.map((s) => `${this.label(s.ci).replace(`[compose ${this.id}] `, '')}${s.inFfmpeg ? '' : ` BLACK(${s.why || '?'})`}`).join(', ');
    log(`[compose ${this.id}] ffmpeg pid ${child.pid}: ${this.spec.kind} ${this.spec.res}p ${canvasOf(this.spec)[0]}x${canvasOf(this.spec)[1]} ${enc}, ${liveIdx.length}/${this.spec.cells.length} inputs: ${sum}`);
    this.armWatch();
    let gotData = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { fail(httpError(504, 'The composer produced no picture in time', 'compose_failed')); }, 25000);
      const fail = (e) => { clearTimeout(timer); log(`[compose ${this.id}] ${e.message}\n${tail}`); if (this.child === child) this.close(e.message); reject(e); };
      child.stdout.on('data', (chunk) => {
        if (this.child !== child) return;
        if (!gotData) { gotData = true; clearTimeout(timer); this.state = 'live'; resolve(); }
        for (const v of this.viewers) v.send(chunk);
      });
      child.on('close', (code, sig) => {
        if (this.child !== child) return; // replaced by a restart
        const why = err || shortReason(tail) || `exit ${code}`;
        log(`[compose ${this.id}] ffmpeg pid ${child.pid} exited (code ${code}${sig ? `, ${sig}` : ''})${code ? `; last stderr:\n${tail.trim()}` : ''}`);
        if (!gotData) { fail(httpError(502, `Composer failed: ${why}`, 'compose_failed')); return; }
        this.close(`ffmpeg ended (${why})`);
      });
    });
  }

  attach(s, client, burst) {
    if (!s.held) s.up.pending++; // attach() releases one hold; take one first when we are re-attaching
    s.held = false;
    s.up.attach(client, burst);
  }

  stopFfmpeg() {
    const c = this.child;
    this.child = null;
    if (c) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  }

  // The relay closed an input (provider dropped the channel). The tile goes black; the watcher reopens it later.
  inputEnded(s, client) {
    if (this.closed || s.client !== client) return;
    log(`${this.label(s.ci)}: the channel stopped; the tile goes black until it is back`);
    if (s.up) { try { s.up.detach(client); } catch { /* gone */ } }
    s.up = null;
    s.client = null;
    s.held = false;
    s.video = null;
    s.state = 'black';
    s.why = 'the channel stopped';
    s.retryAt = Date.now() + 5000;
    s.tries = 0;
  }

  // ---- recovery: reopen failed inputs, re-check black ones, restart the composite when one is ready to join
  armWatch() {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => this.watch().catch((e) => log(`[compose ${this.id}] watcher: ${e.message}`)), this.mgr.watchMs);
    if (this.watchTimer.unref) this.watchTimer.unref();
  }

  async watch() {
    if (this.closed || this.state !== 'live' || this.rebuilding) return;
    const now = Date.now();
    for (const s of this.slots) {
      if (s.up || s.state === 'opening' || s.state === 'idle') continue;
      if (s.retryAt <= now) this.openSlot(s);
    }
    let joinable = false;
    for (const s of this.slots) {
      if (!s.up || s.inFfmpeg) continue;
      if (s.state === 'black' && s.probedAt > now - this.mgr.recheckMs) continue;
      const v = await this.probeSlot(s);
      s.video = v;
      if (v === false) s.why = 'no video in this channel';
      if (v === true) { joinable = true; log(`${this.label(s.ci)}: video is now available`); }
    }
    if (joinable && Date.now() - this.lastBuild >= this.mgr.minRebuildMs && this.viewers.size) await this.rebuild('an input became available');
  }

  async rebuild(why) {
    if (this.closed || this.rebuilding) return;
    this.rebuilding = true;
    try {
      log(`[compose ${this.id}] restarting the composite: ${why}`);
      const old = this.child;
      this.child = null; // its exit is ignored
      if (old) { try { old.kill('SIGKILL'); } catch { /* gone */ } }
      for (const v of [...this.viewers]) v.end(); // the pictures restart; players reconnect and get the new stream
      this.readyP = this.run();
      this.readyP.catch((e) => { if (!this.closed) this.close(`restart failed: ${e.message}`); });
      await this.readyP.catch(() => {});
    } finally {
      this.rebuilding = false;
    }
  }

  // ---- viewers
  addViewer(v) {
    clearTimeout(this.idleTimer);
    this.viewers.add(v);
  }

  removeViewer(v) {
    this.viewers.delete(v);
    if (!this.viewers.size) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { if (!this.viewers.size) this.close('idle'); }, this.mgr.idleMs);
      if (this.idleTimer.unref) this.idleTimer.unref();
    }
  }

  ownedBy(owner) { return this.owner === owner; }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    this.gen++;
    clearTimeout(this.idleTimer);
    clearInterval(this.watchTimer);
    for (const s of this.slots) {
      if (s.client && s.up) { try { s.up.detach(s.client); } catch { /* gone */ } }
      if (s.client) s.client.release();
      else if (s.up && s.held) s.up.unpend();
      s.client = null;
      s.held = false;
    }
    this.stopFfmpeg();
    for (const v of this.viewers) v.end();
    this.viewers.clear();
    if (this.mgr.jobs.get(this.id) === this) this.mgr.jobs.delete(this.id);
    log(`[compose ${this.id}] closed (${reason})`);
  }

  summary() {
    return {
      id: this.id, kind: this.spec.kind, res: this.spec.res, tiles: this.spec.cells.length, viewers: this.viewers.size, state: this.state, encoder: this.encoder,
      seconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      inputs: this.slots.map((s) => ({ screen: s.ci + 1, provider: s.cell.p, sid: s.cell.sid, state: s.inFfmpeg ? 'live' : s.state, why: s.inFfmpeg ? '' : s.why, resyncs: s.client && s.client.resyncs ? s.client.resyncs : 0 })),
    };
  }
}

class Compose {
  constructor(relay, opts = {}) {
    this.relay = relay;
    this.jobs = new Map();
    this.idleMs = opts.idleMs !== undefined ? opts.idleMs : 8000;
    this.gateMs = opts.gateMs !== undefined ? opts.gateMs : 8000;       // how long to wait for inputs before starting without them
    this.watchMs = opts.watchMs !== undefined ? opts.watchMs : 3000;
    this.recheckMs = opts.recheckMs !== undefined ? opts.recheckMs : 10000;
    this.minRebuildMs = opts.minRebuildMs !== undefined ? opts.minRebuildMs : 15000;
    this.queueSeconds = opts.queueSeconds;
    this.queueMin = opts.queueMin;
    // 0 switches the feature off; text or negative values fall back to the default
    this.max = { compose: intEnv('COMPOSE_MAX', 2), tile: intEnv('TRANSCODE_MAX', 2) };
    this.allowCpuTile = process.env.TRANSCODE_ALLOW_CPU === '1';
    this.specs = new Map(); // id -> { spec, at }: lets a player that reconnects after the job ended start it again
  }

  remember(spec) {
    this.specs.set(spec.id, { spec, at: Date.now() });
    if (this.specs.size > 200) for (const [k, v] of this.specs) if (Date.now() - v.at > 30 * 60 * 1000) this.specs.delete(k);
  }

  specFor(id) {
    const v = this.specs.get(id);
    return v ? v.spec : null;
  }

  info() {
    const e = encoderInfo();
    return {
      ffmpeg: ffmpegVersion(),
      encoder: e.encoder, setting: e.want, vaapiDevice: e.vaapiDevice, vaapiPresent: e.vaapiPresent,
      max: this.max, allowCpuTranscode: this.allowCpuTile,
      jobs: [...this.jobs.values()].map((j) => j.summary()),
    };
  }

  encoderFor(kind) {
    const enc = encoderInfo().encoder;
    if (kind === 'tile' && enc === 'x264' && !this.allowCpuTile) {
      throw httpError(503, 'Per-tile transcoding needs a GPU encoder (pass /dev/dri into the container, or set TRANSCODE_ALLOW_CPU=1 to use the CPU)', 'needs_gpu');
    }
    return enc;
  }

  // A new request from the same viewer (same account and device) replaces that viewer's previous shared screen
  // instead of competing with it for a COMPOSE_MAX slot.
  replaceFor(owner, spec) {
    if (spec.kind !== 'compose') return;
    for (const j of [...this.jobs.values()]) {
      if (j.spec.kind === 'compose' && j.id !== spec.id && !j.closed && owner && j.ownedBy(owner)) j.close('replaced by a newer request from the same viewer');
    }
  }

  // The job for this description (shared by everyone who asks for the same picture); throws when the limit is reached.
  acquire(spec, owner) {
    let job = this.jobs.get(spec.id);
    if (job && !job.closed) return job;
    this.encoderFor(spec.kind); // refuse early (before opening provider connections)
    if (this.max[spec.kind] === 0) {
      const what = spec.kind === 'tile' ? 'TRANSCODE_MAX=0 disables 480p tile transcoding on this server' : 'COMPOSE_MAX=0 disables the shared screen on this server';
      throw httpError(503, what, 'compose_disabled');
    }
    if (owner) this.replaceFor(owner, spec);
    const n = [...this.jobs.values()].filter((j) => j.spec.kind === spec.kind && !j.closed).length;
    if (n >= this.max[spec.kind]) {
      throw httpError(503, spec.kind === 'tile' ? `Already transcoding ${n} channel(s) (limit ${this.max.tile})` : `Already composing ${n} shared screen(s) (limit ${this.max.compose})`, 'compose_limit');
    }
    job = new Job(this, spec);
    job.owner = owner || '';
    this.jobs.set(spec.id, job);
    // a job nobody ever attaches to must not linger
    job.idleTimer = setTimeout(() => { if (!job.viewers.size && !job.readyP) job.close('never used'); }, 15000);
    if (job.idleTimer.unref) job.idleTimer.unref();
    return job;
  }

  get(id) { return this.jobs.get(id); }

  // Try an encoder for a couple of seconds on a test picture.
  test(encoder) {
    const e = encoderInfo();
    const enc = ['x264', 'vaapi', 'nvenc'].includes(encoder) ? encoder : e.encoder;
    return new Promise((resolve) => {
      const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
      if (enc === 'vaapi') a.push('-vaapi_device', vaapiDevice());
      a.push('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-t', '2');
      if (enc === 'vaapi') a.push('-vf', 'format=nv12,hwupload');
      a.push(...encoderArgs(enc, 2800), '-f', 'null', '-');
      const t0 = Date.now();
      let tail = '';
      let done = false;
      const child = spawn(FFMPEG, a, { stdio: ['ignore', 'ignore', 'pipe'] });
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ encoder: enc, ...r }); };
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ ok: false, message: 'Timed out after 20 seconds' }); }, 20000);
      child.stderr.on('data', (d) => { tail = (tail + d).slice(-1500); });
      child.on('error', (err) => finish({ ok: false, message: err.code === 'ENOENT' ? 'ffmpeg is not installed in this container' : err.message }));
      child.on('close', (code) => {
        const ms = Date.now() - t0;
        finish(code === 0 ? { ok: true, ms, message: `2 seconds of 720p encoded in ${(ms / 1000).toFixed(1)} s` } : { ok: false, ms, message: shortReason(tail) || `ffmpeg exit ${code}` });
      });
    });
  }

  closeAll() { for (const j of [...this.jobs.values()]) j.close('shutdown'); }
}

module.exports = { Compose, Job, PipeClient, NullClient, cleanSpec, ffmpegArgs, canvasOf, shortReason, intEnv, RES };
