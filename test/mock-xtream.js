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
    this.noCategories = !!opts.noCategories;
    this.kbps = opts.kbps || 2000;
    this.channels = opts.channels || [
      { id: 1, name: 'US| ESPN HD', cat: '10' },
      { id: 2, name: 'US| CNN FHD', cat: '10' },
      { id: 3, name: 'UK| BBC One', cat: '20' },
    ];
    this.xmltv = opts.xmltv !== undefined ? opts.xmltv : true;  // serve /xmltv.php (false: 404, so get_short_epg is used)
    this.vodBytes = 100000;
    this.vodRequests = []; // Range headers seen on /movie and /series
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
    if (url.pathname === '/xmltv.php') return this.xmltvFile(url, res, req);
    const vm = /^\/(movie|series)\/([^/]+)\/([^/]+)\/(\d+)\.(\w+)$/.exec(url.pathname);
    if (vm) return this.vodFile(vm, req, res);
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
    if (action === 'get_live_categories') return send(this.noCategories ? [] : [{ category_id: '10', category_name: 'US' }, { category_id: '20', category_name: 'UK' }]);
    if (action === 'get_live_streams') return send(this.channels.map((c) => ({ stream_id: c.id, name: c.name, category_id: c.cat, stream_icon: '', stream_type: 'live', epg_channel_id: c.epg === undefined ? `ch${c.id}.test` : c.epg })));
    if (action === 'get_vod_categories') return send([{ category_id: '100', category_name: 'Action' }, { category_id: '200', category_name: 'Comedy' }]);
    if (action === 'get_vod_streams') return send([
      { stream_id: 501, name: 'Big Movie', category_id: '100', stream_icon: '', container_extension: 'mp4' },
      { stream_id: 502, name: 'Funny Film', category_id: '200', stream_icon: '', container_extension: 'mkv' },
    ]);
    if (action === 'get_series_categories') return send([{ category_id: '300', category_name: 'Drama' }]);
    if (action === 'get_series') return send([{ series_id: 700, name: 'Long Show', category_id: '300', cover: '' }]);
    if (action === 'get_series_info') {
      return send({ info: { name: 'Long Show' }, episodes: {
        1: [{ id: '9001', episode_num: 1, title: 'Pilot', container_extension: 'mp4', info: { duration_secs: 2700 } }, { id: '9002', episode_num: 2, title: 'Second', container_extension: 'mp4' }],
        2: [{ id: '9003', episode_num: 1, title: 'Return', container_extension: 'mkv' }],
      } });
    }
    if (action === 'get_short_epg') {
      const now = Math.floor(Date.now() / 1000);
      const b64 = (t) => Buffer.from(t).toString('base64');
      return send({ epg_listings: [
        { title: b64('Short Now'), description: b64('d'), start_timestamp: String(now - 600), stop_timestamp: String(now + 1200) },
        { title: b64('Short Next'), description: b64(''), start_timestamp: String(now + 1200), stop_timestamp: String(now + 3600) },
      ] });
    }
    send([]);
  }

  xmltvFile(url, res, req) {
    if (url.searchParams.get('username') !== this.user || url.searchParams.get('password') !== this.pass) { res.writeHead(401); return res.end(); }
    if (!this.xmltv) { res.writeHead(404); return res.end(); }
    const now = Math.floor(Date.now() / 1000);
    const fmt = (t) => { const d = new Date(t * 1000); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`; };
    let xml = '<?xml version="1.0" encoding="UTF-8"?><tv>';
    for (const c of this.channels) {
      const id = c.epg === undefined ? `ch${c.id}.test` : c.epg;
      if (!id) continue;
      xml += `<channel id="${id}"><display-name>${c.name}</display-name></channel>`;
      for (let i = -1; i < 4; i++) {
        const s = now - (now % 1800) + i * 1800;
        xml += `<programme start="${fmt(s)}" stop="${fmt(s + 1800)}" channel="${id}"><title lang="en">${i === 0 ? 'Now Show' : 'Show'} ${c.id}-${i + 1} &amp; Friends</title><desc>About &lt;it&gt;</desc></programme>`;
      }
    }
    xml += '</tv>';
    this.xmltvHits = (this.xmltvHits || 0) + 1;
    if (/gzip/.test(req.headers['accept-encoding'] || '') && this.xmltvGzip) {
      res.writeHead(200, { 'Content-Type': 'application/xml', 'Content-Encoding': 'gzip' });
      return res.end(require('zlib').gzipSync(xml));
    }
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xml);
  }

  // Deterministic bytes (byte i = i % 251) with Range support, like a movie file.
  vodFile(m, req, res) {
    if (m[2] !== this.user || m[3] !== this.pass) { res.writeHead(401); return res.end(); }
    this.vodRequests.push({ kind: m[1], id: m[4], ext: m[5], range: req.headers.range || '' });
    const total = this.vodBytes;
    let start = 0;
    let end = total - 1;
    let status = 200;
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
    if (r) {
      if (r[1] !== '') { start = Number(r[1]); if (r[2] !== '') end = Math.min(end, Number(r[2])); } else { start = Math.max(0, total - Number(r[2])); }
      if (start >= total) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    const body = Buffer.alloc(end - start + 1);
    for (let i = 0; i < body.length; i++) body[i] = (start + i) % 251;
    res.end(body);
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
  let timer = null;
  const begin = () => {
    timer = setInterval(() => {
      if (pos >= data.length) pos = 0;
      res.write(data.subarray(pos, Math.min(data.length, pos + perTick)));
      pos += perTick;
    }, 100);
  };
  // file.delayMs: the connection is open but no bytes arrive for a while (a provider that is slow to start a channel)
  const delay = typeof file.delayMs === 'function' ? file.delayMs() : (file.delayMs || 0);
  const starter = delay ? setTimeout(begin, delay) : (begin(), null);
  res.on('close', () => { clearInterval(timer); clearTimeout(starter); this.active--; });
};

module.exports = { MockProvider, PKT, packet, pat, pmt };
