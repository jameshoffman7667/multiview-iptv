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
const { cleanSpec, ffmpegArgs, canvasOf, PipeClient, intEnv, shortReason } = require('../src/compose');
const { PassThrough } = require('node:stream');

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

// ---- 0.4.1: robustness of the composite
const CLIP = process.env.CLIP_TS || '';
const hasX264 = /libx264/.test(spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '');
const needReal = (!CLIP && 'needs CLIP_TS') || (!hasX264 && 'no libx264');

describe('picture geometry', () => {
  test('the picture has the shape of the page grid and no per-input timestamp rewriting', () => {
    const spec = cleanSpec({ res: 480, cols: 2, rows: 1, aspect: 2, cells: [{ x: 1, y: 1, w: 1, h: 1, p: 'a', sid: '1' }, { x: 2, y: 1, w: 1, h: 1, p: 'a', sid: '2' }] });
    assert.deepEqual(canvasOf(spec).slice(0, 2), [960, 480]);
    const a = ffmpegArgs(spec, [0, 1], 'x264');
    const fc = a[a.indexOf('-filter_complex') + 1];
    assert.match(fc, /overlay=480:0:/);
    assert.match(fc, /scale=480:480/);
    assert.doesNotMatch(fc, /setpts/);
    assert.doesNotMatch(a.join(' '), /asetpts/);
    assert.ok(a.includes('color=c=black:s=960x480:r=25'));
    assert.notEqual(cleanSpec({ res: 480, cols: 2, rows: 1, aspect: 1.5, cells: spec.cells }).id, spec.id, 'another shape is another picture');
    assert.equal(canvasOf(cleanSpec({ res: 480, cols: 1, rows: 1, aspect: 99, cells: [spec.cells[0]] }))[0], 1152, 'absurd shapes are limited');
  });

  test('tiles land in their own half of the picture, without offset', { skip: !hasX264 && 'no libx264' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-geo-'));
    const mk = (name, colour) => { const f = path.join(dir, name); spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=640x360:r=25`, '-t', '4', '-c:v', 'libx264', '-g', '25', '-f', 'mpegts', f]); return f; };
    const files = [mk('r.ts', 'red'), mk('b.ts', 'blue')];
    const spec = cleanSpec({ res: 480, cols: 2, rows: 1, aspect: 2, cells: [{ x: 1, y: 1, w: 1, h: 1, p: 'a', sid: '1' }, { x: 2, y: 1, w: 1, h: 1, p: 'a', sid: '2' }] });
    const child = require('node:child_process').spawn('ffmpeg', ffmpegArgs(spec, [0, 1], 'x264'), { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    files.forEach((f, k) => fs.createReadStream(f).pipe(child.stdio[3 + k]));
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stdio[3].on('error', () => {}); child.stdio[4].on('error', () => {});
    await new Promise((r) => setTimeout(r, 7000)); // the black base runs for ever: take 7 seconds of it
    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', r));
    const ts = path.join(dir, 'out.ts');
    fs.writeFileSync(ts, Buffer.concat(out));
    const px = (x, y) => {
      const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', '1.5', '-i', ts, '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
      return [...r.stdout];
    };
    for (const [x, y] of [[2, 240], [240, 240], [470, 240]]) { const [r, , b] = px(x, y); assert.ok(r > 150 && b < 100, `(${x},${y}) should be red, got ${px(x, y)}`); }
    for (const [x, y] of [[490, 240], [720, 240], [957, 240]]) { const [r, , b] = px(x, y); assert.ok(b > 150 && r < 100, `(${x},${y}) should be blue, got ${px(x, y)}`); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('settings and messages', () => {
  test('limits must be whole numbers; anything else falls back to the default', () => {
    const was = process.env.MV_TEST_N;
    for (const [v, want] of [['abc', 2], ['-1', 2], ['1.5', 2], ['', 2], ['0', 0], ['3', 3]]) { process.env.MV_TEST_N = v; assert.equal(intEnv('MV_TEST_N', 2), want, `"${v}"`); }
    delete process.env.MV_TEST_N;
    assert.equal(intEnv('MV_TEST_N', 2), 2);
    if (was !== undefined) process.env.MV_TEST_N = was;
  });

  test('the short reason says what is wrong without the filter graph', () => {
    const tail = '[fc#0 @ 0x55] Stream specifier \':v:0\' in filtergraph description [0:v:0]scale=568:320[t0];[6:v][t0]overlay=0:0 matches no streams.\nError opening output file pipe:1.\n';
    const r = shortReason(tail);
    assert.ok(r.length < 300);
    assert.doesNotMatch(r, /overlay=0:0/);
  });
});

describe('a slow input is skipped ahead, not dropped', () => {
  test('the queue stays bounded and the input keeps flowing once ffmpeg reads again', () => {
    const stream = new PassThrough({ highWaterMark: 1000 });
    const up = { bytesPerSec: () => 1000, burst: () => Buffer.alloc(PKT * 10, 1) };
    const c = new PipeClient(stream, { up, label: 'test', queueMin: 100000, queueSeconds: 1 });
    for (let i = 0; i < 100; i++) c.send(Buffer.alloc(20000, 7)); // 2 MB while nobody reads
    assert.ok(c.resyncs >= 1, 'skipped ahead');
    assert.ok(c.qBytes <= 140000, `queue is ${c.qBytes}`);
    assert.equal(c.dead, false);
    let got = 0;
    stream.on('data', (d) => { got += d.length; });
    c.send(Buffer.alloc(PKT * 5, 9));
    return new Promise((r) => setTimeout(() => { assert.ok(got > 0, 'data flows again'); assert.equal(c.dead, false); r(); }, 50));
  });
});

describe('the composite survives bad inputs', { skip: needReal }, () => {
  let ctx; let prov; let dir; let audioOnly;
  const tileCells = (ids) => ids.map((sid, i) => ({ x: i + 1, y: 1, w: 1, h: 1, p: 'a', sid }));
  const spec = (ids, extra = {}) => ({ res: 480, cols: ids.length, rows: 1, audio: 0, cells: tileCells(ids), ...extra });
  const savedEnv = {};
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-aud-'));
    audioOnly = path.join(dir, 'audio.ts');
    spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'aac', '-f', 'mpegts', audioOnly]);
    for (const k of ['COMPOSE_MAX']) { savedEnv[k] = process.env[k]; }
    process.env.COMPOSE_MAX = '1';
    prov = await new MockProvider({ user: 'u', pass: 'p', max: 6 }).listen();
    let late = 0;
    prov.files = {
      v1: { path: CLIP, seconds: 40 }, v2: { path: CLIP, seconds: 40 },
      aud: { path: audioOnly, seconds: 6 },
      late: { path: CLIP, seconds: 40, delayMs: () => (late++ === 0 ? 3500 : 0) },
    };
    const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-comp2-'));
    const app = createApp({ dataDir: dd, basicAuth: '', composeIdleMs: 5000, relay: { idleMs: 300 }, compose: { gateMs: 1500, watchMs: 300, recheckMs: 500, minRebuildMs: 500 } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    ctx = { app, dir: dd, base: `http://127.0.0.1:${app.server.address().port}` };
    await put(ctx.base, [{ id: 'a', name: 'A', url: prov.url, username: 'u', password: 'p', maxConnections: 6 }]);
  });
  after(() => {
    ctx.app.close(); prov.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true });
    if (savedEnv.COMPOSE_MAX === undefined) delete process.env.COMPOSE_MAX; else process.env.COMPOSE_MAX = savedEnv.COMPOSE_MAX;
  });

  const info = async () => json(await request(ctx.base, '/api/compose/info'));
  // keeps asking for the stream like the page does when it is restarted
  async function watchFor(stream, ms, until) {
    const end = Date.now() + ms;
    const bytes = [];
    let last = null;
    while (Date.now() < end) {
      const r = await request(ctx.base, stream, { ms: Math.min(2500, end - Date.now()) });
      if (r.status === 200) bytes.push(r.buf);
      last = await info();
      if (until && until(last)) break;
    }
    return { bytes: Buffer.concat(bytes), info: last };
  }
  const states = (inf) => (inf.jobs[0] ? inf.jobs[0].inputs.map((i) => i.state) : []);

  test('an input with no video: the composite still starts, that tile is black, the others play', async () => {
    const made = json(await request(ctx.base, '/api/compose', { method: 'POST', body: spec(['v1', 'aud', 'v2']) }));
    const r = await watchFor(made.stream, 9000, (i) => states(i).join() === 'live,black,live' && /no video/.test(i.jobs[0].inputs[1].why));
    assert.deepEqual(states(r.info), ['live', 'black', 'live']);
    assert.match(r.info.jobs[0].inputs[1].why, /no video/);
    assert.ok(r.bytes.length > 30000, `only ${r.bytes.length} bytes`);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'csv=p=0', '-'], { input: r.bytes, encoding: 'utf8' });
    assert.match(probe.stdout, /h264,(854|1280),480/);
    assert.equal(prov.opened.filter((x) => x === 'aud').length, 1, 'the black tile still shares one provider connection');
  });

  test('an input that delivers nothing for a few seconds and then data appears in the picture', async () => {
    await sleep(5500); // the previous composite ends
    const made = json(await request(ctx.base, '/api/compose', { method: 'POST', body: spec(['v1', 'late']) }));
    const first = await watchFor(made.stream, 3000);
    assert.ok(states(first.info).includes('black') || states(first.info).includes('live'), 'it started without waiting');
    const r = await watchFor(made.stream, 20000, (i) => states(i).join() === 'live,live');
    assert.deepEqual(states(r.info), ['live', 'live'], JSON.stringify(r.info.jobs));
    assert.equal(prov.opened.filter((x) => x === 'late').length, 1, 'no second provider connection for the late channel');
  });

  test('a second request from the same viewer replaces the first instead of competing for COMPOSE_MAX=1', async () => {
    await sleep(5500);
    const a = await request(ctx.base, '/api/compose', { method: 'POST', body: spec(['v1']) });
    assert.equal(a.status, 200);
    const b = await request(ctx.base, '/api/compose', { method: 'POST', body: spec(['v1', 'v2']) });
    assert.equal(b.status, 200, b.buf.toString());
    const inf = await info();
    assert.deepEqual(inf.jobs.map((j) => j.id), [json(b).id]);
  });

  test('every refused request is explained', async () => {
    process.env.COMPOSE_MAX = '0';
    const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-comp3-'));
    const app = createApp({ dataDir: dd, basicAuth: '', composeIdleMs: 400, relay: { idleMs: 300 } });
    process.env.COMPOSE_MAX = '1';
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    await put(base, [{ id: 'a', name: 'A', url: prov.url, username: 'u', password: 'p', maxConnections: 6 }]);
    const r = await request(base, '/api/compose', { method: 'POST', body: spec(['v1', 'v2']) });
    assert.equal(r.status, 503);
    assert.equal(json(r).error, 'compose_disabled');
    assert.match(json(r).message, /COMPOSE_MAX=0/);
    app.close(); fs.rmSync(dd, { recursive: true, force: true });
  });
});

