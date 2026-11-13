'use strict';
// Auto quality (P-29): the server tells the page which quality steps a channel has.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MockProvider } = require('./mock-xtream');
const { createApp } = require('../src/server');

function call(base, p, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: () => JSON.parse(Buffer.concat(parts).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('auto quality: /api/quality-options', () => {
  let prov; let app; let base; let dir; let admin; let viewer;
  before(async () => {
    prov = await new MockProvider({ user: 'u1', pass: 'pw1', max: 3, channels: [
      { id: 1, name: 'US| ESPN HD', cat: '10' }, { id: 2, name: 'US| CNN FHD', cat: '10' }, { id: 3, name: 'US| CNN SD', cat: '10' },
    ] }).listen();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-aq-'));
    app = createApp({ dataDir: dir, basicAuth: '', relay: { idleMs: 500 } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    await call(base, '/api/providers', 'PUT', { providers: [{ id: 'p1', name: 'One', url: prov.url, username: 'u1', password: 'pw1', maxConnections: 3 }] });
    await app.lists.get(app.config.get('p1'));
    const c = await call(base, '/api/users', 'POST', { username: 'boss', password: 'hunter22' });
    admin = c.headers['set-cookie'][0].split(';')[0];
    await call(base, '/api/users', 'POST', { username: 'guest', password: 'secret22' }, { Cookie: admin });
    const v = await call(base, '/api/login', 'POST', { username: 'guest', password: 'secret22' });
    viewer = v.headers['set-cookie'][0].split(';')[0];
  });
  after(async () => { app.close(); await prov.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('needs a login', async () => {
    assert.equal((await call(base, '/api/quality-options?p=p1&sid=2')).status, 401);
  });

  test('a channel with a lower version reports sd, one without does not; no GPU means no 480p step', async () => {
    const a = await call(base, '/api/quality-options?p=p1&sid=2', 'GET', null, { Cookie: admin });
    assert.equal(a.status, 200);
    assert.deepEqual(a.json(), { sd: true, tx: false });
    const b = await call(base, '/api/quality-options?p=p1&sid=1', 'GET', null, { Cookie: admin });
    assert.deepEqual(b.json(), { sd: false, tx: false });
  });

  test('unknown provider is 404 and a viewer without the channel is 403', async () => {
    assert.equal((await call(base, '/api/quality-options?p=nope&sid=1', 'GET', null, { Cookie: admin })).status, 404);
    assert.equal((await call(base, '/api/quality-options?p=p1&sid=2', 'GET', null, { Cookie: viewer })).status, 403);
  });
});
