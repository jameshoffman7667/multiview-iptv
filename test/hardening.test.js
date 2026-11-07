'use strict';
// Security headers, login lockout, clean shutdown, healthcheck, PWA files and the release workflow trigger (spec v1.9 checks).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createApp } = require('../src/server');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function get(base, p, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(new URL(p, base), { method, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const login = (base, username, password, headers) => get(base, '/api/login', { method: 'POST', body: { username, password }, headers });

function pngSize(file) {
  const b = fs.readFileSync(path.join(root, file));
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe('security headers and login lockout', () => {
  let app;
  let base;
  let dir;
  before(async () => {
    process.env.TRUST_PROXY = '1';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-hard-'));
    app = createApp({ dataDir: dir, basicAuth: '', adminUser: 'boss', adminPassword: 'hunter22' });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
  });
  after(() => {
    delete process.env.TRUST_PROXY;
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('every kind of response carries the security headers', async () => {
    for (const p of ['/', '/app.js', '/api/me', '/healthz', '/nope']) {
      const r = await get(base, p);
      const csp = r.headers['content-security-policy'] || '';
      assert.match(csp, /frame-ancestors 'none'/, p);
      assert.match(csp, /script-src 'self' https:\/\/www\.gstatic\.com;/, p);
      assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, p);
      assert.match(csp, /object-src 'none'/, p);
      assert.equal(r.headers['x-frame-options'], 'DENY', p);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
      assert.equal(r.headers['referrer-policy'], 'no-referrer', p);
    }
  });

  test('the page has no inline scripts or handlers the policy would block', () => {
    for (const f of ['public/index.html', 'public/offline.html']) {
      const html = read(f);
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, f);
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, f);
    }
  });

  test('/healthz needs no login, sets no cookie and shows only status and version', async () => {
    const r = await get(base, '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.headers['set-cookie'], undefined);
    assert.deepEqual(JSON.parse(r.text), { status: 'ok', version: pkg.version });
  });

  test('wrong passwords lock out the account and the address, not other accounts or other addresses', async () => {
    const from = (ip) => ({ 'X-Forwarded-For': ip });
    // 8 wrong passwords for "boss" from one address
    for (let i = 0; i < 8; i++) assert.equal((await login(base, 'boss', 'wrong' + i, from('203.0.113.7'))).status, 401);
    // that address is now locked, even with the right password
    assert.equal((await login(base, 'boss', 'hunter22', from('203.0.113.7'))).status, 429);
    // the account is locked for everyone for a few minutes, from any address
    assert.equal((await login(base, 'boss', 'hunter22', from('198.51.100.9'))).status, 429);
    // a different address and account are untouched
    app.users.create({ username: 'alice', password: 'alicepw1', role: 'viewer' });
    assert.equal((await login(base, 'alice', 'alicepw1', from('198.51.100.9'))).status, 200);
    // the locked address cannot log in as alice either
    assert.equal((await login(base, 'alice', 'alicepw1', from('203.0.113.7'))).status, 429);
  });
});

describe('clean shutdown', () => {
  test('SIGTERM stops the server quickly with exit code 0 and a log line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-term-'));
    const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], { env: { ...process.env, PORT: '0', DATA_DIR: dir, BASIC_AUTH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    try {
      for (let i = 0; i < 100 && !/listening on/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
      assert.match(out, /listening on/);
      const t0 = Date.now();
      const exit = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
      child.kill('SIGTERM');
      const res = await exit;
      assert.equal(res.code, 0);
      assert.ok(Date.now() - t0 < 3000, 'exits in under 3 s');
      assert.match(out, /Received SIGTERM/);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('image, compose and release files', () => {
  test('the image runs under tini and its healthcheck follows $PORT and requires status ok', () => {
    const d = read('Dockerfile');
    assert.match(d, /apk add --no-cache tini /);
    assert.match(d, /ENTRYPOINT \["\/sbin\/tini", "--", "docker-entrypoint\.sh"\]/);
    assert.match(d, /HEALTHCHECK[^\n]*--start-period=30s/);
    assert.match(d, /http:\/\/127\.0\.0\.1:\$\{PORT\}\/healthz \| grep -q '"status":"ok"'/);
    assert.doesNotMatch(d, /localhost/);
  });

  test('compose and stack files carry the same healthcheck with a 30 s start period', () => {
    for (const f of ['docker-compose.yml', 'stack.yml', 'deploy/compose.yaml']) {
      const y = read(f);
      assert.match(y, /http:\/\/127\.0\.0\.1:\$\$\{PORT\}\/healthz \| grep -q '\\"status\\":\\"ok\\"'/, f);
      assert.match(y, /start_period: 30s/, f);
    }
  });

  test('manifest and icons are valid for installing the app', () => {
    const m = JSON.parse(read('public/manifest.webmanifest'));
    for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'background_color', 'theme_color']) assert.ok(m[k], k);
    assert.ok(['standalone', 'fullscreen', 'minimal-ui'].includes(m.display));
    const sizes = m.icons.map((i) => i.sizes);
    assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
    assert.ok(m.icons.some((i) => /maskable/.test(i.purpose || '')));
    for (const i of m.icons.filter((x) => x.type === 'image/png')) {
      const [w, h] = pngSize(i.src.replace(/^\//, 'public/'));
      assert.equal(`${w}x${h}`, i.sizes, i.src);
    }
    assert.deepEqual(pngSize('public/icons/apple-touch-icon.png'), [180, 180]);
    for (const s of m.screenshots || []) {
      const [w, h] = pngSize(s.src.replace(/^\//, 'public/'));
      assert.equal(`${w}x${h}`, s.sizes, s.src);
    }
  });

  test('the release workflow runs on a push to main that changes package.json, one at a time', () => {
    const w = read('.github/workflows/docker.yml');
    assert.match(w, /push:\s*\n\s*branches: \[main\]\s*\n\s*paths: \[package\.json\]/);
    assert.match(w, /concurrency:\s*\n\s*group: release\s*\n\s*cancel-in-progress: false/);
    assert.match(w, /gh release create/);
    assert.match(w, /--target "?\$GITHUB_SHA/);
  });

  test('the version in package.json matches the compose files, README and Android app', () => {
    assert.match(read('stack.yml'), new RegExp(`mybadreligon/multiview-iptv:${pkg.version.replace(/\./g, '\\.')}`));
    assert.match(read('android/app/build.gradle'), new RegExp(`-PappVersion=${pkg.version.replace(/\./g, '\\.')} `));
    assert.match(read('CHANGELOG.md'), new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')} - `, 'm'));
  });
});
