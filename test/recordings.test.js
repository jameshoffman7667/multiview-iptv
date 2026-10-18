'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MockProvider, PKT } = require('./mock-xtream');
const { createApp } = require('../src/server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function request(base, pathname, { method = 'GET', body, ms = 0, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base);
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const h = { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) };
    const req = http.request(u, { method, headers: h }, (res) => {
      const chunks = [];
      let done = false;
      const finish = () => { if (done) return; done = true; resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }); };
      res.on('data', (c) => chunks.push(c));
      res.on('end', finish);
      res.on('close', finish);
      if (ms) setTimeout(() => { req.destroy(); finish(); }, ms);
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    if (data) req.write(data);
    req.end();
  });
}
const json = (r) => JSON.parse(r.buf.toString('utf8'));
const CLIP = process.env.CLIP_TS || '';
const hasX264 = /libx264/.test(spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '');
const real = (!CLIP && 'needs CLIP_TS') || (!hasX264 && 'no libx264');

// sequence numbers the mock puts into its video packets (pid 0x101, payload starts with a counter)
function seqs(buf) {
  const out = [];
  for (let o = 0; o + PKT <= buf.length; o += PKT) {
    if (buf[o] !== 0x47) continue;
    const pid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2];
    if (pid !== 0x101) continue;
    const afc = (buf[o + 3] >> 4) & 3;
    const p = o + 4 + (afc & 2 ? 1 + buf[o + 4] : 0);
    out.push(buf.readUInt32BE(p));
  }
  return out;
}

