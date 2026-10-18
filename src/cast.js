'use strict';
// Casting to a Google device (Chromecast, Google TV): the TV fetches the video itself, so it cannot use the page's login.
// The page asks for a cast link (a long random token, valid for 6 hours) and hands its URL to the Cast receiver.
// The link serves a fragmented MP4 (H.264 copied as is, audio re-encoded to AAC), made from either one channel's relay
// stream or the multiview's shared-screen picture.
const crypto = require('crypto');
const { spawn } = require('child_process');
const { httpError } = require('./config');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const TTL = 6 * 3600 * 1000;
const MAX_PENDING = 64 * 1024 * 1024;

class Cast {
  constructor(relay, compose) {
    this.relay = relay;
    this.compose = compose;
    this.tokens = new Map();
    this.active = 0;
  }

  create(entry) {
    for (const [k, v] of this.tokens) if (v.expires < Date.now()) this.tokens.delete(k);
    const token = crypto.randomBytes(18).toString('base64url');
    this.tokens.set(token, { ...entry, expires: Date.now() + TTL });
    return token;
  }

  get(token) {
    const v = this.tokens.get(token);
    return v && v.expires > Date.now() ? v : null;
  }

  // Streams the cast link `entry` into the HTTP response `res`.
  async serve(req, res, entry) {
    let source = null; // { detach() }
    let child = null;
    let gone = false;
    const cleanup = () => {
      if (gone) return;
      gone = true;
      this.active--;
      if (source) { try { source.detach(); } catch { /* gone */ } }
      if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    this.active++;
    res.on('close', cleanup);
    const feed = { dead: false };
    const start = () => {
      child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', '+genpts+discardcorrupt', '-i', 'pipe:0', '-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-flush_packets', '1', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let tail = '';
      child.stderr.on('data', (d) => { tail = (tail + d).slice(-1500); });
      child.stdin.on('error', () => {});
      child.on('error', () => { if (!res.headersSent) res.destroy(); });
      child.on('close', (code) => { if (code && !gone) log(`[cast] ffmpeg exit ${code}: ${tail.trim().split('\n').slice(-2).join(' | ')}`); if (!res.destroyed) res.end(); });
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'none', 'X-Accel-Buffering': 'no' });
      child.stdout.pipe(res);
      return child.stdin;
    };
    const push = (stdin, chunk) => {
      if (gone || stdin.destroyed) return;
      if (stdin.writableLength > MAX_PENDING) { cleanup(); res.destroy(); return; }
      stdin.write(chunk);
    };
    if (entry.kind === 'channel') {
      const up = await this.relay.open(entry.p, entry.sid, { failover: true, sd: false });
      if (gone) { up.unpend(); return; }
      const stdin = start();
      const client = { grace() {}, send: (c) => push(stdin, c), end: () => { try { stdin.end(); } catch { /* closed */ } } };
      source = { detach: () => up.detach(client) };
      up.attach(client, 3);
      log(`[cast] ${entry.p}/${entry.sid} -> ${req.socket.remoteAddress}`);
    } else {
      const job = this.compose.acquire(entry.spec, entry.owner);
      let stdin = null;
      const viewer = { owner: entry.owner, send: (c) => { if (stdin) push(stdin, c); }, end: () => { try { if (stdin) stdin.end(); } catch { /* closed */ } } };
      job.addViewer(viewer);
      source = { detach: () => job.removeViewer(viewer) };
      try { await job.ready(); } catch (e) { cleanup(); throw httpError(e.status || 502, e.message); }
      if (gone) return;
      stdin = start();
      log(`[cast] multiview ${entry.spec.id} -> ${req.socket.remoteAddress}`);
    }
  }
}

module.exports = { Cast };