describe('multiview published as one stream', () => {
  test('published screen description is stored, validated and handed to viewers; mode can go back to layout', async () => {
    const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-pub-'));
    const app = createApp({ dataDir: dd, basicAuth: '', composeIdleMs: 400, relay: { idleMs: 300 } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const tiles = [{ p: 'a', sid: 'c1', name: 'One' }, { p: 'a', sid: 'c2', name: 'Two' }];
    const stream = { res: 720, cols: 2, rows: 1, aspect: 16 / 9, fit: 'contain', audio: 1, cells: [{ x: 1, y: 1, w: 1, h: 1, p: 'a', sid: 'c1', sd: false }, { x: 2, y: 1, w: 1, h: 1, p: 'a', sid: 'c2', sd: true }] };
    let r = await request(base, '/api/views', { method: 'POST', body: { name: 'Two up', layout: '2x2', tiles, mode: 'stream', stream } });
    assert.equal(r.status, 200);
    const v = json(r).view;
    assert.equal(v.mode, 'stream');
    assert.equal(v.stream.audio, 1);
    assert.equal(v.stream.id, undefined);
    // viewers post the stored description to /api/compose and all get the same job
    const listed = json(await request(base, '/api/views')).views[0];
    assert.equal(listed.mode, 'stream');
    assert.equal(cleanSpec(listed.stream).id, cleanSpec(stream).id);
    // a channel that is not in the multiview is refused
    r = await request(base, '/api/views', { method: 'POST', body: { name: 'bad', layout: '2x2', tiles, mode: 'stream', stream: { ...stream, cells: [{ ...stream.cells[0], sid: 'zzz' }] } } });
    assert.equal(r.status, 400);
    r = await request(base, '/api/views', { method: 'POST', body: { name: 'bad', layout: '2x2', tiles, mode: 'stream' } });
    assert.equal(r.status, 400);
    r = await request(base, '/api/views', { method: 'POST', body: { name: 'bad', layout: '2x2', tiles, mode: 'zip' } });
    assert.equal(r.status, 400);
    // layout-only views carry no picture
    r = await request(base, '/api/views/' + v.id, { method: 'PUT', body: { mode: 'layout' } });
    assert.equal(json(r).view.mode, 'layout');
    assert.equal(json(r).view.stream, null);
    // a view published before this existed is a layout
    app.views.views.push({ id: 'old', name: 'Old', layout: '1', tiles: tiles.concat(Array(7).fill(null)), users: [], rev: 1 });
    assert.equal(json(await request(base, '/api/views')).views.find((x) => x.id === 'old').mode, 'layout');
    app.close();
    fs.rmSync(dd, { recursive: true, force: true });
  });
});
