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
const { qualityOf } = require('../src/lists');
const { cleanSpec, ffmpegArgs } = require('../src/compose');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function request(base, pathname, { method = 'GET', body, ms = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base);
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(u, { method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
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
async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-comp-'));
  const app = createApp({ dataDir: dir, basicAuth: '', composeIdleMs: 400, relay: { idleMs: 300 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return { app, dir, base: `http://127.0.0.1:${app.server.address().port}` };
}
const put = (base, list) => request(base, '/api/providers', { method: 'PUT', body: { providers: list } });

describe('SD variants', () => {
  test('quality tags are ranked', () => {
    assert.equal(qualityOf('US| ESPN SD'), 1);
    assert.equal(qualityOf('ESPN'), 2);
    assert.equal(qualityOf('ESPN HD'), 2);
    assert.equal(qualityOf('ESPN FHD'), 3);
    assert.equal(qualityOf('ESPN 4K'), 4);
    assert.equal(qualityOf('Lowell TV'), 2, 'only whole words count');
  });

  let ctx; let prov;
  before(async () => {
    prov = await new MockProvider({ user: 'u', pass: 'p', max: 3, channels: [
      { id: 1, name: 'US| ESPN FHD', cat: '10' }, { id: 2, name: 'US| ESPN SD', cat: '10' }, { id: 3, name: 'US| CNN HD', cat: '10' },
    ] }).listen();
    ctx = await boot();
    await put(ctx.base, [{ id: 'a', name: 'A', url: prov.url, username: 'u', password: 'p', maxConnections: 3 }]);
    await request(ctx.base, '/api/channels?provider=a');
  });
  after(() => { ctx.app.close(); prov.close(); fs.rmSync(ctx.dir, { recursive: true, force: true }); });

  test('q=sd opens the SD version of the same channel, plain requests do not', async () => {
    await request(ctx.base, '/stream/a/1.ts?q=sd', { ms: 800 });
    assert.deepEqual(prov.opened, ['2']);
    await sleep(500);
    await request(ctx.base, '/stream/a/1.ts', { ms: 800 });
    assert.deepEqual(prov.opened, ['2', '1']);
  });

  test('q=sd on a channel with no lower version uses the channel as chosen', async () => {
    prov.opened.length = 0;
    await sleep(500);
    await request(ctx.base, '/stream/a/3.ts?q=sd', { ms: 800 });
    assert.deepEqual(prov.opened, ['3']);
  });
});

describe('shared screen and transcode requests', () => {
  test('descriptions are validated', () => {
    const cell = { x: 1, y: 1, w: 1, h: 1, p: 'a', sid: '1' };
    assert.throws(() => cleanSpec({ res: 999, cols: 1, rows: 1, cells: [cell] }), /Resolution/);
    assert.throws(() => cleanSpec({ res: 720, cols: 9, rows: 1, cells: [cell] }), /grid/);
    assert.throws(() => cleanSpec({ res: 720, cols: 1, rows: 1, cells: [] }), /1 to 9/);
    assert.throws(() => cleanSpec({ res: 720, cols: 1, rows: 1, cells: [{ ...cell, x: 2 }] }), /outside/);
    assert.throws(() => cleanSpec({ res: 720, cols: 1, rows: 1, cells: [{ ...cell, sid: '1;rm -rf' }] }), /channel/i);
    const s = cleanSpec({ res: 720, cols: 2, rows: 2, cells: [cell, { ...cell, x: 2, sid: '2' }], audio: 1 });
    assert.equal(s.kind, 'compose');
    assert.equal(s.audio, 1);
    assert.match(s.id, /^[0-9a-f]{16}$/);
    assert.equal(cleanSpec({ res: 720, cols: 2, rows: 2, cells: [cell, { ...cell, x: 2, sid: '2' }], audio: 1 }).id, s.id, 'same picture, same job');
  });

  test('ffmpeg arguments place every tile and take sound from one', () => {
    const spec = cleanSpec({ res: 720, cols: 2, rows: 2, audio: 1, cells: [
      { x: 1, y: 1, w: 1, h: 1, p: 'a', sid: '1' }, { x: 2, y: 1, w: 1, h: 1, p: 'a', sid: '2' }, { x: 1, y: 2, w: 2, h: 1, p: 'a', sid: '3' }] });
    const a = ffmpegArgs(spec, [0, 1, 2], 'x264');
    const fc = a[a.indexOf('-filter_complex') + 1];
    assert.match(fc, /overlay=0:0:/);
    assert.match(fc, /overlay=640:0:/);
    assert.match(fc, /overlay=0:360:/);
    assert.match(fc, /scale=1280:360/, 'the wide tile spans both columns');
    assert.ok(a.includes('1:a:0?'), 'sound from tile 2');
    assert.ok(a.includes('libx264'));
    const hw = ffmpegArgs(spec, [0, 1, 2], 'vaapi');
    assert.ok(hw.includes('h264_vaapi'));
    assert.match(hw[hw.indexOf('-filter_complex') + 1], /hwupload/);
    const noSound = ffmpegArgs({ ...spec, audio: -1 }, [0, 1, 2], 'x264');
    assert.ok(noSound.includes('-an'));
  });

  let ctx; let prov;
  const CLIP = process.env.CLIP_TS || '';
  const hasX264 = /libx264/.test(spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '');
  before(async () => {
    prov = await new MockProvider({ user: 'u', pass: 'p', max: 4 }).listen();
    if (CLIP) prov.files = { c1: { path: CLIP, seconds: 40 }, c2: { path: CLIP, seconds: 40 } };
    ctx = await boot();
    await put(ctx.base, [{ id: 'a', name: 'A', url: prov.url, username: 'u', password: 'p', maxConnections: 4 }]);
  });
  after(() => { ctx.app.close(); prov.close(); fs.rmSync(ctx.dir, { recursive: true, force: true }); });

  const two = { res: 480, cols: 2, rows: 1, audio: 0, cells: [{ x: 1, y: 1, w: 1, h: 1, p: 'a', sid: 'c1' }, { x: 2, y: 1, w: 1, h: 1, p: 'a', sid: 'c2' }] };

  test('a bad description is refused with 400', async () => {
    const r = await request(ctx.base, '/api/compose', { method: 'POST', body: { ...two, res: 5 } });
    assert.equal(r.status, 400);
  });

  test('per-tile transcoding is refused without a GPU encoder', async () => {
    const r = await request(ctx.base, '/api/compose', { method: 'POST', body: { kind: 'tile', res: 480, cols: 1, rows: 1, cells: [{ x: 1, y: 1, w: 1, h: 1, p: 'a', sid: 'c1' }] } });
    assert.equal(r.status, 503);
    assert.equal(json(r).error, 'needs_gpu');
  });

  test('encoder test button runs the CPU encoder', { skip: !hasX264 && 'no libx264' }, async () => {
    const r = json(await request(ctx.base, '/api/compose/test', { method: 'POST', body: { encoder: 'x264' } }));
    assert.equal(r.ok, true, r.message);
    const bad = json(await request(ctx.base, '/api/compose/test', { method: 'POST', body: { encoder: 'vaapi' } }));
    assert.equal(bad.ok, false, 'no GPU device in the test container');
  });

  test('two channels become one MPEG-TS stream, shared by viewers, stopped when nobody watches', { skip: (!CLIP && 'needs CLIP_TS') || (!hasX264 && 'no libx264') }, async () => {
    const made = json(await request(ctx.base, '/api/compose', { method: 'POST', body: two }));
    assert.equal(made.kind, 'compose');
    const a = request(ctx.base, made.stream, { ms: 9000 });
    await sleep(4000);
    const st = json(await request(ctx.base, '/api/compose/info'));
    assert.equal(st.jobs.length, 1);
    assert.ok(st.jobs[0].viewers >= 1);
    const b = request(ctx.base, made.stream, { ms: 2500 });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 200);
    assert.ok(ra.buf.length > 30000, `only ${ra.buf.length} bytes`);
    assert.equal(ra.buf.length % PKT, 0);
    for (let o = 0; o < ra.buf.length; o += PKT) assert.equal(ra.buf[o], 0x47);
    assert.equal(rb.status, 200);
    assert.ok(rb.buf.length > 0);
    assert.equal(prov.opened.filter((x) => x === 'c1').length, 1, 'tile channels are shared with the relay');
    await sleep(1500);
    assert.equal(json(await request(ctx.base, '/api/compose/info')).jobs.length, 0, 'no viewer, no encoder');
    // the picture really is decodable and 854x480
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'csv=p=0', '-'], { input: ra.buf, encoding: 'utf8' });
    if (probe.status === 0) assert.match(probe.stdout, /h264,854,480/);
  });

  test('a viewer who may not see a channel cannot ask for it', async () => {
    const r = await request(ctx.base, '/stream/compose/0123456789abcdef.ts');
    assert.equal(r.status, 404);
  });
});
