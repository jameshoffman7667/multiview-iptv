'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Config, httpError } = require('./config');
const { Lists } = require('./lists');
const { Epg } = require('./epg');
const capture = require('./capture');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { Relay, Client } = require('./relay');
const { emptyDir } = require('./rewind');
const { Compose, cleanSpec } = require('./compose');
const { Recordings } = require('./recordings');
const { Cast } = require('./cast');
const xtream = require('./xtream');
const { Users, Views } = require('./users');
const { isUpgrade: isWsUpgrade, handshake: wsHandshake, WsSink } = require('./ws');

const MB = 1024 * 1024;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

function createApp(options = {}) {
  const dataDir = options.dataDir || env('DATA_DIR', path.join(__dirname, '..', 'data'));
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, '..', 'public'));
  const basicAuth = options.basicAuth !== undefined ? options.basicAuth : env('BASIC_AUTH', '');
  const config = new Config(dataDir);
  const lists = new Lists(config, dataDir);
  const epg = new Epg(config, lists);
  const seriesCache = new Map(); // "provider:id" -> { at, info }
  const users = new Users(dataDir);
  const views = new Views(dataDir);
  const adminUser = options.adminUser !== undefined ? options.adminUser : env('ADMIN_USER', '');
  const adminPass = options.adminPassword !== undefined ? options.adminPassword : env('ADMIN_PASSWORD', '');
  if (!users.enabled && adminUser && adminPass) {
    try { users.create({ username: adminUser, password: adminPass, role: 'admin' }); } catch (e) { console.error('ADMIN_USER/ADMIN_PASSWORD ignored: ' + e.message); }
  }
  const streamsByUser = new Map(); // username -> Set<res>
  const failures = new Map();      // ip -> { n, until }
  // Rewind buffer: the newest REWIND_MINUTES of every open channel, on disk in REWIND_DIR (put it on a fast disk).
  const rewindMinutes = options.rewindMinutes !== undefined ? options.rewindMinutes : (Number.isFinite(Number(env('REWIND_MINUTES', 60))) ? Math.max(0, Math.min(240, Number(env('REWIND_MINUTES', 60)))) : 60);
  const rewindDir = options.rewindDir || env('REWIND_DIR', path.join(dataDir, 'rewind'));
  if (rewindMinutes > 0) { try { emptyDir(rewindDir); } catch (e) { console.error(`[rewind] cannot use ${rewindDir}: ${e.message}`); } }
  const relay = new Relay(config, lists, {
    ringBytes: Number(env('RING_MB', 32)) * MB,
    rewindDir,
    rewindMs: rewindMinutes * 60 * 1000,
    idleMs: Number(env('IDLE_SECONDS', 8)) * 1000,
    stallMs: Number(env('STALL_SECONDS', 15)) * 1000,
    ...(options.relay || {}),
  });
  const compose = new Compose(relay, { ...(options.compose || {}), idleMs: options.composeIdleMs !== undefined ? options.composeIdleMs : Number(env('COMPOSE_IDLE_SECONDS', 8)) * 1000 });
  // Recordings and downloads live in REC_DIR (keep it on a large, slow disk). Kept until deleted.
  const recDir = options.recDir || env('REC_DIR', path.join(dataDir, 'recordings'));
  const recordings = new Recordings({ dir: recDir, dataDir, relay, config, lists, epg, tickMs: options.recTickMs || 10000 });
  const cast = new Cast(relay, compose);
  const maxQueue = (options.maxClientQueueMB !== undefined ? options.maxClientQueueMB : Number(env('CLIENT_QUEUE_MB', 8))) * MB;

  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  };

  function authorised(req) {
    if (!basicAuth) return true;
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const given = Buffer.from(h.slice(6), 'base64');
    const want = Buffer.from(basicAuth);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }

  // ---- accounts. With no accounts configured the app is open and everyone is an admin (as before).
  function cookieToken(req) {
    const m = /(?:^|;\s*)mv_sid=([^;]+)/.exec(req.headers.cookie || '');
    return m ? m[1] : '';
  }
  function whoIs(req) {
    if (!users.enabled) return { username: '', role: 'admin', open: true };
    return users.userForToken(cookieToken(req));
  }
  function setCookie(req, res, token, maxAgeSec) {
    const secure = req.socket.encrypted || /https/i.test(req.headers['x-forwarded-proto'] || '');
    res.setHeader('Set-Cookie', `mv_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
  }
  function kickUser(username) {
    const set = streamsByUser.get(username);
    if (set) for (const r of [...set]) r.destroy();
  }
  function needAdmin(me) {
    if (!me) throw httpError(401, 'Login required', 'login_required');
    if (me.role !== 'admin') throw httpError(403, 'Admins only', 'forbidden');
  }
  function sameOrigin(req) {
    const o = req.headers.origin;
    if (!o) return true;
    try { return new URL(o).host === req.headers.host; } catch { return false; }
  }

  function sendJson(req, res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj));
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (body.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
      const z = zlib.gzipSync(body);
      headers['Content-Length'] = z.length;
      res.writeHead(status, headers);
      return res.end(z);
    }
    headers['Content-Length'] = body.length;
    res.writeHead(status, headers);
    res.end(body);
  }

  function readJson(req, limit = 200 * 1024) {
    return new Promise((resolve, reject) => {
      const parts = [];
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > limit) { reject(httpError(413, 'Request too large')); req.destroy(); return; }
        parts.push(c);
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { reject(httpError(400, 'Body is not valid JSON')); }
      });
      req.on('error', reject);
    });
  }

  // ---- streams (shared by plain HTTP and WebSocket delivery)
  const streamErrors = new Map(); // "user|provider|sid" -> { error, message, at }: lets the page learn why a WebSocket stream closed
  const errKey = (me, p, sid) => `${me && me.username ? me.username : ''}|${p}|${sid}`;
  function noteStreamError(me, p, sid, d) {
    streamErrors.set(errKey(me, p, sid), { error: d.error, message: d.message, at: Date.now() });
    if (streamErrors.size > 500) for (const [k, v] of streamErrors) if (Date.now() - v.at > 60000) streamErrors.delete(k);
  }

  function streamDenied(me, providerId, sid) {
    if (!me) return { status: 401, error: 'login_required', message: 'Login required' };
    if (me.role !== 'admin' && !views.allows(me, providerId, sid)) {
      return { status: 403, error: 'not_allowed', message: 'That channel is not in a multiview shared with you' };
    }
    if (me.username && me.maxStreams > 0) {
      const mine = streamsByUser.get(me.username);
      if (mine && mine.size >= me.maxStreams) return { status: 429, error: 'user_limit', message: `Your account allows ${me.maxStreams} streams at once` };
    }
    return null;
  }

  function relayDenied(e) {
    let status = e.status || 502;
    if (e.limit) status = 503;
    else if (status === 401 || status === 403) status = 502; // provider-side refusals are not ours to relay
    return { status, error: e.limit ? 'provider_limit' : (e.code || 'stream_failed'), message: e.message };
  }

  // Attach `sink` (an HTTP response or a WebSocket) to the shared upstream. Throws { deny } when refused.
  async function runStream(me, providerId, sid, sink, { burst, failover, sd, begin, back = 0 }) {
    const denied = streamDenied(me, providerId, sid);
    if (denied) { const e = new Error(denied.message); e.deny = denied; throw e; }
    let mine = null;
    if (me.username) {
      mine = streamsByUser.get(me.username);
      if (!mine) { mine = new Set(); streamsByUser.set(me.username, mine); }
      mine.add(sink);
    }
    const client = new Client(sink, maxQueue);
    let up = null;
    let attached = false;
    let gone = false;
    sink.on('close', () => {
      gone = true;
      if (mine) { mine.delete(sink); if (!mine.size) streamsByUser.delete(me.username); }
      if (up) { if (attached) up.detach(client); else up.unpend(); }
    });
    try {
      up = await relay.open(providerId, sid, { failover, sd });
    } catch (e) {
      up = null;
      if (gone) return;
      e.deny = relayDenied(e);
      throw e;
    }
    if (gone) { up.unpend(); return; }
    begin(up);
    if (back > 0 && up.rewind && up.rewind.available() > 1) {
      // rewind: send the stored video from `back` seconds ago, then join the live stream without a gap
      try {
        await up.rewind.replay({ sink, back, info: up.info, gone: () => gone || sink.destroyed, attach() { if (gone) return; attached = true; up.attach(client, 0); } });
      } catch (e) { log(`[rewind] ${up.key}: ${e.message}`); if (!sink.destroyed) sink.destroy(); }
      return;
    }
    attached = true;
    up.attach(client, burst);
  }

  async function handleStream(req, res, url, m, me) {
    const providerId = decodeURIComponent(m[1]);
    const sid = decodeURIComponent(m[2]);
    const burst = Math.max(0, Math.min(300, Number(url.searchParams.get('buf')) || 0));
    const failover = url.searchParams.get('failover') !== '0';
    const sd = url.searchParams.get('q') === 'sd';
    const back = Math.max(0, Math.min(14400, Number(url.searchParams.get('back')) || 0));
    try {
      await runStream(me, providerId, sid, res, {
        back,
        burst,
        failover,
        sd,
        begin(up) {
          if (res.socket) res.socket.setNoDelay(true);
          res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Cache-Control': 'no-store',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'X-Relay-Provider': up.provider.id,
          });
        },
      });
    } catch (e) {
      if (!e.deny) throw e;
      sendJson(req, res, e.deny.status, { error: e.deny.error, message: e.deny.message });
    }
  }

  // ---- shared screen / per-tile transcode: one ffmpeg output, delivered like a normal stream
  const denyOf = (status, error, message) => Object.assign(new Error(message), { deny: { status, error, message } });
  const ownerOf = (req, me) => `${me && me.username || ''}|${req.socket && req.socket.remoteAddress || ''}`;
  async function runCompose(me, id, sink, begin, owner) {
    if (!me) throw denyOf(401, 'login_required', 'Login required');
    const spec = compose.specFor(id);
    if (!spec) throw denyOf(404, 'gone', 'This shared screen has ended - reload the page');
    for (const c of spec.cells) {
      const d = streamDenied(me, c.p, c.sid);
      if (d) throw denyOf(d.status, d.error, d.message);
    }
    let job;
    try { job = compose.acquire(spec, owner); } catch (e) { console.log(`[compose] refused ${spec.id}: ${e.message}`); throw denyOf(e.status || 502, e.code || 'compose_failed', e.message); }
    let mine = null;
    if (me.username) {
      mine = streamsByUser.get(me.username);
      if (!mine) { mine = new Set(); streamsByUser.set(me.username, mine); }
      mine.add(sink);
    }
    const client = new Client(sink, maxQueue);
    let started = false;
    const viewer = { send(c) { if (started) client.send(c); }, end() { client.end(); } };
    job.addViewer(viewer);
    sink.on('close', () => {
      if (mine) { mine.delete(sink); if (!mine.size) streamsByUser.delete(me.username); }
      job.removeViewer(viewer);
    });
    try {
      await job.ready();
    } catch (e) {
      job.removeViewer(viewer);
      throw denyOf(e.status || 502, e.limit ? 'provider_limit' : (e.code || 'compose_failed'), e.message);
    }
    if (sink.destroyed) return;
    begin();
    started = true;
  }

  async function handleComposeStream(req, res, m, me) {
    try {
      await runCompose(me, decodeURIComponent(m[1]), res, () => {
        if (res.socket) res.socket.setNoDelay(true);
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      }, ownerOf(req, me));
    } catch (e) {
      if (!e.deny) throw e;
      sendJson(req, res, e.deny.status, { error: e.deny.error, message: e.deny.message });
    }
  }

  // ---- movies and episodes: a range-capable pass-through. Each one holds a provider connection slot while it plays.
  const vodResponses = new Set(); // { providerId, res }
  function killVod(providerId) { for (const v of [...vodResponses]) if (v.providerId === providerId) v.res.destroy(); }
  const VOD_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', ts: 'video/mp2t', avi: 'video/x-msvideo', mov: 'video/quicktime' };

  async function handleVod(req, res, url, m, me) {
    if (!me) throw httpError(401, 'Login required', 'login_required');
    const providerId = decodeURIComponent(m[1]);
    const fm = /^(movie|series):([A-Za-z0-9_-]{1,40})\.([a-z0-9]{1,5})$/.exec(decodeURIComponent(m[2]));
    if (!fm) throw httpError(404, 'Not found');
    const sid = `${fm[1]}:${fm[2]}`;
    if (me.role !== 'admin' && !views.allows(me, providerId, sid)) throw httpError(403, 'That title is not in a multiview shared with you', 'not_allowed');
    const prov = config.get(providerId);
    if (!prov || !prov.enabled || prov.type === 'local') throw httpError(404, 'Unknown or disabled provider');
    const release = relay.acquireVod(prov, sid); // throws a 503 when the provider is full
    const ac = new AbortController();
    const rec = { providerId, res };
    vodResponses.add(rec);
    let mine = null;
    if (me.username) { mine = streamsByUser.get(me.username); if (!mine) { mine = new Set(); streamsByUser.set(me.username, mine); } mine.add(res); }
    res.on('close', () => {
      ac.abort();
      release();
      vodResponses.delete(rec);
      if (mine) { mine.delete(res); if (!mine.size) streamsByUser.delete(me.username); }
    });
    const headers = { 'User-Agent': xtream.ua(prov), Accept: '*/*' };
    if (req.headers.range) headers.Range = req.headers.range;
    let up;
    try {
      up = await fetch(xtream.vodUrl(prov, fm[1], fm[2], fm[3]), { headers, signal: ac.signal, redirect: 'follow' });
    } catch (e) {
      if (res.destroyed) return;
      throw httpError(502, `Could not reach ${prov.name}: ${(e.cause && e.cause.code) || e.message}`);
    }
    if (!up.ok) throw httpError(up.status === 404 ? 404 : 502, `${prov.name} answered HTTP ${up.status} for this title`);
    const out = { 'Content-Type': VOD_TYPES[fm[3]] || 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    for (const k of ['content-length', 'content-range']) if (up.headers.get(k)) out[k] = up.headers.get(k);
    if (url.searchParams.get('dl') === '1') out['Content-Disposition'] = `attachment; filename="${(url.searchParams.get('name') || sid).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 80)}.${fm[3]}"`;
    res.writeHead(up.status, out);
    await pipeline(Readable.fromWeb(up.body), res).catch(() => {});
  }

  async function handleWs(req, socket) {
    const url = new URL(req.url, 'http://localhost');
    const m = /^\/ws\/stream\/([^/]+)\/([^/]+?)(?:\.ts)?$/.exec(url.pathname);
    const cm = /^\/ws\/compose\/([A-Za-z0-9]{8,32})$/.exec(url.pathname);
    const refuse = (status, text) => { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if ((!m && !cm) || !isWsUpgrade(req)) return refuse(404, 'Not Found');
    if (!authorised(req)) return refuse(401, 'Unauthorized');
    if (!sameOrigin(req)) return refuse(403, 'Forbidden');
    const me = whoIs(req);
    if (!me) return refuse(401, 'Unauthorized');
    if (cm) {
      wsHandshake(req, socket);
      const csink = new WsSink(socket);
      try {
        await runCompose(me, cm[1], csink, () => {}, ownerOf(req, me));
      } catch (e) {
        if (!e.deny) { console.error(e); return csink.close(1011, 'error'); }
        csink.close(1011, e.deny.error);
      }
      return;
    }
    const providerId = decodeURIComponent(m[1]);
    const sid = decodeURIComponent(m[2]);
    wsHandshake(req, socket);
    const sink = new WsSink(socket);
    try {
      await runStream(me, providerId, sid, sink, {
        burst: Math.max(0, Math.min(300, Number(url.searchParams.get('buf')) || 0)),
        failover: url.searchParams.get('failover') !== '0',
        sd: url.searchParams.get('q') === 'sd',
        back: Math.max(0, Math.min(14400, Number(url.searchParams.get('back')) || 0)),
        begin() {},
      });
    } catch (e) {
      if (!e.deny) { console.error(e); return sink.close(1011, 'error'); }
      noteStreamError(me, providerId, sid, e.deny);
      sink.close(1011, e.deny.error);
    }
  }

  async function handleAuthApi(req, res, url, me) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/me') {
      return sendJson(req, res, 200, {
        authRequired: users.enabled,
        user: me && !me.open ? { username: me.username, role: me.role } : null,
        admin: !!me && me.role === 'admin',
        open: !users.enabled,
      });
    }
    if (req.method === 'POST' && p === '/api/login') {
      const ip = req.socket.remoteAddress || '?';
      const f = failures.get(ip);
      if (f && f.until > Date.now()) throw httpError(429, 'Too many wrong passwords. Try again in a few minutes.', 'too_many');
      const body = await readJson(req);
      const u = users.verify(body.username, body.password);
      if (!u) {
        const n = ((f && f.n) || 0) + 1;
        failures.set(ip, { n, until: n >= 8 ? Date.now() + 5 * 60 * 1000 : 0 });
        if (n >= 8) failures.set(ip, { n: 0, until: Date.now() + 5 * 60 * 1000 });
        throw httpError(401, 'Wrong username or password', 'bad_login');
      }
      failures.delete(ip);
      setCookie(req, res, users.login(u), 30 * 24 * 3600);
      return sendJson(req, res, 200, { user: { username: u.username, role: u.role } });
    }
    if (req.method === 'POST' && p === '/api/logout') {
      users.logout(cookieToken(req));
      if (me && me.username) kickUser(me.username);
      setCookie(req, res, '', 0);
      return sendJson(req, res, 200, { ok: true });
    }
    return null;
  }

  async function handleUsersApi(req, res, url, me) {
    const p = url.pathname;
    const um = /^\/api\/users(?:\/([^/]+))?$/.exec(p);
    if (!um) return null;
    // First account on an open server: whoever is using the open server becomes the admin and is logged in.
    if (req.method === 'POST' && !um[1] && !users.enabled) {
      const body = await readJson(req);
      const u = users.create({ username: body.username, password: body.password, role: 'admin' });
      setCookie(req, res, users.login(u), 30 * 24 * 3600);
      return sendJson(req, res, 200, { users: users.list(), user: { username: u.username, role: u.role } });
    }
    needAdmin(me);
    const name = um[1] ? decodeURIComponent(um[1]) : '';
    if (req.method === 'GET' && !name) return sendJson(req, res, 200, { users: users.list() });
    if (req.method === 'POST' && !name) {
      users.create(await readJson(req));
      return sendJson(req, res, 200, { users: users.list() });
    }
    if (req.method === 'PUT' && name) {
      const patch = await readJson(req);
      const u = users.update(name, patch);
      if (patch.password || u.disabled || patch.role) kickUser(u.username);
      return sendJson(req, res, 200, { users: users.list() });
    }
    if (req.method === 'DELETE' && name) {
      if (me.username && me.username.toLowerCase() === name.toLowerCase()) throw httpError(400, 'You cannot delete the account you are using');
      const u = users.remove(name);
      kickUser(u.username);
      return sendJson(req, res, 200, { users: users.list() });
    }
    throw httpError(404, 'Not found');
  }

  async function handleViewsApi(req, res, url, me) {
    const vm = /^\/api\/views(?:\/([^/]+))?$/.exec(url.pathname);
    if (!vm) return null;
    if (!me) throw httpError(401, 'Login required', 'login_required');
    const id = vm[1] ? decodeURIComponent(vm[1]) : '';
    if (req.method === 'GET' && !id) {
      const admin = me.role === 'admin';
      return sendJson(req, res, 200, {
        views: views.visible(me).map((v) => ({ id: v.id, name: v.name, layout: v.layout, tiles: v.tiles, mode: v.mode || 'layout', stream: v.stream || undefined, rev: v.rev, updated: v.updated, users: admin ? v.users : undefined })),
      });
    }
    needAdmin(me);
    if (req.method === 'POST' && !id) {
      const v = views.create(await readJson(req));
      return sendJson(req, res, 200, { view: v });
    }
    if (req.method === 'PUT' && id) return sendJson(req, res, 200, { view: views.update(id, await readJson(req)) });
    if (req.method === 'DELETE' && id) { views.remove(id); return sendJson(req, res, 200, { ok: true }); }
    throw httpError(404, 'Not found');
  }

  // ---- recordings and downloads
  async function handleRecordingsApi(req, res, url, me) {
    if (!me) throw httpError(401, 'Login required', 'login_required');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/recordings') {
      const u = recordings.usage();
      return sendJson(req, res, 200, { items: recordings.list(me), usage: { bytes: u.bytes, free: u.free, dir: me.role === 'admin' ? u.dir : undefined } });
    }
    if (req.method === 'GET' && p === '/api/recordings/event') {
      const ev = await recordings.eventNow(url.searchParams.get('p') || '', url.searchParams.get('sid') || '');
      return sendJson(req, res, 200, { event: ev });
    }
    if (req.method === 'POST' && p === '/api/recordings') {
      const body = await readJson(req);
      const pid = String(body.p || '');
      const sid = String(body.sid || '');
      if (me.role !== 'admin' && !views.allows(me, pid, sid)) throw httpError(403, 'That title is not in a multiview shared with you', 'not_allowed');
      return sendJson(req, res, 200, { item: await recordings.create(me, body) });
    }
    const m = /^\/api\/recordings\/([a-f0-9]{12})(?:\/(stop|update))?$/.exec(p);
    if (!m) throw httpError(404, 'Not found');
    const it = recordings.get(m[1], me);
    if (!it) throw httpError(404, 'No such recording');
    if (req.method === 'DELETE' && !m[2]) { recordings.remove(it.id); return sendJson(req, res, 200, { ok: true }); }
    if (req.method === 'POST' && m[2] === 'stop') return sendJson(req, res, 200, { item: recordings.stop(it.id, 'done') });
    if (req.method === 'POST' && m[2] === 'update') return sendJson(req, res, 200, { item: recordings.update(it.id, await readJson(req)) });
    throw httpError(405, 'Not allowed');
  }

  // GET /recordings/<id>.mp4 (?dl=1 to download): a file with range support, playable while it is still growing
  function handleRecordingFile(req, res, url, id, me) {
    if (!me) throw httpError(401, 'Login required', 'login_required');
    const it = recordings.get(id, me);
    if (!it || !it.file) throw httpError(404, 'No such recording');
    const file = recordings.pathOf(it);
    let st;
    try { st = fs.statSync(file); } catch { throw httpError(404, 'The file is gone'); }
    const ext = path.extname(it.file).toLowerCase();
    const type = ext === '.mp4' || ext === '.m4v' ? 'video/mp4' : ext === '.mkv' ? 'video/x-matroska' : ext === '.webm' ? 'video/webm' : 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (url.searchParams.get('dl') === '1') headers['Content-Disposition'] = `attachment; filename="${it.file.replace(/[^A-Za-z0-9._ -]/g, '_')}"`;
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const rm = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (rm && (rm[1] || rm[2])) {
      if (rm[1]) { start = Number(rm[1]); if (rm[2]) end = Math.min(end, Number(rm[2])); } else { start = Math.max(0, st.size - Number(rm[2])); }
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }

  async function handleCast(req, res, token) {
    const entry = cast.get(token);
    if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('This cast link has expired'); }
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
    try {
      await cast.serve(req, res, entry);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      sendJson(req, res, e.status || 502, { error: e.code || 'cast_failed', message: e.message });
    }
  }

  async function handleApi(req, res, url, me) {
    const p = url.pathname;
    const handled = (await handleAuthApi(req, res, url, me)) !== null ? true : false;
    if (handled) return;
    if (/^\/api\/users(\/|$)/.test(p)) return handleUsersApi(req, res, url, me);
    if (/^\/api\/views(\/|$)/.test(p)) return handleViewsApi(req, res, url, me);
    if (req.method === 'GET' && p === '/api/stream-error') {
      if (!me) throw httpError(401, 'Login required', 'login_required');
      const k = errKey(me, url.searchParams.get('p') || '', url.searchParams.get('sid') || '');
      const v = streamErrors.get(k);
      streamErrors.delete(k);
      return sendJson(req, res, 200, v && Date.now() - v.at < 30000 ? { error: v.error, message: v.message } : {});
    }
    if (req.method === 'GET' && p === '/api/epg') {
      if (!me) throw httpError(401, 'Login required', 'login_required');
      const prov = config.get(url.searchParams.get('provider') || '');
      if (!prov || prov.type === 'local') return sendJson(req, res, 200, { programmes: {}, available: false });
      let sids = String(url.searchParams.get('sids') || '').split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z0-9_-]{1,40}$/.test(x)).slice(0, 200);
      if (me.role !== 'admin') sids = sids.filter((x) => views.allows(me, prov.id, x));
      const now = Math.floor(Date.now() / 1000);
      const from = Number(url.searchParams.get('from')) || now - 1800;
      const to = Math.min(Number(url.searchParams.get('to')) || from + 3 * 3600, from + 36 * 3600);
      const progs = await epg.forChannels(prov, sids, from, to);
      if (url.searchParams.get('desc') !== '1') for (const k of Object.keys(progs)) progs[k] = progs[k].map((x) => [x[0], x[1], x[2]]);
      const entry = epg.data.get(prov.id);
      return sendJson(req, res, 200, { from, to, available: !!(entry && entry.ok) || Object.values(progs).some((l) => l.length), programmes: progs });
    }
    if (/^\/api\/recordings(\/|$)/.test(p)) return handleRecordingsApi(req, res, url, me);
    if (req.method === 'POST' && p === '/api/cast') {
      if (!me) throw httpError(401, 'Login required', 'login_required');
      const body = await readJson(req);
      const owner = ownerOf(req, me);
      if (body.mode === 'multiview') {
        const spec = cleanSpec(body.spec);
        for (const c of spec.cells) { const d = streamDenied(me, c.p, c.sid); if (d && d.error !== 'user_limit') throw httpError(d.status, d.message, d.error); }
        compose.encoderFor(spec.kind);
        const token = cast.create({ kind: 'multiview', spec, owner });
        return sendJson(req, res, 200, { url: `/cast/${token}.mp4`, title: 'Multiview', contentType: 'video/mp4' });
      }
      const pid = String(body.p || '');
      const sid = String(body.sid || '');
      if (!config.get(pid) || !/^[A-Za-z0-9_:-]{1,40}$/.test(sid)) throw httpError(400, 'Bad channel');
      const d = streamDenied(me, pid, sid);
      if (d && d.error !== 'user_limit') throw httpError(d.status, d.message, d.error);
      const token = cast.create({ kind: 'channel', p: pid, sid, owner });
      return sendJson(req, res, 200, { url: `/cast/${token}.mp4`, title: lists.nameOf(pid, sid) || sid, contentType: 'video/mp4' });
    }
    const rw = /^\/api\/rewind\/([^/]+)\/([^/]+)$/.exec(p);
    if (rw && req.method === 'GET') {
      if (!me) throw httpError(401, 'Login required', 'login_required');
      const up = relay.find(decodeURIComponent(rw[1]), decodeURIComponent(rw[2]));
      return sendJson(req, res, 200, { seconds: up && up.rewind ? up.rewind.available() : 0, max: rewindMinutes * 60 });
    }
    if (req.method === 'POST' && p === '/api/compose') {
      if (!me) throw httpError(401, 'Login required', 'login_required');
      const spec = cleanSpec(await readJson(req));
      for (const c of spec.cells) {
        const d = streamDenied(me, c.p, c.sid);
        if (d) throw httpError(d.status, d.message, d.error);
      }
      compose.acquire(spec, ownerOf(req, me)); // refuses now (limit, or a transcode that needs a GPU) rather than on the first frame
      compose.remember(spec);
      return sendJson(req, res, 200, { id: spec.id, kind: spec.kind, res: spec.res, stream: `/stream/compose/${spec.id}.ts`, ws: `/ws/compose/${spec.id}` });
    }
    needAdmin(me);
    if (req.method === 'GET' && p === '/api/compose/info') return sendJson(req, res, 200, compose.info());
    if (req.method === 'POST' && p === '/api/compose/test') {
      const body = await readJson(req);
      return sendJson(req, res, 200, await compose.test(String(body.encoder || '')));
    }
    if (req.method === 'GET' && p === '/api/state') {
      return sendJson(req, res, 200, relay.state());
    }
    if (req.method === 'GET' && p === '/api/providers') {
      return sendJson(req, res, 200, { providers: config.providers.map((x) => config.view(x)) });
    }
    if (req.method === 'PUT' && p === '/api/providers') {
      const body = await readJson(req);
      const { removed, changed } = config.replace(body.providers);
      for (const id of removed) { relay.closeProvider(id, 'provider removed'); killVod(id); lists.forget(id); epg.forget(id); views.forgetProvider(id); }
      for (const id of changed) { relay.closeProvider(id, 'provider changed'); killVod(id); lists.forget(id); epg.forget(id); }
      lists.preload();
      return sendJson(req, res, 200, { providers: config.providers.map((x) => config.view(x)) });
    }
    if (req.method === 'POST' && p === '/api/providers/test') {
      const body = await readJson(req);
      try {
        const prov = config.forTest(body.provider || {});
        if (prov.type === 'local') {
          const d = capture.listDevices();
          if (!d.ffmpeg) return sendJson(req, res, 200, { ok: false, error: 'ffmpeg is not installed in this container' });
          const missing = prov.sources.filter((x) => x.video !== 'test' && !d.video.some((v) => v.path === x.video)).map((x) => x.video);
          if (missing.length) return sendJson(req, res, 200, { ok: false, error: `Not visible inside the container: ${missing.join(', ')} (add it under "devices:" in the stack)` });
          return sendJson(req, res, 200, { ok: true, status: `${prov.sources.length} source(s), ${d.ffmpeg.split(' ').slice(0, 3).join(' ')}`, maxConnections: 0, activeConnections: 0, expires: null });
        }
        const info = await xtream.userInfo(prov);
        return sendJson(req, res, 200, { ok: true, ...info });
      } catch (e) {
        return sendJson(req, res, 200, { ok: false, error: e.message });
      }
    }
    if (req.method === 'GET' && p === '/api/devices') return sendJson(req, res, 200, capture.listDevices());
    if (req.method === 'GET' && (p === '/api/vod' || p === '/api/series')) {
      const prov = config.get(url.searchParams.get('provider') || '');
      if (!prov || prov.type === 'local') throw httpError(404, 'Unknown provider');
      if (p === '/api/vod') {
        const kind = url.searchParams.get('kind') === 'series' ? 'series' : 'movie';
        const e = await lists.get(prov, url.searchParams.get('refresh') === '1', kind);
        return sendJson(req, res, 200, { provider: prov.id, kind, updated: e.updated, categories: e.categories, items: e.channels });
      }
      const id = url.searchParams.get('id') || '';
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw httpError(400, 'Bad series id');
      const k = `${prov.id}:${id}`;
      let hit = seriesCache.get(k);
      if (!hit || Date.now() - hit.at > 30 * 60 * 1000) {
        hit = { at: Date.now(), info: await xtream.seriesInfo(prov, id) };
        seriesCache.set(k, hit);
        if (seriesCache.size > 300) seriesCache.delete(seriesCache.keys().next().value);
      }
      return sendJson(req, res, 200, hit.info);
    }
    if (req.method === 'GET' && p === '/api/epg-search') {
      const prov = config.get(url.searchParams.get('provider') || '');
      if (!prov || prov.type === 'local') throw httpError(404, 'Unknown provider');
      return sendJson(req, res, 200, await epg.search(prov, url.searchParams.get('q') || ''));
    }
    if (req.method === 'GET' && p === '/api/channels') {
      const prov = config.get(url.searchParams.get('provider') || '');
      if (!prov) throw httpError(404, 'Unknown provider');
      const e = await lists.get(prov, url.searchParams.get('refresh') === '1');
      return sendJson(req, res, 200, { provider: prov.id, updated: e.updated, categories: e.categories, channels: e.channels });
    }
    throw httpError(404, 'Not found');
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      const ext = path.extname(file).toLowerCase();
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': rel.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      };
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
      const castM = /^\/cast\/([A-Za-z0-9_-]{20,40})\.mp4$/.exec(url.pathname);
      if (castM && (req.method === 'GET' || req.method === 'OPTIONS')) return await handleCast(req, res, castM[1]);
      if (!authorised(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="IPTV Multiview", charset="UTF-8"', 'Content-Type': 'text/plain' });
        return res.end('Login required');
      }
      const me = whoIs(req);
      const cm = /^\/stream\/compose\/([A-Za-z0-9]{8,32})(?:\.ts)?$/.exec(url.pathname);
      if (cm && req.method === 'GET') return await handleComposeStream(req, res, cm, me);
      const sm = /^\/stream\/([^/]+)\/([^/]+?)(?:\.ts)?$/.exec(url.pathname);
      if (sm && req.method === 'GET') return await handleStream(req, res, url, sm, me);
      const rfm = /^\/recordings\/([a-f0-9]{12})\.[a-z0-9]{2,5}$/.exec(url.pathname);
      if (rfm && (req.method === 'GET' || req.method === 'HEAD')) return handleRecordingFile(req, res, url, rfm[1], me);
      const vm = /^\/vod\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (vm && req.method === 'GET') return await handleVod(req, res, url, vm, me);
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          if (!sameOrigin(req)) throw httpError(403, 'Cross-site request refused', 'forbidden');
          if (!/^application\/json/i.test(req.headers['content-type'] || '') && req.headers['content-length'] !== '0' && req.method !== 'DELETE') {
            throw httpError(415, 'Send JSON', 'bad_type');
          }
        }
        return await handleApi(req, res, url, me);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, url);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      sendJson(req, res, e.status || 500, { error: e.code || 'error', message: e.message });
      if (!e.status) console.error(e);
    }
  });
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    handleWs(req, socket).catch((e) => { console.error(e); socket.destroy(); });
  });
  server.keepAliveTimeout = 30000;

  function close() {
    users.flush();
    compose.closeAll();
    recordings.closeAll();
    relay.closeAll();
    server.close();
    server.closeAllConnections();
  }

  return { server, config, lists, relay, compose, recordings, cast, users, views, epg, close };
}

module.exports = { createApp };

if (require.main === module) {
  let app;
  try {
    app = createApp();
  } catch (e) {
    if (e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS')) {
      const dir = env('DATA_DIR', path.join(__dirname, '..', 'data'));
      console.error(`\nCannot write to the data folder ${dir} (${e.code}).\n` +
        `The app runs as user ${typeof process.getuid === 'function' ? process.getuid() : '?'}. Make the folder writable for that user,\n` +
        `for example:  chown -R 1000:1000 <host folder mounted at /data>\n`);
      process.exit(1);
    }
    throw e;
  }
  const port = Number(env('PORT', 1234));
  app.server.listen(port, '0.0.0.0', () => {
    console.log(`IPTV Multiview listening on :${port} (${app.config.providers.length} provider(s))`);
    if (!app.users.enabled && !env('BASIC_AUTH', '')) console.log('Note: no logins yet, so anyone who can reach this port is an admin. Create the first account in the app (Users), or set ADMIN_USER and ADMIN_PASSWORD.');
    app.lists.preload();
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { app.close(); setTimeout(() => process.exit(0), 200); });
}
