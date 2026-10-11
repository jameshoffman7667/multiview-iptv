'use strict';
// Server-side composing: one ffmpeg per "job" turns several relay streams into ONE video stream.
//  - kind 'compose': a whole multiview (up to 9 tiles) as a single picture for weak devices.
//  - kind 'tile':    one channel re-encoded to a lower resolution (a 1-tile job).
// A job only runs while somebody watches it. Decoding and scaling happen on the CPU; the encoder can be the GPU.
const crypto = require('crypto');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { httpError } = require('./config');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const RES = { 480: [854, 480, 1200], 720: [1280, 720, 2800], 1080: [1920, 1080, 5000] }; // width, height, kbps
const FPS = 25;
const SID_RE = /^[A-Za-z0-9_:-]{1,40}$/;
const even = (n) => Math.round(n) & ~1;

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
  const spec = { kind, res, cols, rows, cells, audio: audio >= 0 && audio < cells.length ? audio : -1 };
  spec.id = crypto.createHash('sha1').update(JSON.stringify([spec.kind, res, cols, rows, cells, spec.audio])).digest('hex').slice(0, 16);
  return spec;
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
function ffmpegArgs(spec, live, enc) {
  const [W, H, kbps] = RES[spec.res];
  const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (enc === 'vaapi') a.push('-vaapi_device', vaapiDevice());
  live.forEach((_, k) => a.push('-fflags', '+genpts+discardcorrupt', '-probesize', '2000000', '-analyzeduration', '1500000', '-i', `pipe:${3 + k}`));
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
    f.push(`[${k}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},setpts=PTS-STARTPTS[t${k}]`);
    f.push(`[${prev}][t${k}]overlay=${x0}:${y0}:eof_action=pass[o${k}]`);
    prev = `o${k}`;
  });
  f.push(enc === 'vaapi' ? `[${prev}]format=nv12,hwupload[vout]` : `[${prev}]null[vout]`);
  a.push('-filter_complex', f.join(';'), '-map', '[vout]');
  const ai = live.indexOf(spec.audio);
  if (ai >= 0) a.push('-map', `${ai}:a:0?`, '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-af', 'aresample=async=1000,asetpts=PTS-STARTPTS');
  else a.push('-an');
  a.push(...encoderArgs(enc, kbps));
  a.push('-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1', '-pat_period', '0.5', 'pipe:1');
  return a;
}

// What the relay sees as a viewer: it gets the channel's bytes and hands them to ffmpeg's input pipe.
class PipeClient {
  constructor(stream, onDrop) {
    this.stream = stream;
    this.onDrop = onDrop;
    this.dead = false;
    stream.on('error', () => {});
  }

  grace() {}

  send(chunk) {
    if (this.dead || this.stream.destroyed) return;
    if (this.stream.writableLength > 6 * 1024 * 1024) { this.end(); this.onDrop(); return; } // ffmpeg cannot keep up: black tile
    this.stream.write(chunk);
  }

  end() {
    if (this.dead) return;
    this.dead = true;
    try { this.stream.end(); } catch { /* closed */ }
  }
}

class Job {
  constructor(mgr, spec) {
    this.mgr = mgr;
    this.spec = spec;
    this.id = spec.id;
    this.viewers = new Set();
    this.inputs = [];
    this.child = null;
    this.state = 'idle'; // idle | starting | live | closed
    this.closed = false;
    this.startedAt = 0;
    this.err = '';
    this.encoder = '';
    this.readyP = null;
  }

  // Resolves when the first picture has been produced; rejects with an HTTP error when it cannot start.
  ready() {
    if (!this.readyP) {
      this.readyP = this.start();
      this.readyP.catch(() => {});
    }
    return this.readyP;
  }

