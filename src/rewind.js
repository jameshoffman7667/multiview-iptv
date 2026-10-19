'use strict';
// Rewind buffer: everything a channel delivers while it is open is also written to disk in 10-second segments, and the
// newest REWIND_MINUTES of it are kept. A viewer who asks for ?back=N gets the stream from N seconds ago, then live.
const fs = require('fs');
const path = require('path');
const { PKT, findBurstStart } = require('./ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const FLUSH_BYTES = 512 * 1024;
const READ_CHUNK = 256 * 1024;
const HEAD_MS = 20000;

// Empties a directory but keeps the directory itself (it may be a bind or volume mount, which cannot be removed).
function emptyDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

class Rewind {
  constructor(dir, { segMs = 10000, maxMs = 60 * 60 * 1000 } = {}) {
    this.dir = dir;
    this.segMs = segMs;
    this.maxMs = maxMs;
    this.segs = []; // { n, file, t0, bytes (incl. pending), flushed }
    this.n = 0;
    this.fd = null;
    this.cur = null;
    this.pending = [];
    this.pendingBytes = 0;
    this.timer = null;
    this.dead = false;
    this.total = 0;
    try {
      emptyDir(dir);
    } catch (e) { this.fail(e); }
  }

  fail(e) {
    if (this.dead) return;
    this.dead = true;
    log(`[rewind] disabled for ${path.basename(this.dir)}: ${e.message}`);
    this.close();
  }

  write(buf) {
    if (this.dead) return;
    const now = Date.now();
    try {
      if (!this.cur || now - this.cur.t0 >= this.segMs) this.rotate(now);
      this.pending.push(buf);
      this.pendingBytes += buf.length;
      this.cur.bytes += buf.length;
      this.total += buf.length;
      if (this.pendingBytes >= FLUSH_BYTES) this.flush();
      else if (!this.timer) {
        this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 500);
        if (this.timer.unref) this.timer.unref();
      }
    } catch (e) { this.fail(e); }
  }

  rotate(now) {
    this.flush();
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* closed */ } this.fd = null; }
    const n = this.n++;
    const file = path.join(this.dir, `${n}.ts`);
    this.fd = fs.openSync(file, 'w');
    this.cur = { n, file, t0: now, bytes: 0, flushed: 0 };
    this.segs.push(this.cur);
    while (this.segs.length > 1 && now - this.segs[0].t0 > this.maxMs + this.segMs) {
      const old = this.segs.shift();
      try { fs.unlinkSync(old.file); } catch { /* gone */ }
    }
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.pendingBytes || this.fd === null || !this.cur) return;
    const data = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    try {
      fs.writeSync(this.fd, data);
      this.cur.flushed += data.length;
    } catch (e) { this.fail(e); }
  }

  // Seconds of video that can be rewound to.
  available() {
    if (this.dead || !this.segs.length) return 0;
    return Math.max(0, Math.floor((Date.now() - this.segs[0].t0) / 1000));
  }

  // Sends the stream from `back` seconds ago up to the live edge to `sink`, then calls attach() in the same tick as the
  // last byte so no data is lost or repeated. gone() says the viewer left.
  async replay({ sink, back, info, attach, gone }) {
    this.flush();
    const target = Date.now() - back * 1000;
    let i = this.segs.length - 1;
    while (i > 0 && this.segs[i].t0 > target) i--;
    let cur = this.segs[i];
    if (!cur) { attach(); return; }
    const sent = new Map();
    // start of the first segment: the keyframe nearest to the wanted moment
    const first = await this.readSeg(cur, 0, cur.flushed);
    const end = i + 1 < this.segs.length ? this.segs[i + 1].t0 : Date.now();
    const frac = Math.min(1, Math.max(0, (target - cur.t0) / Math.max(1, end - cur.t0)));
    const startPkt = first.length >= PKT ? findBurstStart(first, Math.floor((first.length / PKT) * frac), info) : 0;
    sent.set(cur, startPkt * PKT);
    // Pace the replay: send no more than HEAD_MS of video ahead of what the viewer has had time to play, otherwise a
    // viewer rewound by half an hour would receive (and hold in memory) the whole half hour at once.
    const began = Date.now();
    const origin = cur.t0;
    for (;;) {
      const due = cur.t0 - origin - HEAD_MS - (Date.now() - began);
      if (due > 0) {
        for (let w = due; w > 0 && !gone() && !sink.destroyed; w -= 200) await sleep(Math.min(200, w));
        if (gone() || sink.destroyed) return;
      }
      this.flush();
      await this.sendSeg(cur, sent, sink, gone);
      if (gone()) return;
      const k = this.segs.indexOf(cur);
      if (k < 0) { sink.end(); return; } // fell too far behind: the old data is already gone
      if (k + 1 < this.segs.length) { cur = this.segs[k + 1]; continue; }
      this.flush();
      const left = cur.flushed - (sent.get(cur) || 0);
      if (left > 2 * 1024 * 1024) continue; // a lot arrived while we were busy: go round again instead of blocking
      if (left > 0) {
        const tail = this.readSegSync(cur, sent.get(cur) || 0, cur.flushed);
        sink.write(tail);
      }
      attach();
      return;
    }
  }

  readSegSync(seg, from, to) {
    const fd = fs.openSync(seg.file, 'r');
    try {
      const buf = Buffer.alloc(Math.max(0, to - from));
      fs.readSync(fd, buf, 0, buf.length, from);
      return buf;
    } finally { fs.closeSync(fd); }
  }

  async readSeg(seg, from, to) {
    const fh = await fs.promises.open(seg.file, 'r');
    try {
      const buf = Buffer.alloc(Math.max(0, to - from));
      await fh.read(buf, 0, buf.length, from);
      return buf;
    } finally { await fh.close(); }
  }

  async sendSeg(seg, sent, sink, gone) {
    let from = sent.get(seg) || 0;
    from -= from % PKT;
    let fh;
    try { fh = await fs.promises.open(seg.file, 'r'); } catch { return; }
    try {
      for (;;) {
        const to = Math.min(seg.flushed, from + READ_CHUNK);
        if (to <= from) break;
        const buf = Buffer.alloc(to - from);
        await fh.read(buf, 0, buf.length, from);
        from = to;
        sent.set(seg, from);
        if (gone() || sink.destroyed) return;
        sink.write(buf);
        while (sink.writableLength > 1024 * 1024 && !gone() && !sink.destroyed) await sleep(20);
      }
    } finally { await fh.close(); }
  }

  close() {
    this.dead = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* closed */ } this.fd = null; }
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* gone */ }
    this.segs = [];
  }
}

module.exports = { Rewind, emptyDir };
