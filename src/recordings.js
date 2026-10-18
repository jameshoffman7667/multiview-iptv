'use strict';
// Recordings of live channels (now or scheduled) and downloads of movies/episodes, kept as files in REC_DIR.
//  - A recording attaches to the relay's connection for that channel (so it shares it with any viewer) and an ffmpeg
//    process copies the video and re-encodes only the audio to AAC into a fragmented MP4 that can be played while it grows.
//  - A download streams the provider's movie/episode file as it is.
// Items are kept until the user deletes them. The list is stored in recordings.json in the data folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const xtream = require('./xtream');
const { httpError } = require('./config');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const PAD_BEFORE = 5 * 60 * 1000;   // scheduled live events start 5 minutes early
const PAD_AFTER = 60 * 60 * 1000;   // and end 60 minutes late (sports overtime)
const MAX_PENDING = 128 * 1024 * 1024;

const clean = (s) => String(s || '').replace(/[^A-Za-z0-9._ -]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'recording';
const stamp = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

// What the relay sees as a viewer: writes into ffmpeg's stdin.
class FeedClient {
  constructor(stream, onEnd) { this.stream = stream; this.onEnd = onEnd; this.dead = false; stream.on('error', () => {}); }
  grace() {}
  send(chunk) {
    if (this.dead || this.stream.destroyed) return;
    if (this.stream.writableLength > MAX_PENDING) { this.dead = true; this.onEnd('disk or encoder too slow'); return; }
    this.stream.write(chunk);
  }
  end() { if (!this.dead) { this.dead = true; this.onEnd('the channel stopped'); } }
}

class Recordings {
  constructor({ dir, dataDir, relay, config, lists, epg, tickMs = 10000 }) {
    this.dir = dir;
    this.file = path.join(dataDir, 'recordings.json');
    this.relay = relay;
    this.config = config;
    this.lists = lists;
    this.epg = epg;
    this.items = new Map();
    this.live = new Map(); // id -> { child, up, client, ac, release }
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { log(`[recordings] cannot use ${dir}: ${e.message}`); }
    this.load();
    this.timer = setInterval(() => this.tick(), tickMs);
    if (this.timer.unref) this.timer.unref();
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const it of j.items || []) this.items.set(it.id, it);
    } catch { /* first run */ }
    for (const it of this.items.values()) {
      if (it.status === 'recording' || it.status === 'downloading') {
        // the server stopped while this was running: keep what was written
        it.size = this.sizeOf(it);
        it.status = it.size > 0 ? 'done' : 'failed';
        it.error = 'The server restarted while this was running';
      }
    }
    this.save();
  }

  save() {
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ items: [...this.items.values()] }));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (e) { log(`[recordings] cannot save the list: ${e.message}`); }
  }

  sizeOf(it) { try { return it.file ? fs.statSync(path.join(this.dir, it.file)).size : 0; } catch { return 0; } }
  pathOf(it) { return it.file ? path.join(this.dir, it.file) : ''; }

  list(me) {
    const mine = [...this.items.values()].filter((it) => !me || me.role === 'admin' || it.owner === (me.username || ''));
    for (const it of mine) if (it.status === 'recording' || it.status === 'downloading') it.size = this.sizeOf(it);
    return mine.sort((a, b) => b.start - a.start);
  }

  get(id, me) {
    const it = this.items.get(id);
    if (!it) return null;
    if (me && me.role !== 'admin' && it.owner !== (me.username || '')) return null;
    return it;
  }

  // The programme on a channel right now, with the time a recording "to the end of the event" would stop.
  async eventNow(p, sid) {
    const prov = this.config.get(p);
    if (!prov || prov.type === 'local') return null;
    const now = Math.floor(Date.now() / 1000);
    let progs = [];
    try { progs = ((await this.epg.forChannels(prov, [String(sid)], now - 3600, now + 4 * 3600))[String(sid)]) || []; } catch { /* no guide */ }
    const cur = progs.find((x) => x[0] <= now && x[1] > now);
    if (!cur) return null;
    return { title: cur[2] || '', start: cur[0] * 1000, stop: cur[1] * 1000, recordUntil: cur[1] * 1000 + PAD_AFTER };
  }

  async create(me, body) {
    const owner = me && me.username || '';
    const kind = body.kind === 'download' ? 'download' : 'live';
    const prov = this.config.get(String(body.p || ''));
    if (!prov || !prov.enabled) throw httpError(404, 'Unknown or disabled provider');
    const sid = String(body.sid || '');
    if (!/^[A-Za-z0-9_:-]{1,40}$/.test(sid)) throw httpError(400, 'Bad channel');
    const now = Date.now();
    const it = { id: crypto.randomBytes(6).toString('hex'), kind, owner, p: prov.id, sid, name: String(body.name || sid).slice(0, 120), title: '', start: now, end: now, status: 'scheduled', file: '', size: 0, error: '', created: now };
    if (kind === 'download') {
      const m = /^(movie|series):([A-Za-z0-9_-]{1,40})$/.exec(sid);
      if (!m) throw httpError(400, 'Only movies and episodes can be downloaded');
      it.vodKind = m[1];
      it.vodId = m[2];
      it.ext = String(body.ext || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4';
      it.title = it.name;
      it.end = now;
      it.status = 'queued';
    } else {
      const mode = String(body.mode || 'minutes');
      if (mode === 'event') {
        const ev = await this.eventNow(prov.id, sid);
        if (!ev) throw httpError(409, 'No programme guide data for this channel right now - choose a length instead', 'no_guide');
        it.title = ev.title;
        it.start = now;
        it.end = ev.recordUntil;
      } else if (mode === 'programme') {
        const s = Number(body.start) * 1000;
        const e = Number(body.stop) * 1000;
        if (!(s > 0 && e > s) || e < now) throw httpError(400, 'Bad programme times');
        it.title = String(body.title || '').slice(0, 120);
        it.start = Math.max(now, s - PAD_BEFORE);
        it.end = e + PAD_AFTER;
        it.scheduledFor = s;
      } else {
        const minutes = Math.floor(Number(body.minutes));
        if (!(minutes >= 1 && minutes <= 24 * 60)) throw httpError(400, 'Choose between 1 minute and 24 hours');
        it.start = now;
        it.end = now + minutes * 60000;
      }
    }
    this.items.set(it.id, it);
    this.save();
    log(`[recordings] ${it.id} ${it.kind} ${prov.id}/${sid} "${it.title || it.name}" ${it.kind === 'live' ? `${new Date(it.start).toISOString()} -> ${new Date(it.end).toISOString()}` : ''}`);
    this.tick();
    return it;
  }

  tick() {
    const now = Date.now();
    for (const it of this.items.values()) {
      if (it.status === 'scheduled' && now >= it.start) {
        if (now >= it.end) { this.finish(it, 'failed', 'The server was not running when this was due'); continue; }
        this.begin(it);
      } else if (it.status === 'queued') this.beginDownload(it);
      else if (it.status === 'recording' && now >= it.end) this.stop(it.id, 'done');
    }
  }

  fileFor(it) {
    const base = `${clean(it.title || it.name)} ${stamp(it.start)} ${it.id.slice(0, 4)}`;
    return `${base}.${it.kind === 'download' ? it.ext : 'mp4'}`;
  }

  finish(it, status, error = '') {
    it.status = status;
    it.error = error;
    it.size = this.sizeOf(it);
    this.live.delete(it.id);
    this.save();
  }

  async begin(it) {
    if (this.live.has(it.id)) return;
    const rec = { child: null, up: null, client: null };
    this.live.set(it.id, rec);
    it.status = 'recording';
    it.file = this.fileFor(it);
    it.error = '';
    this.save();
    let up;
    try {
      up = await this.relay.open(it.p, it.sid, { failover: true });
    } catch (e) {
      this.finish(it, 'failed', e.limit ? `No free provider connection at start time: ${e.message}` : e.message);
      log(`[recordings] ${it.id} could not start: ${e.message}`);
      return;
    }
    if (this.live.get(it.id) !== rec) { up.unpend(); return; } // stopped or deleted meanwhile
    const out = this.pathOf(it);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', '+genpts+discardcorrupt', '-i', 'pipe:0', '-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-y', out];
    const child = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let tail = '';
    child.stderr.on('data', (d) => { tail = (tail + d).slice(-1500); });
    child.on('error', (e) => { tail = e.code === 'ENOENT' ? 'ffmpeg is not installed in this container' : e.message; });
    child.on('close', (code) => {
      if (this.live.get(it.id) !== rec) return;
      if (rec.client) up.detach(rec.client);
      const wrote = this.sizeOf(it) > 0;
      const why = tail.split('\n').filter(Boolean).slice(-2).join(' | ') || `ffmpeg exit ${code}`;
      this.finish(it, wrote ? 'done' : 'failed', wrote ? it.error : why);
      log(`[recordings] ${it.id} finished (${it.status}, ${Math.round(it.size / 1048576)} MB)`);
    });
    rec.child = child;
    rec.up = up;
    rec.client = new FeedClient(child.stdin, (why) => { if (this.live.get(it.id) === rec) { it.error = why; this.stop(it.id, 'done'); } });
    up.attach(rec.client, 2);
    log(`[recordings] ${it.id} recording ${it.p}/${it.sid} to ${it.file}`);
  }

  async beginDownload(it) {
    if (this.live.has(it.id)) return;
    const prov = this.config.get(it.p);
    const rec = { ac: new AbortController(), release: null };
    this.live.set(it.id, rec);
    if (!prov || !prov.enabled) { this.finish(it, 'failed', 'Provider is gone or disabled'); return; }
    try {
      rec.release = this.relay.acquireVod(prov, it.sid);
    } catch (e) {
      // a busy provider: try again in a little while instead of failing
      this.live.delete(it.id);
      it.error = `Waiting for a free provider connection (${e.message})`;
      return;
    }
    it.status = 'downloading';
    it.error = '';
    it.start = Date.now();
    it.file = this.fileFor(it);
    this.save();
    log(`[recordings] ${it.id} downloading ${it.sid} to ${it.file}`);
    let res;
    try {
      res = await fetch(xtream.vodUrl(prov, it.vodKind, it.vodId, it.ext), { headers: { 'User-Agent': xtream.ua(prov), Accept: '*/*' }, signal: rec.ac.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`${prov.name} answered HTTP ${res.status}`);
      it.total = Number(res.headers.get('content-length')) || 0;
      const ws = fs.createWriteStream(this.pathOf(it));
      rec.ws = ws;
      await new Promise((resolve, reject) => {
        Readable.fromWeb(res.body).on('error', reject).pipe(ws).on('finish', resolve).on('error', reject);
      });
      if (this.live.get(it.id) === rec) this.finish(it, 'done');
    } catch (e) {
      if (this.live.get(it.id) === rec) this.finish(it, it.status === 'stopped' ? 'stopped' : 'failed', it.status === 'stopped' ? '' : (e.cause && e.cause.code) || e.message);
    } finally {
      if (rec.release) rec.release();
    }
    log(`[recordings] ${it.id} download ${it.status} (${Math.round(it.size / 1048576)} MB)`);
  }

  // End a running recording/download (keeping what was saved) or cancel a scheduled one.
  stop(id, status = 'stopped') {
    const it = this.items.get(id);
    if (!it) return null;
    const rec = this.live.get(id);
    if (it.status === 'scheduled' || it.status === 'queued') { this.finish(it, 'stopped', ''); return it; }
    if (!rec) return it;
    if (it.kind === 'download') { it.status = 'stopped'; rec.ac.abort(); if (rec.ws) rec.ws.destroy(); this.finish(it, 'stopped', ''); return it; }
    // the ffmpeg close handler sets the final state once ffmpeg has written everything
    if (rec.up && rec.client) { rec.up.detach(rec.client); rec.client.dead = true; }
    if (rec.child) { try { rec.child.stdin.end(); } catch { /* closed */ } }
    else this.finish(it, 'done');
    return it;
  }

  update(id, body) {
    const it = this.items.get(id);
    if (!it) return null;
    if (it.kind === 'live' && (it.status === 'recording' || it.status === 'scheduled') && Number(body.end) > Date.now()) {
      it.end = Number(body.end);
      this.save();
    }
    return it;
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return false;
    if (this.live.has(id)) {
      const rec = this.live.get(id);
      this.live.delete(id);
      if (rec.up && rec.client) { rec.up.detach(rec.client); rec.client.dead = true; }
      if (rec.child) { try { rec.child.kill('SIGKILL'); } catch { /* gone */ } }
      if (rec.ac) rec.ac.abort();
      if (rec.ws) rec.ws.destroy();
      if (rec.release) rec.release();
    }
    if (it.file) { try { fs.unlinkSync(this.pathOf(it)); } catch { /* gone */ } }
    this.items.delete(id);
    this.save();
    return true;
  }

  usage() {
    let bytes = 0;
    for (const it of this.items.values()) bytes += this.sizeOf(it);
    let free = null;
    try { const st = fs.statfsSync(this.dir); free = st.bavail * st.bsize; } catch { /* old node */ }
    return { bytes, free, dir: this.dir };
  }

  closeAll() {
    clearInterval(this.timer);
    for (const id of [...this.live.keys()]) {
      const it = this.items.get(id);
      const rec = this.live.get(id);
      if (rec && rec.up && rec.client) { rec.up.detach(rec.client); rec.client.dead = true; }
      if (rec && rec.child) { try { rec.child.stdin.end(); } catch { /* closed */ } }
      if (rec && rec.ac) rec.ac.abort();
      if (it && it.status === 'recording') it.size = this.sizeOf(it);
    }
    this.save();
  }
}

module.exports = { Recordings, PAD_BEFORE, PAD_AFTER };