  async start() {
    this.state = 'starting';
    const { relay } = this.mgr;
    const results = await Promise.all(this.spec.cells.map((c) =>
      relay.open(c.p, c.sid, { failover: true, sd: c.sd }).then((up) => ({ up }), (error) => ({ error }))));
    const live = [];
    results.forEach((r, i) => { if (r.up) live.push(i); });
    if (this.closed || !live.length) {
      for (const r of results) if (r.up) r.up.unpend();
      const first = results.find((r) => r.error);
      if (this.closed) throw httpError(499, 'cancelled');
      throw first && first.error ? first.error : httpError(502, 'No stream could be opened');
    }
    const enc = this.mgr.encoderFor(this.spec.kind);
    this.encoder = enc;
    const args = ffmpegArgs(this.spec, live, enc);
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe', ...live.map(() => 'pipe')] });
    this.child = child;
    let tail = '';
    child.stderr.on('data', (d) => { tail = (tail + d).slice(-2000); });
    child.on('error', (e) => { this.err = e.code === 'ENOENT' ? 'ffmpeg is not installed in this container' : e.message; });
    this.startedAt = Date.now();
    live.forEach((ci, k) => {
      const up = results[ci].up;
      const client = new PipeClient(child.stdio[3 + k], () => { log(`[compose ${this.id}] input ${ci} too slow; tile goes black`); up.detach(client); });
      this.inputs.push({ up, client });
      up.attach(client, 2);
    });
    log(`[compose ${this.id}] ${this.spec.kind} ${this.spec.res}p ${live.length}/${this.spec.cells.length} tiles, encoder ${enc}`);
    let gotData = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { fail(httpError(504, 'The composer produced no picture in time')); }, 25000);
      const fail = (e) => { clearTimeout(timer); this.close(e.message); reject(e); };
      child.stdout.on('data', (chunk) => {
        if (!gotData) { gotData = true; clearTimeout(timer); this.state = 'live'; resolve(); }
        for (const v of this.viewers) v.send(chunk);
      });
      child.on('close', (code) => {
        const why = this.err || tail.trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300) || `exit ${code}`;
        if (!gotData) { fail(httpError(502, `Composer failed: ${why}`, 'compose_failed')); return; }
        this.close(`ffmpeg ended (${why})`);
      });
    });
  }

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

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    clearTimeout(this.idleTimer);
    for (const { up, client } of this.inputs) { up.detach(client); client.end(); }
    this.inputs = [];
    if (this.child) { try { this.child.kill('SIGKILL'); } catch { /* gone */ } }
    for (const v of this.viewers) v.end();
    this.viewers.clear();
    if (this.mgr.jobs.get(this.id) === this) this.mgr.jobs.delete(this.id);
    log(`[compose ${this.id}] closed (${reason})`);
  }
}

class Compose {
  constructor(relay, opts = {}) {
    this.relay = relay;
    this.jobs = new Map();
    this.idleMs = opts.idleMs !== undefined ? opts.idleMs : 8000;
    this.max = {
      compose: Number(process.env.COMPOSE_MAX || 2),
      tile: Number(process.env.TRANSCODE_MAX || 2),
    };
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
      jobs: [...this.jobs.values()].map((j) => ({ id: j.id, kind: j.spec.kind, res: j.spec.res, tiles: j.spec.cells.length, viewers: j.viewers.size, state: j.state, encoder: j.encoder, seconds: j.startedAt ? Math.round((Date.now() - j.startedAt) / 1000) : 0 })),
    };
  }

  encoderFor(kind) {
    const enc = encoderInfo().encoder;
    if (kind === 'tile' && enc === 'x264' && !this.allowCpuTile) {
      throw httpError(503, 'Per-tile transcoding needs a GPU encoder (pass /dev/dri into the container, or set TRANSCODE_ALLOW_CPU=1 to use the CPU)', 'needs_gpu');
    }
    return enc;
  }

  // The job for this description (shared by everyone who asks for the same picture); throws when the limit is reached.
  acquire(spec) {
    let job = this.jobs.get(spec.id);
    if (job && !job.closed) return job;
    this.encoderFor(spec.kind); // refuse early (before opening provider connections)
    const n = [...this.jobs.values()].filter((j) => j.spec.kind === spec.kind && !j.closed).length;
    if (n >= this.max[spec.kind]) {
      throw httpError(503, spec.kind === 'tile' ? `Already transcoding ${n} channel(s) (limit ${this.max.tile})` : `Already composing ${n} shared screen(s) (limit ${this.max.compose})`, 'compose_limit');
    }
    job = new Job(this, spec);
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
        finish(code === 0 ? { ok: true, ms, message: `2 seconds of 720p encoded in ${(ms / 1000).toFixed(1)} s` } : { ok: false, ms, message: tail.trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300) || `ffmpeg exit ${code}` });
      });
    });
  }

  closeAll() { for (const j of [...this.jobs.values()]) j.close('shutdown'); }
}

module.exports = { Compose, cleanSpec, ffmpegArgs, RES };
