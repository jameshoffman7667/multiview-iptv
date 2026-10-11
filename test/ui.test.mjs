// Browser tests (dev only). Needs Playwright + Chromium:  PLAYWRIGHT_PATH=/path/to/node_modules/playwright node --test test/ui.test.mjs
// The decoding itself needs a browser with H.264/AAC (real Chrome); these tests check the page logic and the
// relay -> mpegts.js demux path.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright');
const { MockProvider } = require('./mock-xtream.js');
const { createApp } = require('../src/server.js');

const CLIP = process.env.CLIP_TS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE_MPEGTS = `
window.__players = [];
window.mpegts = {
  getFeatureList: function () { return { mseLivePlayback: true }; },
  Events: { ERROR: 'error', LOADING_COMPLETE: 'loading_complete', MEDIA_INFO: 'media_info' },
  createPlayer: function (ds, cfg) {
    var p = { ds: ds, cfg: cfg, handlers: {}, destroyed: false,
      on: function (e, f) { this.handlers[e] = f; }, attachMediaElement: function (v) { this.v = v; },
      load: function () {}, unload: function () {}, detachMediaElement: function () {}, pause: function () {}, play: function () {},
      destroy: function () { this.destroyed = true; } };
    window.__players.push(p);
    return p;
  }
};`;

const MEDIA_STUBS = `
(function () {
  var calls = window.__calls = [];
  var proto = HTMLMediaElement.prototype;
  function idx(v) { var t = v.closest && v.closest('.tile'); return t ? Number(t.dataset.idx) : -1; }
  proto.play = function () { calls.push(['play', idx(this)]); this.__paused = false; return Promise.resolve(); };
  proto.pause = function () { calls.push(['pause', idx(this)]); this.__paused = true; };
  Object.defineProperty(proto, 'paused', { get: function () { return this.__paused !== false; }, configurable: true });
  Object.defineProperty(proto, 'currentTime', { get: function () { return this.__ct || 0; }, set: function (v) { calls.push(['seek', idx(this), v]); this.__ct = v; }, configurable: true });
  Object.defineProperty(proto, 'buffered', { get: function () { var a = this.__ahead || 0; var ct = this.__ct || 0; return { length: a > 0 ? 1 : 0, start: function () { return 0; }, end: function () { return ct + a; } }; }, configurable: true });
})();`;