describe('rewind buffer, recordings, downloads and cast', () => {
  let app; let base; let dir; let prov;
  before(async () => {
    prov = await new MockProvider({ user: 'u', pass: 'p', max: 5, kbps: 1200 }).listen();
    if (CLIP) prov.files = { c1: { path: CLIP, seconds: 40 }, c2: { path: CLIP, seconds: 40 } };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-rec-'));
    app = createApp({ dataDir: dir, basicAuth: '', composeIdleMs: 400, recTickMs: 500, relay: { idleMs: 300, rewindSegMs: 1000 } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    await request(base, '/api/providers', { method: 'PUT', body: { providers: [{ id: 'a', name: 'A', url: prov.url, username: 'u', password: 'p', maxConnections: 5 }] } });
    await request(base, '/api/channels?provider=a');
  });
  after(() => { app.close(); prov.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('rewind: a viewer asking for ?back= gets the older video first and then live, with no gap', async () => {
    const watcher = request(base, '/stream/a/1.ts', { ms: 7500 });
    await sleep(6000);
    const info = json(await request(base, '/api/rewind/a/1'));
    assert.ok(info.seconds >= 4, `only ${info.seconds} s can be rewound`);
    assert.equal(info.max, 3600);
    const [back, live] = await Promise.all([request(base, '/stream/a/1.ts?back=4', { ms: 1500 }), request(base, '/stream/a/1.ts', { ms: 1500 })]);
    const b = seqs(back.buf);
    const l = seqs(live.buf);
    assert.ok(b.length > 100 && l.length > 0);
    assert.ok(l[0] - b[0] > 2500, `rewound start ${b[0]} vs live start ${l[0]}`);
    for (let i = 1; i < b.length; i++) assert.equal(b[i], b[i - 1] + 1, `gap or repeat at packet ${i}`);
    await watcher;
  });

  test('rewind folder is emptied when the channel closes', async () => {
    await sleep(1200);
    const left = fs.existsSync(path.join(dir, 'rewind')) ? fs.readdirSync(path.join(dir, 'rewind')) : [];
    assert.deepEqual(left, []);
  });

  test('"to the end of the event" stops 60 minutes after the programme ends; scheduled ones start 5 minutes early', async () => {
    const ev = json(await request(base, '/api/recordings/event?p=a&sid=1')).event;
    assert.match(ev.title, /Now Show 1-1/);
    assert.equal(ev.recordUntil - ev.stop, 60 * 60 * 1000);
    const now = Math.floor(Date.now() / 1000);
    const made = json(await request(base, '/api/recordings', { method: 'POST', body: { p: 'a', sid: '2', name: 'CNN', mode: 'programme', start: now + 7200, stop: now + 9000, title: 'Big Game' } })).item;
    assert.equal(made.status, 'scheduled');
    assert.equal(made.start, (now + 7200) * 1000 - 5 * 60 * 1000);
    assert.equal(made.end, (now + 9000) * 1000 + 60 * 60 * 1000);
    const bad = await request(base, '/api/recordings', { method: 'POST', body: { p: 'a', sid: '2', mode: 'minutes', minutes: 0 } });
    assert.equal(bad.status, 400);
    const stopped = json(await request(base, `/api/recordings/${made.id}/stop`, { method: 'POST', body: {} })).item;
    assert.equal(stopped.status, 'stopped');
    assert.equal((await request(base, `/api/recordings/${made.id}`, { method: 'DELETE' })).status, 200);
    assert.equal(json(await request(base, '/api/recordings')).items.length, 0);
  });

  test('a recording becomes an mp4 file that can be played, ranged and downloaded; deleting removes the file', { skip: real }, async () => {
    const made = json(await request(base, '/api/recordings', { method: 'POST', body: { p: 'a', sid: 'c1', name: 'Clip', mode: 'minutes', minutes: 5 } })).item;
    await sleep(6000);
    let it = json(await request(base, '/api/recordings')).items.find((x) => x.id === made.id);
    assert.equal(it.status, 'recording');
    assert.ok(it.size > 0, 'file grows while recording');
    it = json(await request(base, `/api/recordings/${made.id}/stop`, { method: 'POST', body: {} })).item;
    for (let i = 0; i < 20 && it.status === 'recording'; i++) { await sleep(300); it = json(await request(base, '/api/recordings')).items.find((x) => x.id === made.id); }
    assert.equal(it.status, 'done', it.error);
    assert.match(it.file, /\.mp4$/);
    const file = path.join(dir, 'recordings', it.file);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    assert.match(probe.stdout, /h264/);
    const full = await request(base, `/recordings/${made.id}.mp4`);
    assert.equal(full.status, 200);
    assert.equal(full.buf.length, fs.statSync(file).size);
    const part = await request(base, `/recordings/${made.id}.mp4`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal(part.buf.length, 100);
    const dl = await request(base, `/recordings/${made.id}.mp4?dl=1`, { method: 'HEAD' });
    assert.match(dl.headers['content-disposition'], /attachment; filename=/);
    await request(base, `/api/recordings/${made.id}`, { method: 'DELETE' });
    assert.equal(fs.existsSync(file), false);
  });

  test('a provider with no free connection makes the recording fail with a message', async () => {
    const hold = [];
    for (const id of ['1', '2', '3', '4', '5']) hold.push(request(base, `/stream/a/${id}.ts`, { ms: 4500 }));
    await sleep(1500);
    const made = json(await request(base, '/api/recordings', { method: 'POST', body: { p: 'a', sid: '404x', name: 'Extra', mode: 'minutes', minutes: 1 } })).item;
    let it = made;
    for (let i = 0; i < 20 && ['scheduled', 'recording'].includes(it.status); i++) { await sleep(300); it = json(await request(base, '/api/recordings')).items.find((x) => x.id === made.id); }
    assert.equal(it.status, 'failed');
    assert.ok(it.error.length > 5);
    await request(base, `/api/recordings/${made.id}`, { method: 'DELETE' });
    await Promise.all(hold);
  });

  test('a movie download to the server keeps the provider file as it is', async () => {
    const made = json(await request(base, '/api/recordings', { method: 'POST', body: { kind: 'download', p: 'a', sid: 'movie:501', ext: 'mp4', name: 'Big Movie' } })).item;
    let it = made;
    for (let i = 0; i < 30 && !['done', 'failed'].includes(it.status); i++) { await sleep(300); it = json(await request(base, '/api/recordings')).items.find((x) => x.id === made.id); }
    assert.equal(it.status, 'done', it.error);
    assert.equal(it.size, prov.vodBytes);
    assert.equal(fs.statSync(path.join(dir, 'recordings', it.file)).size, prov.vodBytes);
    const dev = await request(base, '/vod/a/movie%3A501.mp4?dl=1&name=Big%20Movie');
    assert.equal(dev.status, 200);
    assert.match(dev.headers['content-disposition'], /Big Movie\.mp4/);
    await request(base, `/api/recordings/${made.id}`, { method: 'DELETE' });
    assert.equal((await request(base, '/api/recordings', { method: 'POST', body: { kind: 'download', p: 'a', sid: '1', ext: 'mp4' } })).status, 400, 'live channels cannot be downloaded');
  });

  test('cast link: one channel as a fragmented mp4 that needs no login, bad and unknown links are refused', { skip: real }, async () => {
    const made = json(await request(base, '/api/cast', { method: 'POST', body: { mode: 'channel', p: 'a', sid: 'c1' } }));
    assert.match(made.url, /^\/cast\/[A-Za-z0-9_-]{20,}\.mp4$/);
    const r = await request(base, made.url, { ms: 5000 });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'video/mp4');
    assert.equal(r.buf.subarray(4, 8).toString(), 'ftyp');
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', '-'], { input: r.buf, encoding: 'utf8' });
    assert.match(probe.stdout, /h264/);
    assert.equal((await request(base, '/cast/AAAAAAAAAAAAAAAAAAAAAAAA.mp4')).status, 404);
    assert.equal((await request(base, '/api/cast', { method: 'POST', body: { mode: 'channel', p: 'zz', sid: '1' } })).status, 400);
  });

  test('cast link for a whole multiview uses the shared-screen picture', { skip: real }, async () => {
    const spec = { res: 480, cols: 2, rows: 1, audio: 0, cells: [{ x: 1, y: 1, w: 1, h: 1, p: 'a', sid: 'c1' }, { x: 2, y: 1, w: 1, h: 1, p: 'a', sid: 'c2' }] };
    const made = json(await request(base, '/api/cast', { method: 'POST', body: { mode: 'multiview', spec } }));
    const r = await request(base, made.url, { ms: 9000 });
    assert.equal(r.status, 200);
    assert.equal(r.buf.subarray(4, 8).toString(), 'ftyp');
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-'], { input: r.buf, encoding: 'utf8' });
    assert.match(probe.stdout, /854,480/);
  });
  test('a capture-card channel records and rewinds like any other channel', { skip: !hasX264 && 'no libx264' }, async () => {
    const list = json(await request(base, '/api/providers')).providers;
    const keep = list.map((x) => ({ id: x.id, name: x.name, url: x.url, username: x.username, password: 'p', maxConnections: x.maxConnections, enabled: x.enabled }));
    const put = await request(base, '/api/providers', { method: 'PUT', body: { providers: [...keep, { id: 'cap', name: 'Capture', type: 'local', sources: [{ id: 'test', name: 'Test pattern', video: 'test', audio: 'test' }] }] } });
    assert.equal(put.status, 200);
    const made = json(await request(base, '/api/recordings', { method: 'POST', body: { p: 'cap', sid: 'test', name: 'Test pattern', mode: 'minutes', minutes: 1 } })).item;
    const viewer = request(base, '/stream/cap/test.ts', { ms: 7000 });
    await sleep(6500);
    const rw = json(await request(base, '/api/rewind/cap/test'));
    assert.ok(rw.seconds >= 3, `rewind has ${rw.seconds} s`);
    await request(base, `/api/recordings/${made.id}/stop`, { method: 'POST', body: {} });
    await viewer;
    let it = json(await request(base, '/api/recordings')).items.find((x) => x.id === made.id);
    for (let i = 0; i < 20 && it.status === 'recording'; i++) { await sleep(300); it = json(await request(base, '/api/recordings')).items.find((x) => x.id === made.id); }
    assert.ok(['stopped', 'done'].includes(it.status), `${it.status} ${it.error}`);
    assert.ok(it.size > 5000, `only ${it.size} bytes`);
    const file = path.join(dir, 'recordings', it.file);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    assert.match(probe.stdout, /h264/);
    await request(base, `/api/recordings/${made.id}`, { method: 'DELETE' });
    assert.equal(fs.existsSync(file), false);
  });
});

describe('installable app files', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  test('the service worker cache name follows the package version, and the manifest points at files that exist', () => {
    const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
    assert.equal(/const VERSION = '([^']+)'/.exec(sw)[1], pkg.version);
    const man = JSON.parse(fs.readFileSync(path.join(root, 'public', 'manifest.webmanifest'), 'utf8'));
    for (const f of [...man.icons, ...man.screenshots]) assert.ok(fs.existsSync(path.join(root, 'public', f.src)), f.src);
    const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
    assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(html, /rel="apple-touch-icon"/);
    // the worker never touches streams, the API or login traffic
    assert.match(sw, /\(api\|stream\|ws\|vod\|recordings\|cast\)/);
    assert.match(sw, /req\.method !== 'GET'/);
  });
});
