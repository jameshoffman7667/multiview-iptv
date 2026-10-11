'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Config, httpError } = require('./config');
const { Lists } = require('./lists');
const { Relay, Client } = require('./relay');
const xtream = require('./xtream');
const { Users, Views } = require('./users');

const MB = 1024 * 1024;
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

function createApp(options = {}) {
  const dataDir = options.dataDir || env('DATA_DIR', path.join(__dirname, '..', 'data'));
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, '..', 'public'));
  const basicAuth = options.basicAuth !== undefined ? options.basicAuth : env('BASIC_AUTH', '');
  const config = new Config(dataDir);
  const lists = new Lists(config, dataDir);
  const users = new Users(dataDir);
  const views = new Views(dataDir);
  const adminUser = options.adminUser !== undefined ? options.adminUser : env('ADMIN_USER', '');
  const adminPass = options.adminPassword !== undefined ? options.adminPassword : env('ADMIN_PASSWORD', '');
  if (!users.enabled && adminUser && adminPass) {
    try { users.create({ username: adminUser, password: adminPass, role: 'admin' }); } catch (e) { console.error('ADMIN_USER/ADMIN_PASSWORD ignored: ' + e.message); }
  }
  const streamsByUser = new Map(); // username -> Set<res>
  const failures = new Map();      // ip -> { n, until }
  const relay = new Relay(config, lists, {
    ringBytes: Number(env('RING_MB', 16)) * MB,
    idleMs: Number(env('IDLE_SECONDS', 8)) * 1000,
    stallMs: Number(env('STALL_SECONDS', 15)) * 1000,
    ...(options.relay || {}),
  });
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

  async function handleStream(req, res, url, m, me) {
    const providerId = decodeURIComponent(m[1]);
    const sid = decodeURIComponent(m[2]);
    if (!me) return sendJson(req, res, 401, { error: 'login_required', message: 'Login required' });
    if (me.role !== 'admin' && !views.allows(me, providerId, sid)) {
      return sendJson(req, res, 403, { error: 'not_allowed', message: 'That channel is not in a multiview shared with you' });
    }
    let mine = null;
    if (me.username) {
      mine = streamsByUser.get(me.username);
      if (!mine) { mine = new Set(); streamsByUser.set(me.username, mine); }
      if (me.maxStreams > 0 && mine.size >= me.maxStreams) {
        return sendJson(req, res, 429, { error: 'user_limit', message: `Your account allows ${me.maxStreams} streams at once` });
      }
      mine.add(res);
    }
    const burst = Math.max(0, Math.min(30, Number(url.searchParams.get('buf')) || 0));
    const failover = url.searchParams.get('failover') !== '0';
    const client = new Client(res, maxQueue);
    let up = null;
    let attached = false;
    let gone = false;
    res.on('close', () => {
      gone = true;
      if (mine) { mine.delete(res); if (!mine.size) streamsByUser.delete(me.username); }
      if (up) { if (attached) up.detach(client); else up.unpend(); }
    });
    try {
      up = await relay.open(providerId, sid, { failover });
    } catch (e) {
      up = null;
      if (gone) return;
      let status = e.status || 502;
      if (e.limit) status = 503;
      else if (status === 401 || status === 403) status = 502; // provider-side refusals are not ours to relay
      return sendJson(req, res, status, { error: e.limit ? 'provider_limit' : (e.code || 'stream_failed'), message: e.message });
    }
    if (gone) { up.unpend(); return; }
    if (res.socket) res.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Relay-Provider': up.provider.id,
    });
    attached = true;
    up.attach(client, burst);
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
        views: views.visible(me).map((v) => ({ id: v.id, name: v.name, layout: v.layout, tiles: v.tiles, rev: v.rev, updated: v.updated, users: admin ? v.users : undefined })),
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

  async function handleApi(req, res, url, me) {
    const p = url.pathname;
    const handled = (await handleAuthApi(req, res, url, me)) !== null ? true : false;
    if (handled) return;
    if (/^\/api\/users(\/|$)/.test(p)) return handleUsersApi(req, res, url, me);
    if (/^\/api\/views(\/|$)/.test(p)) return handleViewsApi(req, res, url, me);
    needAdmin(me);
    if (req.method === 'GET' && p === '/api/state') {
      return sendJson(req, res, 200, relay.state());
    }
    if (req.method === 'GET' && p === '/api/providers') {
      return sendJson(req, res, 200, { providers: config.providers.map((x) => config.view(x)) });
    }
    if (req.method === 'PUT' && p === '/api/providers') {
      const body = await readJson(req);
      const { removed, changed } = config.replace(body.providers);
      for (const id of removed) { relay.closeProvider(id, 'provider removed'); lists.forget(id); views.forgetProvider(id); }
      for (const id of changed) { relay.closeProvider(id, 'provider changed'); lists.forget(id); }
      lists.preload();
      return sendJson(req, res, 200, { providers: config.providers.map((x) => config.view(x)) });
    }
    if (req.method === 'POST' && p === '/api/providers/test') {
      const body = await readJson(req);
      try {
        const prov = config.forTest(body.provider || {});
        const info = await xtream.userInfo(prov);
        return sendJson(req, res, 200, { ok: true, ...info });
      } catch (e) {
        return sendJson(req, res, 200, { ok: false, error: e.message });
      }
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
      if (!authorised(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="IPTV Multiview", charset="UTF-8"', 'Content-Type': 'text/plain' });
        return res.end('Login required');
      }
      const me = whoIs(req);
      const sm = /^\/stream\/([^/]+)\/([^/]+?)(?:\.ts)?$/.exec(url.pathname);
      if (sm && req.method === 'GET') return await handleStream(req, res, url, sm, me);
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
  server.keepAliveTimeout = 30000;

  function close() {
    users.flush();
    relay.closeAll();
    server.close();
    server.closeAllConnections();
  }

  return { server, config, lists, relay, users, views, close };
}

module.exports = { createApp };

if (require.main === module) {
  const app = createApp();
  const port = Number(env('PORT', 8080));
  app.server.listen(port, '0.0.0.0', () => {
    console.log(`IPTV Multiview listening on :${port} (${app.config.providers.length} provider(s))`);
    if (!app.users.enabled && !env('BASIC_AUTH', '')) console.log('Note: no logins yet, so anyone who can reach this port is an admin. Create the first account in the app (Users), or set ADMIN_USER and ADMIN_PASSWORD.');
    app.lists.preload();
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { app.close(); setTimeout(() => process.exit(0), 200); });
}
