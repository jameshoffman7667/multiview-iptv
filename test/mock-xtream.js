'use strict';
// A fake Xtream Codes provider for tests: JSON API plus paced MPEG-TS "live" streams.
const http = require('http');

const PKT = 188;

function packet(pid, { pusi = false, rai = false, cc = 0, payload = Buffer.alloc(0) } = {}) {
  const b = Buffer.alloc(PKT, 0xff);
  b[0] = 0x47;
  b[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  b[2] = pid & 0xff;
  if (rai) {
    b[3] = 0x30 | (cc & 0x0f);
    b[4] = 1;
    b[5] = 0x40;
    payload.copy(b, 6, 0, Math.min(payload.length, PKT - 6));
  } else {
    b[3] = 0x10 | (cc & 0x0f);
    payload.copy(b, 4, 0, Math.min(payload.length, PKT - 4));
  }
  return b;
}

function pat() {
  const sec = Buffer.from([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe1, 0x00, 0, 0, 0, 0]);
  return packet(0, { pusi: true, payload: Buffer.concat([Buffer.from([0x00]), sec]) });
}

function pmt() {
  const sec = Buffer.from([0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00, 0x1b, 0xe1, 0x01, 0xf0, 0x00, 0, 0, 0, 0]);
  return packet(0x100, { pusi: true, payload: Buffer.concat([Buffer.from([0x00]), sec]) });
}

class MockProvider {
  constructor(opts = {}) {
    this.user = opts.user || 'u';
    this.pass = opts.pass || 'p';
    this.max = opts.max || 2;
    this.limitMode = opts.limitMode || 'http403'; // http403 | empty | none
    this.kbps = opts.kbps || 2000;
    this.channels = opts.channels || [
      { id: 1, name: 'US| ESPN HD', cat: '10' },
      { id: 2, name: 'US| CNN FHD', cat: '10' },
      { id: 3, name: 'UK| BBC One', cat: '20' },
    ];
    this.active = 0;
    this.peak = 0;
    this.opened = []; // stream ids in order of connection
    this.userAgents = [];
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
      this.port = this.server.address().port;
      this.url = `http://127.0.0.1:${this.port}`;
      resolve(this);
    }));
  }

  close() {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(r));
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    this.userAgents.push(req.headers['user-agent']);
    if (url.pathname === '/player_api.php') return this.api(url, res);
    const m = /^\/live\/([^/]+)\/([^/]+)\/(.+)\.ts$/.exec(url.pathname);
    if (m) return this.stream(m[1], m[2], m[3], res);
    res.writeHead(404);
    res.end();
  }

  api(url, res) {
    const ok = url.searchParams.get('username') === this.user && url.searchParams.get('password') === this.pass;
    const action = url.searchParams.get('action');
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!ok) return send({ user_info: { auth: 0 } });
    if (!action) return send({ user_info: { auth: 1, status: 'Active', max_connections: String(this.max), active_cons: String(this.active), exp_date: '1893456000' }, server_info: {} });
    if (action === 'get_live_categories') return send([{ category_id: '10', category_name: 'US' }, { category_id: '20', category_name: 'UK' }]);
    if (action === 'get_live_streams') return send(this.channels.map((c) => ({ stream_id: c.id, name: c.name, category_id: c.cat, stream_icon: '', stream_type: 'live' })));
    send([]);
  }

  stream(user, pass, id, res) {
    if (user !== this.user || pass !== this.pass) { res.writeHead(401); return res.end(); }
    this.opened.push(id);
    if (id === '404') { res.writeHead(404); return res.end(); }
    if (id === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>nope</html>'); }
    if (id === 'empty') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(); }
    if (this.limitMode === 'http403' && this.active >= this.max) { res.writeHead(403); return res.end(); }
    if (this.limitMode === 'empty' && this.active >= this.max) { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(); }
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    if (this.files && this.files[id]) return this.streamFile(this.files[id], res);
    let seq = 0;
    let tick = 0;
    const perTick = Math.max(8, Math.round((this.kbps * 1000 / 8) * 0.1 / PKT));
    const dropAfter = id === 'drop' ? 1500 : 0;
    const started = Date.now();
    let cc = 0;
    const timer = setInterval(() => {
      const parts = [];
      for (let i = 0; i < perTick; i++) {
        let pk;
        if (i === 0 && tick % 10 === 0) pk = pat();
        else if (i === 1 && tick % 10 === 0) pk = pmt();
        else {
          const key = i === 2 && tick % 10 === 0; // one keyframe per second
          const payload = Buffer.alloc(16);
          payload.writeUInt32BE(seq++, 0);
          pk = packet(0x101, { pusi: i === 2, rai: key, cc: cc++, payload });
        }
        parts.push(pk);
      }
      tick++;
      res.write(Buffer.concat(parts));
      if (dropAfter && Date.now() - started > dropAfter) { clearInterval(timer); res.destroy(); }
    }, 100);
    res.on('close', () => { clearInterval(timer); this.active--; });
  }
}

// Paced loop of a real .ts file (e.g. made with ffmpeg) at its own average bitrate.
MockProvider.prototype.streamFile = function streamFile(file, res) {
  const fs = require('fs');
  const data = fs.readFileSync(file.path);
  const perTick = Math.max(PKT, Math.floor((data.length / file.seconds) * 0.1 / PKT) * PKT);
  let pos = 0;
  const timer = setInterval(() => {
    if (pos >= data.length) pos = 0;
    res.write(data.subarray(pos, Math.min(data.length, pos + perTick)));
    pos += perTick;
  }, 100);
  res.on('close', () => { clearInterval(timer); this.active--; });
};

module.exports = { MockProvider, PKT, packet, pat, pmt };