describe('browser', () => {
  let browser;
  let app;
  let base;
  let dir;
  let p1;
  let p2;
  let p3;

  before(async () => {
    const files = CLIP ? { clip: { path: CLIP, seconds: 40 } } : undefined;
    p1 = new MockProvider({ user: 'u1', pass: 'pw1', max: 2, kbps: 1000, channels: [
      { id: 1, name: 'US| ESPN HD', cat: '10' }, { id: 2, name: 'US| CNN FHD', cat: '10' }, { id: 3, name: 'UK| BBC One', cat: '20' }, { id: 4, name: 'Weather', cat: '10' },
    ] });
    p1.files = files;
    await p1.listen();
    p2 = await new MockProvider({ user: 'u2', pass: 'pw2', max: 1, kbps: 1000, channels: [{ id: 77, name: 'CNN HD', cat: '10' }] }).listen();
    p3 = await new MockProvider({ user: 'u3', pass: 'pw3', max: 3 }).listen();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-ui-'));
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ providers: [
      { id: 'p1', name: 'Alpha', url: p1.url, username: 'u1', password: 'pw1', maxConnections: 2 },
      { id: 'p2', name: 'Beta', url: p2.url, username: 'u2', password: 'pw2', maxConnections: 1 },
    ] }));
    app = createApp({ dataDir: dir, basicAuth: '', relay: { idleMs: 500 } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    await Promise.all([app.lists.get(app.config.get('p1')), app.lists.get(app.config.get('p2'))]);
    browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  });

  after(async () => {
    await browser.close();
    app.close();
    await Promise.all([p1.close(), p2.close(), p3.close()]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function openPage({ fake = true, state, viewport = { width: 1920, height: 1080 } } = {}) {
    const ctx = await browser.newContext({ viewport });
    const errors = [];
    if (fake) {
      await ctx.route('**/vendor/mpegts.js', (route) => route.fulfill({ contentType: 'text/javascript', body: FAKE_MPEGTS }));
      await ctx.addInitScript(MEDIA_STUBS);
    }
    if (state) await ctx.addInitScript(`if (!localStorage.getItem('mv.state.v1')) localStorage.setItem('mv.state.v1', ${JSON.stringify(JSON.stringify(state))});`);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await page.goto(base);
    await page.waitForFunction(() => window.__mv && window.__mv.tiles.length === 9 && window.__mv.ME);
    return { ctx, page, errors };
  }

  const rects = (page) => page.$$eval('.tile', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { i: Number(e.dataset.idx), x: r.x, y: r.y, w: r.width, h: r.height, shown: e.offsetParent !== null }; }).filter((r) => r.shown).sort((a, b) => a.i - b.i));
  const near = (a, b, tol = 2.5) => Math.abs(a - b) <= tol;

  test('layouts: 3x3 grid and 1+7 (big top-left, 3 right, 3 bottom, 1 corner), 16:9 cells', async () => {
    const { ctx, page, errors } = await openPage();
    const expectCounts = { '1': 1, '2x2': 4, '1+5': 6, '3x3': 9, '1+7': 8 };
    for (const [key, n] of Object.entries(expectCounts)) {
      await page.evaluate((k) => window.__mv.setLayout(k), key);
      assert.equal((await rects(page)).length, n, `${key} shows ${n} tiles`);
    }
    await page.evaluate(() => window.__mv.setLayout('3x3'));
    let r = await rects(page);
    assert.equal(r.length, 9);
    for (const t of r) { assert.ok(near(t.w / t.h, 16 / 9, 0.03), `3x3 tile ${t.i} aspect ${t.w / t.h}`); assert.ok(near(t.w, r[0].w, 1)); }
    assert.ok(r[1].x > r[0].x && r[3].y > r[0].y, 'row-major order');

    await page.evaluate(() => window.__mv.setLayout('1+7'));
    r = await rects(page);
    assert.equal(r.length, 8);
    const [big, ...small] = r;
    const cell = (1920 - 6) / 4;
    assert.ok(near(big.x, 0) && near(big.y, 0), 'big tile is top-left');
    assert.ok(near(big.w, cell * 3 + 4, 3), `big tile spans 3 columns (${big.w})`);
    assert.ok(near(big.h, big.w * 9 / 16, 4), `big tile is 16:9 (${big.w}x${big.h})`);
    const right = small.slice(0, 3);
    const bottom = small.slice(3, 6);
    const corner = small[6];
    right.forEach((t, k) => { assert.ok(near(t.x, big.x + big.w + 2), 'right column x'); assert.ok(near(t.y, k * (t.h + 2)), `right tile ${k} y`); assert.ok(near(t.w, cell, 1.5)); });
    bottom.forEach((t, k) => { assert.ok(near(t.y, big.y + big.h + 2), 'bottom row y'); assert.ok(near(t.x, k * (t.w + 2)), `bottom tile ${k} x`); });
    assert.ok(near(corner.x, right[0].x) && near(corner.y, bottom[0].y), 'corner tile sits at the intersection');
    assert.ok(near(corner.x + corner.w, 1920, 1.5) && near(corner.y + corner.h, 1080, 1.5), 'corner touches the bottom-right');
    for (const t of small) assert.ok(near(t.w / t.h, 16 / 9, 0.03), `small tile aspect ${t.w / t.h}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('picker: search across providers, choose, persists across reload, stream URL carries buffer', async () => {
    const { ctx, page, errors } = await openPage();
    await page.evaluate(() => window.__mv.setLayout('1+7'));
    await page.click('.tile[data-idx="0"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.modal h2');
    assert.match(await page.textContent('.modal h2'), /Choose channel for tile 1/);
    await page.waitForFunction(() => document.querySelectorAll('.ch .pick').length === 5);
    await page.fill('.search', 'cnn');
    await page.waitForFunction(() => document.querySelectorAll('.ch .pick').length === 2);
    const names = await page.$$eval('.ch .nm', (e) => e.map((x) => x.textContent));
    assert.deepEqual(names, ['CNN HD', 'US| CNN FHD']);
    assert.ok((await page.$$eval('.ch .chip', (e) => e.map((x) => x.textContent))).includes('Beta'));
    // favourite the second one, then pick the first
    await page.click('.ch:nth-child(2) .star');
    await page.click('.ch:nth-child(1) .pick');
    await page.waitForFunction(() => window.__players.length === 1);
    assert.equal(await page.evaluate(() => window.__mv.modals), 0);
    let tile0 = await page.evaluate(() => window.__mv.S.tiles[0]);
    assert.equal(tile0.p, 'p2');
    assert.equal(tile0.sid, '77');
    assert.equal(await page.evaluate(() => window.__players[0].ds.url), '/stream/p2/77.ts?buf=4');
    assert.equal(await page.evaluate(() => window.__players[0].ds.isLive), true);
    await page.waitForTimeout(400);
    await page.reload();
    await page.waitForFunction(() => window.__players && window.__players.length === 1);
    assert.equal(await page.evaluate(() => window.__players[0].ds.url), '/stream/p2/77.ts?buf=4');
    assert.equal(await page.textContent('.tile[data-idx="0"] .label'), 'CNN HD');
    // favourites filter
    await page.keyboard.press('c');
    await page.waitForSelector('.modal .search');
    await page.click('.modal .btn:has-text("Favorites")');
    await page.waitForFunction(() => document.querySelectorAll('.ch .pick').length === 1);
    assert.equal(await page.textContent('.ch .nm'), 'US| CNN FHD');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__mv.modals), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('keyboard / remote navigation, digits, layout key, toolbar hand-over', async () => {
    const { ctx, page, errors } = await openPage({ state: { layout: '1+7' } });
    const sel = () => page.evaluate(() => window.__mv.S.sel);
    await page.focus('.tile[data-idx="0"]');
    assert.equal(await sel(), 0);
    await page.keyboard.press('ArrowRight'); assert.equal(await sel(), 2, 'right from big = middle right');
    await page.keyboard.press('ArrowLeft'); assert.equal(await sel(), 0, 'back to big');
    await page.keyboard.press('ArrowDown'); assert.equal(await sel(), 5, 'down from big = middle bottom');
    await page.keyboard.press('ArrowRight'); assert.equal(await sel(), 6);
    await page.keyboard.press('ArrowRight'); assert.equal(await sel(), 7, 'corner');
    await page.keyboard.press('ArrowUp'); assert.equal(await sel(), 3, 'up from corner = lowest right tile');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.idx), '3', 'focus follows selection');
    await page.keyboard.press('2'); assert.equal(await sel(), 1);
    await page.keyboard.press('9'); assert.equal(await sel(), 1, 'tile 9 does not exist in 1+7');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('#toolbar')), true, 'Up from the top row reaches the toolbar');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('tile')), true, 'Down returns to the tiles');
    await page.keyboard.press('l');
    assert.equal(await page.evaluate(() => window.__mv.S.layout), '1', 'L cycles the layout');
    assert.equal((await rects(page)).length, 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('buffer cushion: waits for the cushion, re-buffers after a stall, catches up to live', async () => {
    const { ctx, page, errors } = await openPage({ state: { layout: '1', tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }] } });
    await page.waitForFunction(() => window.__players.length === 1);
    const calls = () => page.evaluate(() => window.__calls.slice());
    const setAhead = (v) => page.evaluate((x) => { document.querySelector('video').__ahead = x; }, v);
    await page.waitForTimeout(900);
    assert.equal((await calls()).filter((c) => c[0] === 'play').length, 0, 'no data yet: not playing');
    await setAhead(1);
    await page.waitForTimeout(1000);
    assert.equal((await calls()).filter((c) => c[0] === 'play').length, 0, '1 s of 4 s cushion: still waiting');
    assert.match(await page.textContent('.tile .status'), /Buffering 1\.0 \/ 3\.2/);
    await setAhead(3.4);
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'play'), null, { timeout: 3000 });
    await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('playing')));
    await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('timeupdate')));
    await setAhead(0.05);
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'pause'), null, { timeout: 3000 });
    assert.match(await page.textContent('.tile .status'), /Buffering/);
    const playsBefore = (await calls()).filter((c) => c[0] === 'play').length;
    await setAhead(2);
    await page.waitForTimeout(900);
    assert.equal((await calls()).filter((c) => c[0] === 'play').length, playsBefore, 'rebuffer needs 3 s, has 2');
    await setAhead(3.2);
    await page.waitForFunction((n) => window.__calls.filter((c) => c[0] === 'play').length > n, playsBefore, { timeout: 3000 });
    await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('timeupdate')));
    await setAhead(30);
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'seek'), null, { timeout: 3000 });
    const seek = (await calls()).find((c) => c[0] === 'seek');
    assert.ok(Math.abs(seek[2] - 26) < 0.5, `jumped to ~4 s behind live: ${seek[2]}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('errors map to messages: busy provider retries, missing channel stops', async () => {
    const { ctx, page } = await openPage({ state: { layout: '1', tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }] } });
    await page.waitForFunction(() => window.__players.length === 1);
    await page.evaluate(() => { const p = window.__players[0]; p.handlers.error('NetworkError', 'HttpStatusCodeInvalid', { code: 503, msg: 'x' }); });
    assert.match(await page.textContent('.tile .status'), /No free provider connection - retrying in 8s/);
    assert.equal(await page.evaluate(() => window.__players[0].destroyed), true, 'player torn down while waiting');
    await page.evaluate(() => { window.__mv.tiles[0].start(); });
    await page.evaluate(() => { const p = window.__players[window.__players.length - 1]; p.handlers.error('NetworkError', 'HttpStatusCodeInvalid', { code: 404, msg: 'x' }); });
    assert.match(await page.textContent('.tile .status'), /Channel not found/);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__players.length), 2, 'no retry after 404');
    // decoder trouble: two retries, then a plain-language message and no more retries
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => { window.__mv.tiles[0].start(); const p = window.__players[window.__players.length - 1]; p.handlers.error('MediaError', 'MediaMSEError', { msg: 'x' }); });
      if (i < 2) assert.match(await page.textContent('.tile .status'), /Video decoder error - retrying/);
    }
    assert.match(await page.textContent('.tile .status'), /can't play this channel's video\/audio format/);
    await page.evaluate(() => window.__mv.tiles[0].start());
    await page.evaluate(() => { const p = window.__players[window.__players.length - 1]; p.handlers.error('MediaError', 'CodecUnsupported', {}); });
    assert.match(await page.textContent('.tile .status'), /can't play/);
    await ctx.close();
  });

  test('zoom a tile, make main, mute, stats toggle', async () => {
    const { ctx, page, errors } = await openPage({ state: { layout: '3x3', tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }, { p: 'p1', sid: '2', name: 'CNN' }] } });
    await page.click('.tile[data-idx="1"]');
    await page.keyboard.press('z');
    let r = await rects(page);
    assert.equal(r.length, 1);
    assert.ok(near(r[0].w, 1920, 1) && near(r[0].h, 1080, 1), 'zoomed tile fills the screen');
    await page.keyboard.press('Escape');
    assert.equal((await rects(page)).length, 9, 'Esc leaves zoom');
    await page.keyboard.press('s');
    assert.deepEqual(await page.evaluate(() => window.__mv.S.tiles.slice(0, 2).map((t) => t && t.name)), ['CNN', 'ESPN'], 'S swaps with the main tile');
    assert.equal(await page.evaluate(() => window.__mv.S.sel), 0);
    await page.keyboard.press('m');
    assert.equal(await page.textContent('#btn-audio'), 'Muted');
    await page.keyboard.press('i');
    assert.equal(await page.evaluate(() => document.body.classList.contains('stats')), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('settings window, Back button closes windows, failover flag reaches the stream URL', async () => {
    const { ctx, page, errors } = await openPage({ state: { layout: '1', tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }] } });
    const url0 = page.url();
    await page.click('#btn-settings');
    await page.waitForSelector('.modal h2');
    await page.selectOption('.modal select >> nth=0', '8');
    assert.equal(await page.evaluate(() => window.__mv.S.bufSec), 8);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__mv.modals === 0);
    await page.click('#btn-settings');
    await page.waitForSelector('.modal h2');
    await page.goBack();
    await page.waitForFunction(() => window.__mv.modals === 0);
    assert.equal(page.url(), url0, 'Back stayed in the app');
    await page.click('#btn-settings');
    await page.uncheck('.modal .check input >> nth=0');
    await page.click('.modal .btn:has-text("Restart all streams")');
    await page.waitForFunction(() => window.__players.length >= 2);
    assert.equal(await page.evaluate(() => window.__players[window.__players.length - 1].ds.url), '/stream/p1/1.ts?buf=8&failover=0');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('providers window: usage, add a provider (test fills max connections), password never shown', async () => {
    const { ctx, page, errors } = await openPage();
    assert.match(await page.textContent('#btn-conn'), /Providers 0\/3/);
    await page.click('#btn-conn');
    await page.waitForFunction(() => document.querySelectorAll('.prov').length === 2);
    const html = await page.content();
    assert.ok(!html.includes('pw1') && !html.includes('pw2'));
    await page.click('.modal .btn:has-text("Add provider")');
    await page.fill('.modal input[type=text] >> nth=0', 'Gamma');
    await page.fill('.modal input[type=url]', `${p3.url}/`);
    await page.fill('.modal input[type=text] >> nth=1', 'u3');
    await page.fill('.modal input[type=password]', 'pw3');
    await page.click('.modal .btn:has-text("Test")');
    await page.waitForSelector('.msg.ok');
    assert.match(await page.textContent('.msg.ok'), /Login OK .* allows 3 connection/);
    assert.equal(await page.inputValue('.modal input[type=number]'), '3');
    await page.click('.modal .btn:has-text("Save")');
    await page.waitForFunction(() => document.querySelectorAll('.prov').length === 3);
    assert.equal(app.config.providers.length, 3);
    assert.equal(app.config.providers[2].maxConnections, 3);
    assert.ok(!(await page.content()).includes('pw3'));
    await page.click('.modal .btn:has-text("Close")');
    await page.waitForFunction(() => /Providers \d\/6/.test(document.querySelector('#btn-conn').textContent));
    // wrong password shows the provider's message
    await page.click('#btn-conn');
    await page.waitForSelector('.prov');
    await page.click('.prov:nth-of-type(3) .btn');
    await page.fill('.modal input[type=password]', 'nope');
    await page.click('.modal .btn:has-text("Test")');
    await page.waitForSelector('.msg.bad');
    assert.match(await page.textContent('.msg.bad'), /login rejected/);
    assert.deepEqual(errors, []);
    await ctx.close();
    app.config.replace(app.config.providers.slice(0, 2).map((p) => ({ ...p })));
  });

  test('toolbar hides when idle and returns on movement; fit toggle', async () => {
    const { ctx, page } = await openPage({ state: { layout: '1' } });
    await page.waitForFunction(() => document.querySelector('#toolbar').classList.contains('hide'), null, { timeout: 8000 });
    await page.mouse.move(300, 300);
    await page.mouse.move(320, 310);
    assert.equal(await page.evaluate(() => document.querySelector('#toolbar').classList.contains('hide')), false);
    await ctx.close();
  });

  test('first run with no providers opens the providers window', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-ui2-'));
    const app2 = createApp({ dataDir: dir2, basicAuth: '' });
    await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
    const saved = base;
    base = `http://127.0.0.1:${app2.server.address().port}`;
    const { ctx, page } = await openPage();
    await page.waitForSelector('.modal h2');
    assert.match(await page.textContent('.modal'), /Add your IPTV provider/);
    assert.match(await page.textContent('#btn-conn'), /Add provider/);
    await ctx.close();
    base = saved;
    app2.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  test('phone-size screen: layout still usable', async () => {
    const { ctx, page, errors } = await openPage({ viewport: { width: 390, height: 844 }, state: { layout: '2x2' } });
    const r = await rects(page);
    assert.equal(r.length, 4);
    for (const t of r) assert.ok(t.w > 150 && t.h > 100);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

describe('real mpegts.js against the relay', { skip: !CLIP }, () => {
  test('library demuxes the relayed stream (live join and keyframe-aligned late join)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-real-'));
    const prov = new MockProvider({ user: 'u', pass: 'p', max: 2 });
    prov.files = { clip: { path: CLIP, seconds: 40 } };
    await prov.listen();
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ providers: [{ id: 'a', name: 'A', url: prov.url, username: 'u', password: 'p', maxConnections: 2 }] }));
    const app = createApp({ dataDir: dir, basicAuth: '', relay: { idleMs: 500 } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/`);
      await page.waitForFunction(() => window.mpegts);
      // resolves when the library has parsed the stream headers (codec, size); the player stays alive when keep=true
      const probe = (url, keep) => page.evaluate((a) => new Promise((resolve) => {
        const t0 = performance.now();
        const v = document.createElement('video'); v.muted = true; document.body.appendChild(v);
        const p = window.mpegts.createPlayer({ type: 'mpegts', isLive: true, url: a.url }, { enableWorker: false });
        p.attachMediaElement(v); p.load();
        const done = (o) => { o.ms = Math.round(performance.now() - t0); if (!a.keep) { try { p.destroy(); } catch (e) { /* ignore */ } } resolve(o); };
        p.on(window.mpegts.Events.MEDIA_INFO, (i) => done({ ok: true, codec: i.videoCodec, w: i.width, h: i.height, audio: i.audioCodec }));
        p.on(window.mpegts.Events.ERROR, (t, d) => { if (!/Codec|MSE|Media/i.test(String(d))) done({ ok: false, t, d }); });
        setTimeout(() => done({ ok: false, t: 'timeout' }), 12000);
      }), { url, keep });
      const first = await probe('/stream/a/clip.ts', true);
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.match(first.codec, /^avc1/);
      assert.equal(first.w, 320);
      assert.equal(first.h, 180);
      await sleep(6000); // upstream keeps running, ring fills
      const late = await probe('/stream/a/clip.ts?buf=3', false);
      assert.equal(late.ok, true, JSON.stringify(late));
      assert.match(late.codec, /^avc1/);
      assert.ok(late.ms < 3000, `late joiner parsed headers quickly (${late.ms} ms)`);
      assert.equal(prov.opened.filter((x) => x === 'clip').length, 1, 'both viewers shared one provider connection');
    } finally {
      await browser.close();
      app.close();
      await prov.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('logins and shared multiviews (browser)', () => {
  let browser;
  let app;
  let base;
  let dir;
  let p1;

  before(async () => {
    p1 = await new MockProvider({ user: 'u1', pass: 'pw1', max: 4, kbps: 1000, channels: [
      { id: 1, name: 'US| ESPN HD', cat: '10' }, { id: 2, name: 'US| CNN FHD', cat: '10' }, { id: 3, name: 'UK| BBC One', cat: '20' },
    ] }).listen();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-ui2-'));
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ providers: [{ id: 'p1', name: 'Alpha', url: p1.url, username: 'u1', password: 'pw1', maxConnections: 4 }] }));
    app = createApp({ dataDir: dir, basicAuth: '', relay: { idleMs: 300 } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    await app.lists.get(app.config.get('p1'));
    browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  });
  after(async () => {
    await browser.close();
    app.close();
    await p1.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function newPage() {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await ctx.route('**/vendor/mpegts.js', (route) => route.fulfill({ contentType: 'text/javascript', body: FAKE_MPEGTS }));
    await ctx.addInitScript(MEDIA_STUBS);
    const errors = [];
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    return { ctx, page, errors };
  }

  test('admin turns logins on, publishes a multiview and adds a viewer; the viewer logs in and just clicks it', async () => {
    const { ctx, page, errors } = await newPage();
    await page.goto(base);
    await page.waitForFunction(() => window.__mv && window.__mv.ME);
    assert.equal(await page.evaluate(() => window.__mv.ME.admin), true);
    // arrange a screen: 2x2 with two channels
    await page.evaluate(() => {
      window.__mv.setLayout('2x2');
      window.__mv.assign(0, { p: 'p1', sid: '1', name: 'ESPN' });
      window.__mv.assign(1, { p: 'p1', sid: '2', name: 'CNN' });
    });
    // turn on logins
    await page.click('#btn-acct');
    await page.click('text=Users and logins...');
    await page.fill('.modal input[type=text]', 'boss');
    await page.fill('.modal input[type=password]', 'hunter22');
    await Promise.all([page.waitForNavigation(), page.click('text=Create admin and turn on logins')]);
    await page.waitForFunction(() => window.__mv && window.__mv.ME);
    assert.equal(await page.evaluate(() => window.__mv.ME.user.username), 'boss');
    assert.equal(await page.textContent('#btn-acct'), 'boss');
    // add a viewer
    await page.click('#btn-acct');
    await page.click('text=Users and logins...');
    await page.click('text=Add user');
    await page.fill('.modal input[type=text]', 'alice');
    await page.fill('.modal input[type=password]', 'alicepw1');
    await page.click('.modal .btn.primary');
    await page.waitForSelector('.modal .prov b:text("alice")');
    await page.keyboard.press('Escape');
    // publish
    await page.click('#btn-views');
    await page.click('text=Publish my current screen...');
    await page.fill('.modal input[type=text]', 'Game day');
    await page.click('.modal .btn.primary');
    await page.waitForFunction(() => /Published/.test(document.getElementById('banner').textContent));
    assert.deepEqual(errors, []);
    await ctx.close();

    // the viewer
    const v = await newPage();
    await v.page.goto(base);
    await v.page.waitForSelector('.login-back');
    await v.page.fill('.login input[type=text]', 'alice');
    await v.page.fill('.login input[type=password]', 'wrong');
    await v.page.click('.login .btn.primary');
    await v.page.waitForSelector('.login .msg.bad:not([hidden])');
    await v.page.fill('.login input[type=password]', 'alicepw1');
    await v.page.keyboard.press('Enter');
    // only one multiview shared, so it opens straight away
    await v.page.waitForFunction(() => document.getElementById('view-title').textContent === 'Game day');
    const state = await v.page.evaluate(() => ({ layout: window.__mv.S.layout, admin: window.__mv.ME.admin, urls: window.__players.map((p) => p.ds.url) }));
    assert.equal(state.admin, false);
    assert.equal(state.layout, '2x2');
    assert.equal(state.urls.length, 2);
    assert.ok(state.urls[0].startsWith('/stream/p1/1.ts'));
    // viewer chrome: no layout buttons, no providers, cannot add channels
    assert.equal(await v.page.isVisible('#layouts'), false);
    assert.equal(await v.page.isVisible('#btn-conn'), false);
    await v.page.click('.tile[data-idx="2"]');
    await v.page.click('.tile[data-idx="2"]');
    assert.equal(await v.page.$('.modal'), null, 'empty tiles do not open a picker for viewers');
    await v.page.keyboard.press('c');
    assert.equal(await v.page.$('.modal'), null);
    // viewer API access is limited
    const api = await v.page.evaluate(async () => ({
      providers: (await fetch('/api/providers')).status,
      views: (await fetch('/api/views')).status,
      channels: (await fetch('/api/channels?provider=p1')).status,
    }));
    assert.deepEqual(api, { providers: 403, views: 200, channels: 403 });

    // admin changes the published multiview: the open viewer page picks it up
    await app.views.update(app.views.views[0].id, { layout: '1', tiles: [{ p: 'p1', sid: '3', name: 'BBC' }] });
    await v.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await v.page.waitForFunction(() => window.__mv.S.layout === '1' && window.__players.some((p) => !p.destroyed && /\/stream\/p1\/3/.test(p.ds.url)), null, { timeout: 8000 });
    // log out returns to the login screen
    await v.page.click('#btn-acct');
    await Promise.all([v.page.waitForNavigation(), v.page.click('text=Log out')]);
    await v.page.waitForSelector('.login-back');
    assert.deepEqual(v.errors, []);
    await v.ctx.close();
  });

  test('viewer with several multiviews gets a chooser; nothing shared shows a friendly message', async () => {
    app.users.create({ username: 'carol', password: 'carolpw1', role: 'viewer' });
    app.views.create({ name: 'Second', layout: '1', tiles: [{ p: 'p1', sid: '2', name: 'CNN' }] });
    app.views.create({ name: 'Hidden', layout: '1', tiles: [{ p: 'p1', sid: '2', name: 'CNN' }], users: ['nobody'] });
    const { ctx, page } = await newPage();
    await page.goto(base);
    await page.fill('.login input[type=text]', 'carol');
    await page.fill('.login input[type=password]', 'carolpw1');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.view-open');
    assert.equal(await page.locator('.view-open').count(), 2, 'sees only the multiviews shared with her');
    await page.click('.view-open >> nth=1');
    await page.waitForFunction(() => document.getElementById('view-title').textContent.length > 0);
    await ctx.close();
    for (const v of [...app.views.views]) app.views.remove(v.id);
    const again = await newPage();
    await again.page.goto(base);
    await again.page.fill('.login input[type=text]', 'carol');
    await again.page.fill('.login input[type=password]', 'carolpw1');
    await again.page.keyboard.press('Enter');
    await again.page.waitForSelector('text=No multiviews have been shared with you yet');
    await again.ctx.close();
  });
});
