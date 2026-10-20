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

  const vis2 = (page, sel) => page.evaluate((q) => { const e = document.querySelector(q); return !!e && !e.hidden && e.offsetParent !== null; }, sel);
  async function openPage({ fake = true, state, viewport = { width: 1920, height: 1080 } } = {}) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
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

  const menu = (page, id) => page.evaluate((i) => document.getElementById('sm-' + i).click(), id);
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
    await page.click('.tile[data-idx="0"]');   // an empty tile opens the picker
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
    assert.equal(await page.evaluate(() => window.__players[0].ds.url), `ws://${new URL(page.url()).host}/ws/stream/p2/77.ts?buf=4`);
    assert.equal(await page.evaluate(() => window.__players[0].ds.isLive), true);
    await page.waitForTimeout(400);
    await page.reload();
    await page.waitForFunction(() => window.__players && window.__players.length === 1);
    assert.equal(await page.evaluate(() => window.__players[0].ds.url), `ws://${new URL(page.url()).host}/ws/stream/p2/77.ts?buf=4`);
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

  test('keyboard / remote navigation, digits, layout key, player-controls hand-over', async () => {
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
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('#ovl')), true, 'Up from the top row reaches the player controls');
    assert.equal(await page.evaluate(() => window.__mv.ovl.shown), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__mv.ovl.shown), false, 'Back closes the controls');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('tile')), true, 'and returns to the tiles');
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
    await page.click('.tile[data-idx="1"]'); await page.click('.tile[data-idx="1"]'); // first tap brings the controls up, second selects it
    await page.keyboard.press('z');
    await page.evaluate(() => window.__mv.ovlHide());
    let r = await rects(page);
    assert.equal(r.length, 1);
    assert.ok(near(r[0].w, 1920, 1) && near(r[0].h, 1080, 1), 'zoomed tile fills the screen');
    await page.keyboard.press('Escape');
    assert.equal((await rects(page)).length, 9, 'Esc leaves zoom');
    await page.keyboard.press('s');
    assert.deepEqual(await page.evaluate(() => window.__mv.S.tiles.slice(0, 2).map((t) => t && t.name)), ['CNN', 'ESPN'], 'S swaps with the main tile');
    assert.equal(await page.evaluate(() => window.__mv.S.sel), 0);
    await page.keyboard.press('m');
    assert.equal(await page.evaluate(() => window.__mv.S.muted), true);
    await page.keyboard.press('i');
    assert.equal(await page.evaluate(() => document.body.classList.contains('stats')), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('settings window, Back button closes windows, failover flag reaches the stream URL', async () => {
    const { ctx, page, errors } = await openPage({ state: { layout: '1', tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }] } });
    const url0 = page.url();
    await menu(page, 'settings');
    await page.waitForSelector('.modal h2');
    await page.selectOption('.modal select >> nth=0', '8');
    assert.equal(await page.evaluate(() => window.__mv.S.bufSec), 8);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__mv.modals === 0);
    await menu(page, 'settings');
    await page.waitForSelector('.modal h2');
    await page.goBack();
    await page.waitForFunction(() => window.__mv.modals === 0);
    assert.equal(page.url(), url0, 'Back stayed in the app');
    await menu(page, 'settings');
    await page.uncheck('.modal .check input >> nth=0');
    await page.click('.modal .btn:has-text("Restart all streams")');
    await page.waitForFunction(() => window.__players.length >= 2);
    assert.equal(await page.evaluate(() => window.__players[window.__players.length - 1].ds.url), `ws://${new URL(page.url()).host}/ws/stream/p1/1.ts?buf=8&failover=0`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('providers window: usage, add a provider (test fills max connections), password never shown', async () => {
    const { ctx, page, errors } = await openPage();
    assert.match(await page.textContent('#sm-providers'), /Providers\s+0\/3/);
    await menu(page, 'providers');
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
    await page.waitForFunction(() => /Providers\s+\d\/6/.test(document.querySelector('#sm-providers').textContent));
    // wrong password shows the provider's message
    await menu(page, 'providers');
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

  test('tap brings the player controls up over the screen; they hide after 5 s idle and stay while there is movement', async () => {
    const { ctx, page } = await openPage({ state: { layout: '1', tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }] } });
    assert.equal(await page.evaluate(() => window.__mv.ovl.shown), false, 'hidden at first');
    await page.click('.tile[data-idx="0"]', { position: { x: 400, y: 300 } });
    assert.equal(await page.evaluate(() => window.__mv.ovl.shown), true, 'a tap shows them');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('ovl')).visibility), 'visible');
    for (let i = 0; i < 4; i++) { await page.waitForTimeout(2000); await page.mouse.move(300 + i * 5, 300); }
    assert.equal(await page.evaluate(() => window.__mv.ovl.shown), true, 'movement keeps them up');
    await page.waitForFunction(() => !window.__mv.ovl.shown, null, { timeout: 9000 });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('ovl')).visibility), 'hidden');
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
    assert.match(await page.textContent('#sm-providers'), /Add a provider/);
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

  test('guide: grid with programmes, pick from it, "now" shows under the channel name, programme search', async () => {
    const { ctx, page, errors } = await openPage({ viewport: { width: 1600, height: 1000 } });
    await page.evaluate(() => window.__mv.setLayout('1'));
    await page.click('.tile[data-idx="0"]');   // an empty tile opens the picker
    await page.waitForSelector('.modal .tabs');
    await page.selectOption('select[aria-label="Provider"]', 'p1');
    await page.click('.tab:has-text("Guide")');
    await page.waitForSelector('.guide .grow .prog');
    const row1 = await page.$$eval('.guide .grow:nth-child(2) .prog', (e) => e.map((x) => x.textContent));
    assert.ok(row1.includes('Now Show 1-1 & Friends'), row1.join('|'));
    assert.equal(await page.locator('.guide .gruler span').count(), 6);
    // right arrow moves along the row, down moves to the next channel at the same time
    await page.focus('.guide .grow:nth-child(2) .gch');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.className.includes('prog')), true);
    await page.keyboard.press('ArrowDown');
    const act = await page.evaluate(() => ({ key: document.activeElement.getAttribute('data-key'), cls: document.activeElement.className }));
    assert.equal(act.key, 'p1:2');
    // choose a programme: the channel goes onto the tile
    await page.click('.guide .grow:nth-child(2) .prog.now');
    await page.waitForFunction(() => window.__mv.S.tiles[0] && window.__mv.S.tiles[0].sid === '1');
    await page.waitForFunction(() => /Now: Now Show 1-1/.test(document.querySelector('.tile[data-idx="0"] .label').textContent), null, { timeout: 6000 });
    // programme search
    await page.keyboard.press('c');
    await page.waitForSelector('.modal .tabs');
    assert.equal(await page.evaluate(() => document.querySelector('.tab.on').textContent), 'Guide', 'the picker reopens on the Guide tab');
    await page.fill('.search', 'now show 2');
    await page.waitForFunction(() => document.querySelectorAll('.chlist .ch .pick').length >= 1);
    assert.match(await page.textContent('.chlist .ch .nm'), /Now Show 2-1/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('movies and series: lists, categories, a movie goes to a tile as a file, episodes by season', async () => {
    const { ctx, page, errors } = await openPage();
    await page.evaluate(() => window.__mv.setLayout('1'));
    await page.click('.tile[data-idx="0"]');   // an empty tile opens the picker
    await page.waitForSelector('.modal .tabs');
    await page.click('.tab:has-text("Movies")');
    await page.waitForFunction(() => document.querySelectorAll('.chlist .pick').length === 2);
    assert.equal(await page.inputValue('select[aria-label="Provider"]'), 'p1', 'movies need one provider: the first is chosen');
    assert.deepEqual(await page.$$eval('select[aria-label="Category"] option', (o) => o.map((x) => x.textContent)), ['All categories', 'Action', 'Comedy']);
    await page.selectOption('select[aria-label="Category"]', 'Action');
    assert.equal(await page.locator('.chlist .pick').count(), 1);
    await page.click('.chlist .pick');
    await page.waitForFunction(() => window.__mv.S.tiles[0] && window.__mv.S.tiles[0].vod === 'movie');
    const cfg = await page.evaluate(() => window.__mv.S.tiles[0]);
    assert.deepEqual(cfg, { p: 'p1', sid: 'movie:501', name: 'Big Movie', icon: '', vod: 'movie', ext: 'mp4' });
    const src = await page.evaluate(() => document.querySelector('.tile[data-idx="0"] video').getAttribute('src'));
    assert.ok(src.endsWith('/vod/p1/movie%3A501.mp4'), src);
    assert.equal(await page.evaluate(() => window.__players.length), 0, 'a movie does not use the live player');
    assert.equal(await page.evaluate(() => document.querySelector('.tile[data-idx="0"] video').controls), false, 'the overlay is the only control bar');
    // series -> episodes
    await page.keyboard.press('c');
    await page.waitForSelector('.modal .tabs');
    await page.click('.tab:has-text("Series")');
    await page.waitForFunction(() => document.querySelectorAll('.chlist .pick').length === 1);
    await page.click('.chlist .pick');
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 2 && document.querySelectorAll('.modal-back:last-of-type .pick').length === 2);
    assert.deepEqual(await page.$$eval('.modal-back:last-of-type select option', (o) => o.map((x) => x.textContent)), ['Season 1 (2 episodes)', 'Season 2 (1 episodes)']);
    await page.selectOption('.modal-back:last-of-type select', '1');
    await page.waitForFunction(() => document.querySelectorAll('.modal-back:last-of-type .pick').length === 1);
    await page.click('.modal-back:last-of-type .pick');
    await page.waitForFunction(() => window.__mv.S.tiles[0] && window.__mv.S.tiles[0].vod === 'series');
    const ep = await page.evaluate(() => window.__mv.S.tiles[0]);
    assert.equal(ep.sid, 'series:9003');
    assert.equal(ep.ext, 'mkv');
    assert.equal(ep.name, 'Long Show S2E1 Return');
    assert.equal(await page.evaluate(() => window.__mv.modals), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('long buffer: settings offer minutes, the stream asks for that much, a memory note appears', async () => {
    const { ctx, page, errors } = await openPage({ state: { layout: '1', tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }], bufSec: 4 } });
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.getElementById('sm-settings').click());
    await page.waitForSelector('.modal h2');
    const opts = await page.$$eval('.modal select:nth-of-type(1) option', (o) => o.map((x) => x.value));
    assert.ok(opts.includes('300') && opts.includes('120') && opts.includes('60'), opts.join(','));
    await page.selectOption('.modal select >> nth=0', '120');
    assert.match(await page.textContent('#mem-note'), /2 minutes/);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__mv.tiles[0].reload());
    await page.waitForFunction(() => window.__players.length === 2);
    assert.match(await page.evaluate(() => window.__players[1].ds.url), /\?buf=120$/);
    // a 2 minute start waits for ~96 s of video and keeps asking while data arrives
    await page.evaluate(() => { document.querySelector('video').__ahead = 40; });
    await page.waitForTimeout(900);
    assert.match(await page.textContent('.tile .status'), /Buffering 40 \/ 96 s/);
    assert.equal(await page.evaluate(() => window.__calls.filter((c) => c[0] === 'play').length), 0);
    await page.evaluate(() => { document.querySelector('video').__ahead = 97; });
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'play'), null, { timeout: 3000 });
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('capture card: add one in the providers window, it becomes a provider with a source', async () => {
    const { ctx, page, errors } = await openPage();
    await page.evaluate(() => document.getElementById('sm-providers').click());
    await page.waitForSelector('.modal .foot .btn:has-text("Add capture card")');
    await page.click('.modal .foot .btn:has-text("Add capture card")');
    await page.waitForSelector('.srcbox');
    await page.waitForFunction(() => /No video devices|Video devices seen/.test(document.querySelector('.modal .note').textContent));
    const inputs = await page.$$('.srcbox input[type=text]');
    await inputs[0].fill('Test card');
    await inputs[1].fill('test');
    await inputs[2].fill('test');
    await page.click('.modal .foot .btn:has-text("Test")');
    await page.waitForSelector('.msg.ok, .msg.bad');
    await page.click('.modal .foot .btn.on');
    await page.waitForFunction(() => /Capture card/.test(document.body.textContent));
    const provs = await page.evaluate(() => fetch('/api/providers').then((r) => r.json()));
    const cap = provs.providers.find((p) => p.type === 'local');
    assert.ok(cap);
    assert.deepEqual(cap.sources.map((x) => [x.name, x.video, x.audio]), [['Test card', 'test', 'test']]);
    // clean up so other tests see the original providers
    const restore = [
      { id: 'p1', name: 'Alpha', url: p1.url, username: 'u1', password: 'pw1', maxConnections: 2 },
      { id: 'p2', name: 'Beta', url: p2.url, username: 'u2', password: 'pw2', maxConnections: 1 },
    ];
    await page.evaluate((list) => fetch('/api/providers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: list }) }), restore);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
  test('overlays hide after 5 s idle; the sound marker is pastel red and absent with one screen', async () => {
    const { ctx, page, errors } = await openPage({ state: { layout: '2x2', sel: 1, tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }, { p: 'p1', sid: '2', name: 'CNN' }, null, null] } });
    await page.waitForFunction(() => window.__players.length === 2);
    await page.mouse.move(100, 100);
    const css = () => page.evaluate(() => ({
      bar: document.body.classList.contains('idle'),
      speaker: getComputedStyle(document.querySelector('.tile:nth-child(2) .speaker')).display,
      speakerBg: getComputedStyle(document.querySelector('.tile:nth-child(2) .speaker')).backgroundColor,
      labelOp: getComputedStyle(document.querySelector('.tile:nth-child(2) .label')).opacity,
      box: getComputedStyle(document.querySelector('.tile:nth-child(2)'), '::after').boxShadow,
    }));
    let c = await css();
    assert.equal(c.bar, false);
    assert.equal(c.speaker, 'block');
    assert.match(c.speakerBg, /rgb\(244, 166, 166\)/, 'pastel red bubble');
    assert.match(c.box, /rgba\(244, 166, 166, [\d.]+\) 0px 0px 0px 2px inset/, 'thin pastel red box');
    assert.equal(c.labelOp, '1');
    await page.waitForTimeout(5600);
    c = await css();
    assert.equal(c.bar, true, 'idle: names and sound marker hidden');
    assert.equal(c.speaker === 'block' && Number(await page.evaluate(() => getComputedStyle(document.querySelector('.tile:nth-child(2) .speaker')).opacity)) > 0.01, false, 'bubble hidden');
    assert.equal(Number(c.labelOp) < 0.01, true, 'channel name hidden');
    await page.mouse.move(300, 300);
    await page.waitForTimeout(400);
    c = await css();
    assert.equal(c.bar, false, 'any input brings them back');
    assert.equal(c.labelOp, '1');
    await page.evaluate(() => window.__mv.setLayout('1'));
    assert.equal(await page.evaluate(() => document.body.classList.contains('single')), true);
    await page.waitForTimeout(300); // the outline fades out over 80 ms
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.tile .speaker')).display), 'none', 'no bubble with one screen');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.tile'), '::after').boxShadow), 'none', 'no box with one screen');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('small tiles ask for SD; the big tile and per-tile choices do not', async () => {
    const { ctx, page, errors } = await openPage({ state: { layout: '1+7', tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }, { p: 'p1', sid: '2', name: 'CNN' }, { p: 'p1', sid: '3', name: 'BBC', q: 'full' }, { p: 'p1', sid: '4', name: 'W', q: 'sd' }] } });
    await page.waitForFunction(() => window.__players.length === 4);
    const urls = await page.evaluate(() => window.__players.map((p) => p.ds.url));
    const has = (sid) => urls.find((u) => u.includes('/p1/' + sid + '.ts'));
    assert.doesNotMatch(has('1'), /q=sd/, 'the big tile plays as chosen');
    assert.match(has('2'), /q=sd/, 'a small tile asks for SD');
    assert.doesNotMatch(has('3'), /q=sd/, 'As chosen wins');
    assert.match(has('4'), /q=sd/, 'SD wins');
    // zooming a small tile makes it big: it restarts without SD
    await page.evaluate(() => window.__mv.toggleZoom(1));
    await page.waitForFunction(() => window.__players.some((p) => !p.destroyed && p.ds.url.includes('/p1/2.ts') && !p.ds.url.includes('q=sd')));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('480p tile choice falls back to the original stream when the server has no GPU', async () => {
    const { ctx, page, errors } = await openPage({ state: { layout: '1', tiles: [{ p: 'p1', sid: '1', name: 'ESPN', q: '480' }] } });
    await page.waitForFunction(() => window.__players.length === 1);
    assert.match(await page.evaluate(() => window.__players[0].ds.url), /\/ws\/stream\/p1\/1\.ts/);
    assert.match(await page.textContent('#banner'), /480p transcode not available/);
    assert.deepEqual(errors.filter((e) => !/503|Service Unavailable/.test(e)), []);
    await ctx.close();
  });

  test('shared screen: tiles do not play on their own, one player gets the composed stream, and it falls back when refused', async () => {
    const { ctx, page, errors } = await openPage({ state: { layout: '2x2', shared: '480', sel: 0, tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }, { p: 'p1', sid: '2', name: 'CNN' }, null, null] } });
    await page.waitForFunction(() => window.__players.length === 1, null, { timeout: 5000 });
    const url = await page.evaluate(() => window.__players[0].ds.url);
    assert.match(url, /\/ws\/compose\/[0-9a-f]{16}$/);
    assert.equal(await page.evaluate(() => document.body.classList.contains('shared')), true);
    assert.equal(await page.evaluate(() => !!document.querySelector('#shared')), true);
    // moving the sound to tile 2 changes the picture description and restarts the shared stream
    await page.evaluate(() => window.__mv.select(1));
    await page.waitForFunction(() => window.__players.length === 2, null, { timeout: 5000 });
    assert.notEqual(await page.evaluate(() => window.__players[1].ds.url), url);
    // turning it off gives every tile its own player again
    await page.evaluate(() => { window.__mv.S.shared = ''; window.__mv.sharedApply(); });
    await page.waitForFunction(() => window.__players.filter((p) => !p.destroyed).length === 2, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.body.classList.contains('shared')), false);
    assert.deepEqual(errors.filter((e) => !/503|Service Unavailable/.test(e)), []);
    await ctx.close();
  });

  const publishedView = { id: 'v1', rev: 1, name: 'Game day', layout: '2x2', mode: 'stream',
    tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }, { p: 'p1', sid: '2', name: 'CNN' }, null, null, null, null, null, null, null],
    stream: { res: 720, cols: 2, rows: 2, aspect: 16 / 9, fit: 'contain', audio: 1, cells: [{ x: 1, y: 1, w: 1, h: 1, p: 'p1', sid: '1', sd: false }, { x: 2, y: 1, w: 1, h: 1, p: 'p1', sid: '2', sd: false }] } };

  test('published as one stream: the viewer plays the single picture exactly as published and cannot zoom it', async () => {
    const { ctx, page, errors } = await openPage({ state: { layout: '2x2', tiles: [null, null, null, null] } });
    await page.evaluate((v) => window.__mv.applyView(v), publishedView);
    await page.waitForFunction(() => window.__players.length === 1, null, { timeout: 5000 });
    assert.match(await page.evaluate(() => window.__players[0].ds.url), /\/ws\/compose\/[0-9a-f]{16}$/);
    assert.equal(await page.evaluate(() => document.body.classList.contains('shared')), true);
    // the picture is fixed: selecting the other tile does not restart it, zoom is ignored
    await page.evaluate(() => window.__mv.select(0));
    await page.evaluate(() => window.__mv.toggleZoom(0));
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => window.__players.length), 1);
    assert.equal(await page.evaluate(() => window.__mv.zoom), -1);
    // a layout-only version of the same multiview plays the tiles on their own
    await page.evaluate((v) => window.__mv.applyView(Object.assign({}, v, { rev: 2, mode: 'layout', stream: undefined })), publishedView);
    await page.waitForFunction(() => window.__players.filter((p) => !p.destroyed && /\/stream\/p1\/[12]\.ts/.test(p.ds.url)).length === 2, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.body.classList.contains('shared')), false);
    assert.deepEqual(errors.filter((e) => !/503|Service Unavailable/.test(e)), []);
    await ctx.close();
  });

  test('published as one stream: with no free slot the viewer is told and gets the layout with their own tiles', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block' });
    await ctx.route('**/vendor/mpegts.js', (route) => route.fulfill({ contentType: 'text/javascript', body: FAKE_MPEGTS }));
    await ctx.addInitScript(MEDIA_STUBS);
    await ctx.route('**/api/compose', (route) => route.request().method() !== 'POST' ? route.continue() : route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'compose_limit', message: 'Already composing 2 shared screen(s) (limit 2)' }) }));
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForFunction(() => window.__mv && window.__mv.tiles.length === 9 && window.__mv.ME);
    await page.evaluate((v) => window.__mv.applyView(v), publishedView);
    await page.waitForFunction(() => /not available/.test(document.getElementById('banner').textContent), null, { timeout: 8000 });
    assert.match(await page.textContent('#banner'), /showing its layout with your own tiles/);
    await page.waitForFunction(() => window.__players.filter((p) => !p.destroyed && /\/stream\/p1\/[12]\.ts/.test(p.ds.url)).length === 2, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.body.classList.contains('shared')), false);
    await ctx.close();
  });

  test('publish dialog offers layout only or the screen as one stream, and stores the picture description', async () => {
    const { ctx, page, errors } = await openPage({ state: { layout: '2x2', sel: 1, tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }, { p: 'p1', sid: '2', name: 'CNN' }, null, null] } });
    const before = app.views.views.length;
    await menu(page, 'views');
    await page.click('text=Publish my current screen...');
    await page.waitForSelector('#pub-stream');
    assert.equal(await vis2(page, '#pub-res'), false, 'quality only matters for the one-stream version');
    await page.fill('.modal input[type=text]', 'One picture');
    await page.check('#pub-stream');
    assert.equal(await vis2(page, '#pub-res'), true);
    await page.selectOption('#pub-res', '480');
    await page.click('.modal .btn.primary');
    await page.waitForFunction(() => /Published/.test(document.getElementById('banner').textContent));
    const v = app.views.views[app.views.views.length - 1];
    assert.equal(app.views.views.length, before + 1);
    assert.equal(v.mode, 'stream');
    assert.equal(v.stream.res, 480);
    assert.equal(v.stream.cells.length, 2);
    assert.equal(v.stream.audio, 1, 'the sound of the selected tile at publishing time');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('shared screen: a compose_failed 502 shows a readable message, retries with backoff, then stops and keeps the message', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block' });
    await ctx.route('**/vendor/mpegts.js', (route) => route.fulfill({ contentType: 'text/javascript', body: FAKE_MPEGTS }));
    await ctx.addInitScript(MEDIA_STUBS);
    await ctx.addInitScript('window.__mvSharedBackoff = [300, 300]; window.__mvSharedDebounce = 100;');
    await ctx.addInitScript(`if (!localStorage.getItem('mv.state.v1')) localStorage.setItem('mv.state.v1', ${JSON.stringify(JSON.stringify({ layout: '2x2', shared: '480', sel: 0, tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }, { p: 'p1', sid: '2', name: 'CNN' }, null, null] }))});`);
    let posts = 0;
    let lastBody = null;
    await ctx.route('**/api/compose', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts++;
      lastBody = route.request().postDataJSON();
      route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'compose_failed', message: 'Composer failed: input 2 has no usable video' }) });
    });
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForFunction(() => window.__mv && window.__mv.tiles.length === 9 && window.__mv.ME);
    await page.waitForSelector('#sharedmsg:not([hidden])', { timeout: 5000 });
    assert.match(await page.textContent('#sharedmsg'), /input 2 has no usable video/);
    assert.ok(lastBody.aspect > 1 && lastBody.aspect < 2.4 && lastBody.fit === 'contain', 'the request says what shape the picture has');
    await page.waitForFunction(() => /unavailable/.test(document.querySelector('#sharedmsg').textContent), null, { timeout: 8000 });
    const done = posts;
    assert.equal(done, 3, 'first try plus two retries');
    await page.waitForTimeout(1500);
    assert.equal(posts, done, 'no more requests after the backoff is used up');
    assert.equal(await page.isVisible('#sharedmsg'), true, 'the message stays');
    assert.match(await page.textContent('#sharedmsg'), /input 2 has no usable video/);
    assert.equal(await page.evaluate(() => document.body.classList.contains('shared')), false, 'tiles play on their own again');
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

  const menu = (page, id) => page.evaluate((i) => document.getElementById('sm-' + i).click(), id);
  async function newPage() {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, serviceWorkers: 'block' });
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
    await menu(page, 'settings');
    await page.click('#set-users');
    await page.fill('.modal input[type=text]', 'boss');
    await page.fill('.modal input[type=password]', 'hunter22');
    await Promise.all([page.waitForNavigation(), page.click('text=Create admin and turn on logins')]);
    await page.waitForFunction(() => window.__mv && window.__mv.ME);
    assert.equal(await page.evaluate(() => window.__mv.ME.user.username), 'boss');
    // add a viewer
    await menu(page, 'settings');
    await page.click('#set-users');
    await page.click('text=Add user');
    await page.fill('.modal input[type=text]', 'alice');
    await page.fill('.modal input[type=password]', 'alicepw1');
    await page.click('.modal .btn.primary');
    await page.waitForSelector('.modal .prov b:text("alice")');
    await page.keyboard.press('Escape');
    // publish
    await menu(page, 'views');
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
    await v.page.waitForFunction(() => /^Game day/.test(document.getElementById('view-title').textContent));
    const state = await v.page.evaluate(() => ({ layout: window.__mv.S.layout, admin: window.__mv.ME.admin, urls: window.__players.map((p) => p.ds.url) }));
    assert.equal(state.admin, false);
    assert.equal(state.layout, '2x2');
    assert.equal(state.urls.length, 2);
    assert.match(state.urls[0], /^ws:\/\/[^/]+\/ws\/stream\/p1\/1\.ts/);
    // viewer chrome: no layout buttons, no providers, cannot add channels
    assert.equal(await v.page.evaluate(() => document.getElementById('ov-o-layout').closest('.ov-opt').hidden), true, 'no layout choices for viewers');
    assert.equal(await v.page.evaluate(() => document.getElementById('ov-guide').hidden), true, 'no channel guide for viewers');
    assert.equal(await v.page.evaluate(() => document.getElementById('sm-providers').hidden), true, 'no providers for viewers');
    assert.equal(await v.page.evaluate(() => document.getElementById('sm-recs').hidden), false, 'recordings are for everyone');
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
    await Promise.all([v.page.waitForNavigation(), v.page.evaluate(() => document.getElementById('sm-logout').click())]);
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

describe('real player, many streams, picker categories', () => {
  let browser;
  let app;
  let base;
  let dir;
  let p1;

  before(async () => {
    const files = {};
    if (CLIP) for (let i = 1; i <= 9; i++) files[i] = { path: CLIP, seconds: 40 };
    p1 = new MockProvider({ user: 'u1', pass: 'pw1', max: 12, kbps: 1000, channels: [
      { id: 1, name: 'US| ESPN HD', cat: '10' }, { id: 2, name: 'US| CNN FHD', cat: '10' }, { id: 3, name: 'UK| BBC One', cat: '20' }, { id: 4, name: 'Weather', cat: '99' },
    ] });
    p1.files = CLIP ? files : undefined;
    await p1.listen();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-ui3-'));
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ providers: [{ id: 'a', name: 'A', url: p1.url, username: 'u1', password: 'pw1', maxConnections: 12 }] }));
    app = createApp({ dataDir: dir, basicAuth: '', relay: { idleMs: 300 } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    await app.lists.get(app.config.get('a'));
    browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  });
  after(async () => {
    await browser.close();
    app.close();
    await p1.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('nine real mpegts.js players over WebSocket (workers on): provider sees nine, page requests stay instant', { skip: !CLIP && 'needs CLIP_TS' }, async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForFunction(() => window.__mv && window.__mv.ME);
    const res = await page.evaluate(async () => {
      const failures = [];
      window.__ps = [];
      for (let i = 1; i <= 9; i++) {
        const v = document.createElement('video'); v.muted = true; document.body.appendChild(v);
        const pl = window.mpegts.createPlayer({ type: 'mpegts', isLive: true, url: `ws://${location.host}/ws/stream/a/${i}.ts?buf=2` }, { enableWorker: true });
        pl.on(window.mpegts.Events.ERROR, (t, d, info) => { if (!/Codec|MSE|Media/i.test(String(d))) failures.push(`${i}: ${t}/${d} ${info && info.msg}`); });
        pl.attachMediaElement(v); pl.load(); window.__ps.push(pl);
      }
      await new Promise((r) => setTimeout(r, 2500));
      const t0 = performance.now();
      const r = await fetch('/api/me');
      return { status: r.status, ms: Math.round(performance.now() - t0), failures };
    });
    assert.equal(res.status, 200);
    assert.ok(res.ms < 500, `API answered in ${res.ms} ms with nine streams open`);
    assert.deepEqual(res.failures, []);
    assert.equal(p1.opened.filter((x) => /^[1-9]$/.test(x)).length >= 9, true, 'provider saw all nine channels');
    await ctx.close();
  });

  test('single provider: category dropdown is on and filters; provider without categories falls back to name prefixes', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
    await ctx.route('**/vendor/mpegts.js', (route) => route.fulfill({ contentType: 'text/javascript', body: FAKE_MPEGTS }));
    await ctx.addInitScript(MEDIA_STUBS);
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForFunction(() => window.__mv && window.__mv.ME);
    await page.click('.tile[data-idx="0"]');   // an empty tile opens the picker
    await page.waitForSelector('.chlist .ch');
    const opts = await page.$$eval('select[aria-label="Category"] option', (o) => o.map((x) => x.textContent));
    assert.equal(await page.$eval('select[aria-label="Category"]', (s) => s.disabled), false);
    assert.deepEqual(opts, ['All categories', 'US', 'UK', 'Other']);
    await page.selectOption('select[aria-label="Category"]', 'UK');
    assert.equal(await page.locator('.chlist .ch').count(), 1);
    await ctx.close();

    // no categories from the provider: names come from "US|" style prefixes
    p1.noCategories = true;
    app.lists.forget('a');
    const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
    await ctx2.route('**/vendor/mpegts.js', (route) => route.fulfill({ contentType: 'text/javascript', body: FAKE_MPEGTS }));
    await ctx2.addInitScript(MEDIA_STUBS);
    const page2 = await ctx2.newPage();
    await page2.goto(base);
    await page2.waitForFunction(() => window.__mv && window.__mv.ME);
    await page2.click('.tile[data-idx="0"]');   // an empty tile opens the picker
    await page2.waitForSelector('.chlist .ch');
    const opts2 = await page2.$$eval('select[aria-label="Category"] option', (o) => o.map((x) => x.textContent));
    assert.deepEqual(opts2, ['All categories', 'Other', 'UK', 'US']);
    p1.noCategories = false;
    await ctx2.close();
  });

});

describe('browser: picker remembers its place', () => {
  let browser; let app; let base; let dir; let big;
  before(async () => {
    const channels = [];
    for (let i = 1; i <= 600; i++) channels.push({ id: 1000 + i, name: `Chan ${String(i).padStart(3, '0')}`, cat: i <= 300 ? '10' : '20' });
    big = await new MockProvider({ user: 'u', pass: 'p', max: 2, kbps: 500, channels }).listen();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-pk-'));
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ providers: [{ id: 'big', name: 'Big', url: big.url, username: 'u', password: 'p', maxConnections: 2 }] }));
    app = createApp({ dataDir: dir, basicAuth: '', relay: { idleMs: 500 } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    await app.lists.get(app.config.get('big'));
    browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  });
  after(async () => { await browser.close(); app.close(); await big.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  async function page1() {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
    await ctx.route('**/vendor/mpegts.js', (route) => route.fulfill({ contentType: 'text/javascript', body: FAKE_MPEGTS }));
    await ctx.addInitScript(MEDIA_STUBS);
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForFunction(() => window.__mv && window.__mv.ME);
    return { ctx, page };
  }

  test('category, search, rows expanded and the chosen channel are restored (also after a reload)', async () => {
    const { ctx, page } = await page1();
    await page.click('.tile[data-idx="0"]');   // an empty tile opens the picker
    await page.waitForSelector('.chlist .ch');
    await page.selectOption('select[aria-label="Category"]', 'UK');
    for (let i = 0; i < 2; i++) {
      await page.click('.more-row .btn');
    }
    const picks = page.locator('.chlist .pick');
    assert.equal(await picks.count(), 300, 'UK has 300 channels: 100 + 2 x 150 shown');
    const target = page.locator('.chlist .pick', { hasText: 'Chan 520' });
    await target.scrollIntoViewIfNeeded();
    await target.click();
    await page.waitForFunction(() => window.__mv.S.tiles[0] && window.__mv.S.tiles[0].name === 'Chan 520');
    assert.equal(await page.evaluate(() => window.__mv.modals), 0);

    for (const reload of [false, true]) {
      if (reload) {
        await page.waitForTimeout(400);
        await page.reload();
        await page.waitForFunction(() => window.__mv && window.__mv.ME);
      }
      await page.evaluate(() => window.__mv.select(1)); await page.click('.tile[data-idx="1"]');   // an empty tile opens the picker
      await page.waitForSelector('.chlist .ch .pick');
      assert.equal(await page.inputValue('select[aria-label="Category"]'), 'UK', 'category remembered');
      await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-key') === 'big:1520');
      assert.equal(await page.locator('.chlist .pick').count(), 300, 'expanded rows remembered');
      const inView = await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); const b = document.querySelector('.modal .body').getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1; });
      assert.equal(inView, true, 'the last channel is scrolled into view');
      await page.keyboard.press('Escape');
    }
  });

  test('closing without choosing keeps filters and scroll; Reset filters clears them', async () => {
    const { ctx, page } = await page1();
    await page.click('.tile[data-idx="0"]');   // an empty tile opens the picker
    await page.waitForSelector('.chlist .ch');
    await page.fill('.search', 'Chan 07');
    await page.waitForFunction(() => document.querySelectorAll('.chlist .pick').length === 16);
    await page.click('.modal .btn:has-text("Favorites")');
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.keyboard.press('c');
    await page.waitForSelector('.modal .search');
    assert.equal(await page.inputValue('.search'), 'Chan 07');
    assert.equal(await page.evaluate(() => document.querySelector('.modal .btn.on:not(.tab)') !== null), true, 'favorites toggle is remembered');
    await page.click('.modal .btn:has-text("Reset filters")');
    assert.equal(await page.inputValue('.search'), '');
    await page.waitForFunction(() => document.querySelectorAll('.chlist .pick').length === 100);
    await page.keyboard.press('Escape');
    const pk = await page.evaluate(() => window.__mv.S.pk);
    assert.equal(pk.q, '');
    assert.equal(pk.favs, false);
    assert.equal(pk.last, '');
    await ctx.close();
  });
});

describe('player overlay, pull-out menu, recordings, PWA', () => {
  let browser;
  let app;
  let base;
  let dir;
  let p1;
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json'), 'utf8'));

  before(async () => {
    p1 = await new MockProvider({ user: 'u1', pass: 'pw1', max: 3, kbps: 1000, channels: [
      { id: 1, name: 'US| ESPN HD', cat: '10' }, { id: 2, name: 'US| CNN FHD', cat: '10' }, { id: 3, name: 'UK| BBC One', cat: '20' },
    ] }).listen();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-ui3-'));
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ providers: [{ id: 'p1', name: 'Alpha', url: p1.url, username: 'u1', password: 'pw1', maxConnections: 3 }] }));
    app = createApp({ dataDir: dir, basicAuth: '', relay: { idleMs: 300 }, recTickMs: 500 });
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

  async function open(state, { viewport = { width: 1600, height: 900 }, sw = 'block', init = '' } = {}) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: sw });
    if (sw === 'block') {
      await ctx.route('**/vendor/mpegts.js', (route) => route.fulfill({ contentType: 'text/javascript', body: FAKE_MPEGTS }));
      await ctx.addInitScript(MEDIA_STUBS);
    }
    if (init) await ctx.addInitScript(init);
    if (state) await ctx.addInitScript(`if (!localStorage.getItem('mv.state.v1')) localStorage.setItem('mv.state.v1', ${JSON.stringify(JSON.stringify(state))});`);
    const errors = [];
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
    await page.goto(base);
    await page.waitForFunction(() => window.__mv && window.__mv.tiles.length === 9 && window.__mv.ME);
    return { ctx, page, errors };
  }
  const two = { layout: '2x2', sel: 0, tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }, { p: 'p1', sid: '2', name: 'CNN' }, null, null] };
  const one = { layout: '1', sel: 0, tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }] };
  const vis = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden'; }, sel);
  const centre = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });

  test('tap rules: hidden controls just come up; then the active screen zooms and an inactive one only becomes active', async () => {
    const { ctx, page, errors } = await open(two);
    await page.waitForFunction(() => window.__players.length === 2);
    const sel = () => page.evaluate(() => window.__mv.S.sel);
    const zoom = () => page.evaluate(() => window.__mv.zoom);
    await page.click('.tile[data-idx="1"]');
    await page.waitForFunction(() => window.__mv.ovl.shown);
    assert.equal(await sel(), 0, 'controls were hidden: the tap did not select');
    assert.equal(await zoom(), -1);
    await page.click('.tile[data-idx="1"]');
    assert.equal(await sel(), 1, 'controls up: tapping an inactive screen makes it active');
    assert.equal(await zoom(), -1, '... without zooming');
    await page.click('.tile[data-idx="1"]');
    await page.waitForFunction(() => window.__mv.zoom === 1);
    await page.mouse.click(300, 300); // away from the controls in the middle
    await page.waitForFunction(() => window.__mv.zoom === -1);
    // hide the controls: tapping the active screen only brings them up
    await page.evaluate(() => window.__mv.ovlHide());
    await page.click('.tile[data-idx="1"]');
    await page.waitForFunction(() => window.__mv.ovl.shown);
    assert.equal(await zoom(), -1);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('tapping a screen brings up the controls where the design says they go', async () => {
    const { ctx, page, errors } = await open(two);
    await page.waitForFunction(() => window.__players.length === 2);
    assert.equal(await vis(page, '#ov-play'), false, 'hidden until tapped');
    await page.click('.tile[data-idx="1"]');
    await page.waitForFunction(() => window.__mv.ovl.shown);
    assert.equal(await page.evaluate(() => window.__mv.S.sel), 0, 'the first tap only brought the controls up, it did not select the other screen');
    for (const id of ['#ov-guide', '#ov-pull', '#ov-back', '#ov-play', '#ov-fwd', '#ov-up', '#ov-down', '#ov-mute', '#ov-vol', '#ov-seek', '#ov-arrow']) assert.equal(await vis(page, id), true, id);
    assert.equal(await vis(page, '#ov-cast'), false, 'no cast icon when no cast device is around');
    const pos = {};
    for (const id of ['guide', 'pull', 'back', 'play', 'fwd', 'up', 'down', 'mute', 'seek', 'arrow']) pos[id] = await centre(page, '#ov-' + id);
    assert.ok(pos.guide.x < 200 && pos.guide.y < 100, 'change-channel button top left');
    assert.ok(pos.pull.x < 60 && Math.abs(pos.pull.y - 450) < 60, 'pull-out arrow on the left side');
    assert.ok(pos.back.x < pos.play.x && pos.play.x < pos.fwd.x && Math.abs(pos.play.x - 800) < 5 && Math.abs(pos.play.y - 450) < 5, 'play in the middle, skip back and forward either side');
    assert.ok(pos.up.x > 1500 && pos.down.x > 1500 && pos.up.y < pos.down.y, 'channel up and down on the right');
    assert.ok(pos.mute.x < 200 && pos.mute.y > 800, 'mute bottom left');
    assert.ok(pos.seek.y > 800 && pos.seek.x > pos.mute.x, 'progress bar along the bottom');
    assert.ok(pos.arrow.y > pos.seek.y - 5 && Math.abs(pos.arrow.x - 800) < 5, 'options arrow below the progress bar');
    assert.equal(await vis(page, '#ov-o-layout'), false, 'options are folded away');
    assert.equal(await page.evaluate(() => !!document.querySelector('#ov-arrow svg.ic-up')), true, 'arrow points up');
    await page.click('#ov-arrow');
    assert.equal(await page.evaluate(() => !!document.querySelector('#ov-arrow svg.ic-down')), true, 'arrow turns down when open');
    const order = await page.$$eval('#ov-opts .ov-opt > button', (b) => b.map((x) => x.id));
    assert.deepEqual(order, ['ov-o-layout', 'ov-o-expand', 'ov-o-quality', 'ov-o-reload', 'ov-o-fav', 'ov-o-rec', 'ov-o-dl']);
    const xs = [];
    for (const id of order) { assert.equal(await vis(page, '#' + id), true, id); xs.push((await centre(page, '#' + id)).x); }
    assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'left to right in the numbered order');
    assert.ok((await centre(page, '#ov-o-layout')).y < pos.seek.y, 'the row expands upward');
    assert.equal(await page.evaluate(() => document.querySelector('#ov-o-layout svg').getAttribute('viewBox')), '0 0 20 20', 'layout icon shows the 2 x 2 layout');
    assert.equal(await page.textContent('#ov-o-quality .ic-tv text'), 'AUTO');
    await page.click('#ov-arrow');
    assert.equal(await vis(page, '#ov-o-layout'), false, 'tapping again closes the row');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('the layout option holds every layout; expand is the magnifying glass and a second tap on the same tile does it too', async () => {
    const { ctx, page, errors } = await open(two);
    await page.click('.tile[data-idx="0"]');
    await page.click('#ov-arrow');
    await page.click('#ov-o-layout');
    assert.equal(await page.locator('#ov-o-layout ~ .ov-sub .ovitem.lay').count(), 5);
    await page.click('#ov-o-layout ~ .ov-sub .ovitem[data-layout="3x3"]');
    assert.equal(await page.evaluate(() => window.__mv.S.layout), '3x3');
    assert.equal(await page.evaluate(() => document.querySelector('#ov-o-layout svg').getAttribute('viewBox')), '0 0 30 30', 'the icon is the current layout');
    await page.click('#ov-o-expand');
    assert.equal(await page.evaluate(() => window.__mv.zoom), 0, 'expand zooms the selected tile');
    assert.equal(await page.evaluate(() => document.querySelector('#ov-o-expand').classList.contains('on')), true);
    await page.click('#ov-o-expand');
    assert.equal(await page.evaluate(() => window.__mv.zoom), -1);
    // tapping the already-selected tile again expands it (the controls are already up, so the first tap only selected)
    await page.evaluate(() => window.__mv.ovlHide());
    await page.click('.tile[data-idx="1"]');
    await page.waitForFunction(() => window.__mv.ovl.shown);
    const box = await page.$eval('.tile[data-idx="1"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20 }; });
    await page.mouse.click(box.x, box.y);    // controls up: an inactive tile only becomes active
    await page.waitForFunction(() => window.__mv.S.sel === 1);
    assert.equal(await page.evaluate(() => window.__mv.zoom), -1);
    await page.mouse.click(box.x, box.y);    // the active tile expands
    await page.waitForFunction(() => window.__mv.zoom === 1);
    await page.mouse.click(300, 300);
    await page.waitForFunction(() => window.__mv.zoom === -1);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('quality, reload, favourite', async () => {
    const { ctx, page, errors } = await open(one);
    await page.waitForFunction(() => window.__players.length === 1);
    await page.click('.tile[data-idx="0"]');
    await page.click('#ov-arrow');
    await page.click('#ov-o-quality');
    assert.equal(await page.locator('#ov-o-quality ~ .ov-sub .ovitem').count(), 4);
    await page.click('#ov-o-quality ~ .ov-sub .ovitem:has-text("SD when available")');
    assert.equal(await page.evaluate(() => window.__mv.S.tiles[0].q), 'sd');
    await page.waitForFunction(() => /q=sd/.test(window.__players[window.__players.length - 1].ds.url));
    assert.equal(await page.textContent('#ov-o-quality .ic-tv text'), 'SD');
    const n = await page.evaluate(() => window.__players.length);
    await page.click('#ov-o-reload');
    await page.waitForFunction((k) => window.__players.length === k + 1, n);
    assert.equal(await page.evaluate(() => !!document.querySelector('#ov-o-fav svg.ic-star')), true, 'outline star');
    await page.click('#ov-o-fav');
    assert.equal(await page.evaluate(() => !!window.__mv.S.favs['p1:1']), true);
    assert.equal(await page.evaluate(() => !!document.querySelector('#ov-o-fav svg.ic-starOn')), true, 'filled star');
    await page.click('#ov-o-fav');
    assert.equal(await page.evaluate(() => !!window.__mv.S.favs['p1:1']), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('play/pause, skip, progress bar and volume act on the selected tile; rewind restarts the stream behind live', async () => {
    const { ctx, page, errors } = await open(one);
    await page.waitForFunction(() => window.__players.length === 1);
    await page.click('.tile[data-idx="0"]');
    assert.equal(await page.evaluate(() => document.getElementById('ov-live').classList.contains('behind')), false, 'red LIVE while live');
    assert.equal(await page.textContent('#ov-live'), 'LIVE');
    // pause a live channel
    await page.click('#ov-play');
    assert.equal(await page.evaluate(() => window.__mv.tiles[0].userPaused), true);
    assert.equal(await page.evaluate(() => document.getElementById('ov-live').classList.contains('behind')), true, 'grey while paused');
    assert.equal(await page.evaluate(() => !!document.querySelector('#ov-play svg.ic-play')), true, 'shows play while paused');
    await page.click('#ov-play');
    assert.equal(await page.evaluate(() => window.__mv.tiles[0].userPaused), false);
    // not enough rewind recorded yet: a message, no restart
    const n0 = await page.evaluate(() => window.__players.length);
    await page.evaluate(() => { window.__mv.tiles[0].avail = 0; window.__mv.tiles[0].availAt = Date.now() + 60000; });
    await page.click('#ov-back');
    assert.match(await page.textContent('#banner'), /Rewind is not available yet/);
    assert.equal(await page.evaluate(() => window.__players.length), n0);
    // plenty recorded: back 10 s restarts the stream with ?back=10
    await page.evaluate(() => { window.__mv.tiles[0].avail = 300; });
    await page.click('#ov-back');
    await page.waitForFunction((k) => window.__players.length === k + 1, n0);
    assert.match(await page.evaluate(() => window.__players[window.__players.length - 1].ds.url), /&back=10$/);
    assert.match(await page.textContent('#ov-time'), /^-0:10$/);
    assert.equal(await page.evaluate(() => document.getElementById('ov-live').classList.contains('behind')), true, 'grey when 10 s behind live');
    await page.click('#ov-fwd');   // forward 30 from 10 behind live: clamps to live
    await page.waitForFunction((k) => window.__players.length === k + 2, n0);
    assert.doesNotMatch(await page.evaluate(() => window.__players[window.__players.length - 1].ds.url), /back=/);
    assert.equal(await page.textContent('#ov-time'), '');
    assert.equal(await page.evaluate(() => document.getElementById('ov-live').classList.contains('behind')), false);
    // tapping the grey LIVE box goes back to live
    await page.evaluate(() => { window.__mv.tiles[0].back = 40; });
    await page.evaluate(() => window.__mv.ovlShow());
    await page.waitForFunction(() => document.getElementById('ov-live').classList.contains('behind'));
    const nL = await page.evaluate(() => window.__players.length);
    await page.click('#ov-live');
    await page.waitForFunction((k) => window.__players.length === k + 1, nL);
    assert.doesNotMatch(await page.evaluate(() => window.__players[window.__players.length - 1].ds.url), /back=/);
    assert.equal(await page.evaluate(() => document.getElementById('ov-live').classList.contains('behind')), false);
    // dragging the bar to 100 s behind live
    await page.evaluate(() => { const s = document.getElementById('ov-seek'); s.value = String(300 - 100); s.dispatchEvent(new Event('change')); });
    await page.waitForFunction((k) => window.__players.length === k + 4, n0);
    assert.match(await page.evaluate(() => window.__players[window.__players.length - 1].ds.url), /&back=100$/);
    // paused for a while: resuming continues from where the viewer left off
    await page.evaluate(() => window.__mv.tiles[0].reload());
    await page.evaluate(() => { const t = window.__mv.tiles[0]; t.back = 0; });
    await page.click('#ov-play');
    await page.evaluate(() => { window.__mv.tiles[0].pausedAt = Date.now() - 20000; });
    const n1 = await page.evaluate(() => window.__players.length);
    await page.click('#ov-play');
    await page.waitForFunction((k) => window.__players.length === k + 1, n1);
    assert.match(await page.evaluate(() => window.__players[window.__players.length - 1].ds.url), /&back=(19|20|21)$/);
    // volume
    await page.evaluate(() => { const v = document.getElementById('ov-vol'); v.value = '40'; v.dispatchEvent(new Event('input')); });
    assert.equal(await page.evaluate(() => window.__mv.S.vol), 0.4);
    assert.equal(await page.evaluate(() => Math.round(window.__mv.tiles[0].video.volume * 100)), 40);
    await page.click('#ov-mute');
    assert.equal(await page.evaluate(() => window.__mv.S.muted), true);
    assert.equal(await page.evaluate(() => !!document.querySelector('#ov-mute svg.ic-mute')), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('channel up and down stay inside the category; guide button opens the change channel screen on the guide', async () => {
    const { ctx, page, errors } = await open(one);
    await page.click('.tile[data-idx="0"]');
    await page.click('#ov-down');
    await page.waitForFunction(() => window.__mv.S.tiles[0].sid === '2');
    await page.click('#ov-down');   // category US has two channels in this list: wraps to the first
    await page.waitForFunction(() => window.__mv.S.tiles[0].sid !== '2');
    assert.equal(await page.evaluate(() => window.__mv.S.tiles[0].sid), '1');
    await page.click('#ov-up');
    await page.waitForFunction(() => window.__mv.S.tiles[0].sid === '2');
    await page.click('.tile[data-idx="0"]');
    await page.waitForFunction(() => window.__mv.ovl.shown);
    await page.click('#ov-guide');
    await page.waitForSelector('.modal .tabs');
    assert.equal(await page.evaluate(() => document.querySelector('.tab.on').textContent.trim()), 'Guide');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('pull-out menu: Watch, Multiviews, Recordings & Downloads, Settings, Providers, Log out', async () => {
    const { ctx, page, errors } = await open(one);
    await page.click('.tile[data-idx="0"]');
    await page.click('#ov-pull');
    await page.waitForFunction(() => window.__mv.side.open);
    const items = await page.$$eval('#side .sideitem:not([hidden])', (b) => b.map((x) => x.textContent.trim().replace(/\s+/g, ' ')));
    assert.equal(items[0], 'Watch');
    assert.equal(items[1], 'Multiviews');
    assert.equal(items[2], 'Recordings & Downloads');
    assert.equal(items[3], 'Settings');
    assert.match(items[4], /^Providers/);
    assert.equal(items.length, 5, 'no Log out while logins are off');
    await page.click('#sm-watch');
    assert.equal(await page.evaluate(() => window.__mv.side.open || window.__mv.ovl.shown), false, 'Watch closes the menu and the overlays');
    await page.click('.tile[data-idx="0"]');
    await page.click('#ov-pull');
    await page.click('#sm-settings');
    await page.waitForSelector('.modal h2');
    assert.equal(await page.textContent('.modal h2'), 'Settings');
    assert.equal(await page.evaluate(() => window.__mv.side.open), false);
    assert.equal(await vis(page, '#set-users'), true, 'admin options live under Settings');
    assert.equal(await vis(page, '#set-full'), true);
    assert.equal(await vis(page, '#set-install-box'), true);
    await page.keyboard.press('Escape');
    await page.click('.tile[data-idx="0"]');
    await page.click('#ov-pull');
    await page.click('#sm-recs');
    await page.waitForSelector('.modal h2:has-text("Recordings")');
    await page.keyboard.press('Escape');
    // a tap outside closes it
    await page.click('.tile[data-idx="0"]');
    await page.click('#ov-pull');
    await page.mouse.click(1200, 400);
    await page.waitForFunction(() => !window.__mv.side.open);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('record: to the end of the event (with the stop time shown) or for a length; the Recordings screen lists, plays and deletes', async () => {
    const { ctx, page, errors } = await open(one);
    await page.click('.tile[data-idx="0"]');
    await page.click('#ov-arrow');
    await page.click('#ov-o-rec');
    await page.waitForSelector('#ov-o-rec ~ .ov-sub .ovitem');
    const labels = await page.$$eval('#ov-o-rec ~ .ov-sub .ovitem', (b) => b.map((x) => x.textContent));
    assert.match(labels[0], /^To end of ".+" - stops \d{1,2}:\d{2}/, labels[0]);
    assert.match(labels[1], /^30 minutes - stops/);
    await page.click('#ov-o-rec ~ .ov-sub .ovitem >> nth=0');
    await page.waitForFunction(() => /Recording .* until/.test(document.getElementById('banner').textContent));
    let items = app.recordings.list(null);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'live');
    assert.equal(items[0].sid, '1');
    // the event recording stops 60 minutes after the programme ends
    const ev = await app.recordings.eventNow('p1', '1');
    assert.ok(Math.abs(items[0].end - ev.recordUntil) < 5000);
    await page.evaluate(() => document.getElementById('sm-recs').click());
    await page.waitForSelector('.recrow');
    assert.match(await page.textContent('.recrow'), /Recording now|Scheduled/);
    await page.click('[data-act^="stop-"]');
    await page.waitForFunction(() => /Stopped|Saved|Failed/.test(document.querySelector('.recrow').textContent), null, { timeout: 15000 });
    await page.click('[data-act^="del-"]');
    await page.click('.modal .btn.primary:has-text("Delete")');
    await page.waitForFunction(() => !document.querySelector('.recrow'));
    assert.equal(app.recordings.list(null).length, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('download a movie to the server or to the device; a live channel offers recording instead', async () => {
    const vod = { layout: '1', sel: 0, tiles: [{ p: 'p1', sid: 'movie:501', name: 'Big Movie', vod: 'movie', ext: 'mp4' }] };
    const { ctx, page, errors } = await open(vod);
    await page.click('.tile[data-idx="0"]');
    assert.equal(await vis(page, '#ov-fwd'), true);
    await page.click('#ov-arrow');
    assert.equal(await page.evaluate(() => document.getElementById('ov-o-rec').disabled), true, 'a movie cannot be recorded');
    await page.click('#ov-o-dl');
    const subs = await page.$$eval('#ov-o-dl ~ .ov-sub .ovitem', (b) => b.map((x) => x.textContent));
    assert.deepEqual(subs, ['Download to the server', 'Download to this device']);
    await page.click('#ov-o-dl ~ .ov-sub .ovitem >> nth=0');
    await page.waitForFunction(() => /Downloading "Big Movie" to the server/.test(document.getElementById('banner').textContent));
    await page.waitForFunction(() => true);
    const d = app.recordings.list(null).filter((x) => x.kind === 'download');
    assert.equal(d.length, 1);
    assert.equal(d[0].sid, 'movie:501');
    // to the device = a browser download with a file name
    await page.click('#ov-o-dl');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#ov-o-dl ~ .ov-sub .ovitem >> nth=1')]);
    assert.match(dl.suggestedFilename(), /Big Movie|501/);
    for (const x of app.recordings.list(null)) app.recordings.remove(x.id);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('a programme that has not started in the guide can be scheduled for recording', async () => {
    const { ctx, page, errors } = await open({ layout: '1', sel: 0, tiles: [null] });
    await page.click('.tile[data-idx="0"]');   // empty tile -> picker
    await page.waitForSelector('.modal .tabs');
    await page.selectOption('select[aria-label="Provider"]', 'p1');
    await page.click('.tab:has-text("Guide")');
    await page.waitForSelector('.guide .grow .prog');
    const nextBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.guide .grow:nth-child(2) .prog')].filter((b) => !b.classList.contains('now')).pop());
    await nextBtn.asElement().click();
    await page.waitForSelector('#prog-rec');
    await page.click('#prog-rec');
    await page.waitForFunction(() => /Scheduled/.test(document.getElementById('banner').textContent));
    const it = app.recordings.list(null).find((x) => x.status === 'scheduled');
    assert.ok(it, 'a scheduled recording exists');
    assert.ok(it.end - it.start > 60 * 60 * 1000, 'starts 5 minutes early, ends 60 minutes late');
    app.recordings.remove(it.id);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('remote control: Enter shows the controls, arrows move between them, Back closes sub-menu, row, then controls', async () => {
    const { ctx, page, errors } = await open(two);
    await page.focus('.tile[data-idx="0"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__mv.ovl.shown);
    const active = () => page.evaluate(() => document.activeElement.id);
    assert.equal(await active(), 'ov-play');
    await page.keyboard.press('ArrowRight'); assert.equal(await active(), 'ov-fwd');
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); assert.equal(await active(), 'ov-back');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    assert.ok(['ov-mute', 'ov-seek', 'ov-live', 'ov-vol', 'ov-arrow'].includes(await active()), await active());
    // reach the arrow and open the row with OK
    for (let i = 0; i < 6 && (await active()) !== 'ov-arrow'; i++) await page.keyboard.press('ArrowDown');
    assert.equal(await active(), 'ov-arrow');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.__mv.ovl.optsOpen), true);
    await page.keyboard.press('ArrowUp');
    assert.ok((await active()).startsWith('ov-o-'), await active());
    await page.focus('#ov-o-quality');
    await page.keyboard.press('Enter');
    assert.notEqual(await page.evaluate(() => window.__mv.ovl.sub), '');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__mv.ovl.sub), '');
    assert.equal(await page.evaluate(() => window.__mv.ovl.optsOpen), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__mv.ovl.optsOpen), false);
    assert.equal(await page.evaluate(() => window.__mv.ovl.shown), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__mv.ovl.shown), false);
    // the pull-out menu by remote
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__mv.ovl.shown);
    for (let i = 0; i < 6 && (await active()) !== 'ov-pull'; i++) await page.keyboard.press('ArrowLeft');
    assert.equal(await active(), 'ov-pull');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__mv.side.open);
    assert.equal(await active(), 'sm-watch');
    await page.keyboard.press('ArrowDown');
    assert.equal(await active(), 'sm-views');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__mv.side.open), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('the Back button (history) closes the side menu, then the controls, instead of leaving the app', async () => {
    const { ctx, page, errors } = await open(one);
    const url0 = page.url();
    await page.click('.tile[data-idx="0"]');
    await page.click('#ov-pull');
    await page.waitForFunction(() => window.__mv.side.open);
    await page.goBack();
    await page.waitForFunction(() => !window.__mv.side.open);
    assert.equal(await page.evaluate(() => window.__mv.ovl.shown), true, 'the controls are still up after the first Back');
    await page.goBack();
    await page.waitForFunction(() => !window.__mv.ovl.shown);
    assert.equal(page.url(), url0, 'Back stayed in the app');
    // an opened row and sub-menu close one step at a time
    await page.click('.tile[data-idx="0"]');
    await page.click('#ov-arrow');
    await page.click('#ov-o-quality');
    await page.goBack();
    assert.equal(await page.evaluate(() => window.__mv.ovl.sub), '');
    assert.equal(await page.evaluate(() => window.__mv.ovl.optsOpen), true);
    await page.goBack();
    await page.waitForFunction(() => !window.__mv.ovl.optsOpen);
    await page.goBack();
    await page.waitForFunction(() => !window.__mv.ovl.shown);
    assert.equal(page.url(), url0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('mini player: button right of the cast icon floats the selected video in a browser', async () => {
    const { ctx, page, errors } = await open(two, { init: `Object.defineProperty(window, 'documentPictureInPicture', { value: undefined, configurable: true }); window.__pipCalls = []; HTMLVideoElement.prototype.requestPictureInPicture = function () { window.__pipCalls.push(this.id || this.className); return Promise.resolve({}); }; Object.defineProperty(document, 'pictureInPictureEnabled', { value: true });` });
    await page.waitForFunction(() => window.__players.length === 2);
    await page.click('.tile[data-idx="1"]');
    await page.waitForFunction(() => window.__mv.ovl.shown);
    await page.evaluate(() => { window.__mv.castState.avail = true; window.__mv.ovlShow(); });
    await page.waitForFunction(() => !document.getElementById('ov-cast').hidden);
    assert.equal(await vis(page, '#ov-pip'), true);
    const a = await centre(page, '#ov-cast');
    const b = await centre(page, '#ov-pip');
    assert.ok(b.x > a.x && b.x > 1500 && b.y < 100, 'mini player top right, cast to its left');
    await page.click('#ov-pip');
    await page.waitForFunction(() => window.__pipCalls.length === 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('mini player in the Android app: native call, auto-start flag, page chrome hides while floating', async () => {
    const { ctx, page, errors } = await open(two, { init: `window.__app = []; window.MVApp = { canPip: function () { return true; }, enterPip: function () { window.__app.push('enter'); }, setAutoPip: function (on) { window.__app.push('auto:' + on); }, changeServer: function () {} };` });
    await page.waitForFunction(() => window.__players.length === 2);
    await page.click('.tile[data-idx="0"]');
    await page.waitForFunction(() => window.__mv.ovl.shown);
    assert.equal(await vis(page, '#ov-pip'), true);
    assert.ok((await page.evaluate(() => window.__app)).includes('auto:true'), 'the app is told something is playing');
    await page.click('#ov-pip');
    assert.ok((await page.evaluate(() => window.__app)).includes('enter'));
    await page.evaluate(() => window.__mvPip(true));
    assert.equal(await vis(page, '#ovl'), false, 'controls hidden while floating');
    assert.equal(await page.evaluate(() => window.__mv.ovl.shown), false);
    await page.evaluate(() => window.__mvPip(false));
    assert.equal(await page.evaluate(() => document.body.classList.contains('pip')), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('cast icon appears only when a Google device can be cast to; both ways of casting are offered', async () => {
    const { ctx, page, errors } = await open(two);
    await page.click('.tile[data-idx="0"]');
    assert.equal(await vis(page, '#ov-cast'), false);
    await page.evaluate(() => { window.__mv.castState.avail = true; });
    await page.waitForFunction(() => !document.getElementById('ov-cast').hidden);
    const c = await centre(page, '#ov-cast');
    assert.ok(c.x > 1400 && c.y < 100, 'top right');
    await page.click('#ov-cast');
    await page.waitForSelector('#cast-channel');
    assert.equal(await vis(page, '#cast-multi'), true, 'the whole multiview is offered when there are several channels');
    assert.match(await page.textContent('#cast-channel'), /ESPN/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('viewers get the controls without layout, guide, channel keys or favourites', async () => {
    const { ctx, page } = await open(one);
    await page.evaluate(() => { window.__mv.ME.admin = false; });
    await page.click('.tile[data-idx="0"]');
    await page.click('#ov-arrow');
    const hidden = await page.evaluate(() => ['ov-guide', 'ov-up', 'ov-down'].map((i) => document.getElementById(i).hidden).concat(['layout', 'fav'].map((k) => document.getElementById('ov-o-' + k).closest('.ov-opt').hidden)));
    assert.deepEqual(hidden, [true, true, true, true, true]);
    assert.equal(await vis(page, '#ov-o-rec'), true, 'recording is for everyone');
    await ctx.close();
  });

  test('PWA: valid manifest, icons, screenshots, version-tied service worker that never caches streams or the API, install help, update prompt', async () => {
    const res = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /manifest\+json/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const man = await res.json();
    assert.equal(man.display, 'standalone');
    assert.equal(man.start_url, '/');
    assert.ok(man.name && man.short_name && man.theme_color && man.background_color);
    const sizes = man.icons.map((i) => `${i.sizes}/${i.purpose}`);
    assert.ok(sizes.includes('192x192/any') && sizes.includes('512x512/any') && sizes.includes('512x512/maskable'));
    for (const f of [...man.icons, ...man.screenshots]) {
      const r = await fetch(base + f.src);
      assert.equal(r.status, 200, f.src);
      assert.equal(r.headers.get('content-type'), f.type, f.src);
    }
    assert.ok(man.screenshots.some((s) => s.form_factor === 'wide') && man.screenshots.some((s) => s.form_factor === 'narrow'), 'wide and narrow screenshots');
    assert.equal((await fetch(`${base}/icons/apple-touch-icon.png`)).status, 200);
    assert.equal((await fetch(`${base}/offline.html`)).status, 200);
    const swRes = await fetch(`${base}/sw.js`);
    assert.equal(swRes.headers.get('cache-control'), 'no-cache');
    const sw = await swRes.text();
    assert.match(sw, new RegExp(`const VERSION = '${pkg.version.replace(/\./g, '\\.')}'`), 'the cache name follows the app version');
    assert.match(sw, /\(api\|stream\|ws\|vod\|recordings\|cast\)/, 'streams, API, recordings and casts are never touched');
    // really install it
    const { ctx, page, errors } = await open(null, { sw: 'allow' });
    const info = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      await new Promise((r) => { if (navigator.serviceWorker.controller) r(); else navigator.serviceWorker.addEventListener('controllerchange', r); setTimeout(r, 4000); });
      const keys = await caches.keys();
      const c = await caches.open(keys[0]);
      const urls = (await c.keys()).map((r) => new URL(r.url).pathname);
      return { scope: new URL(reg.scope).pathname, keys, urls, manifest: document.querySelector('link[rel=manifest]').getAttribute('href') };
    });
    assert.equal(info.scope, '/');
    assert.deepEqual(info.keys, [`mv-shell-${pkg.version}`]);
    assert.ok(info.urls.includes('/app.js') && info.urls.includes('/styles.css') && info.urls.includes('/offline.html'));
    assert.equal(info.urls.some((u) => /^\/(api|stream|ws|vod|recordings|cast)\b/.test(u)), false, 'nothing from the API or streams is stored: ' + info.urls.join(','));
    // an API call goes through the worker untouched and is not cached
    await page.evaluate(() => fetch('/api/me').then((r) => r.json()));
    const after = await page.evaluate(async () => { const c = await caches.open((await caches.keys())[0]); return (await c.keys()).map((r) => new URL(r.url).pathname); });
    assert.equal(after.includes('/api/me'), false);
    // Settings explains how to install
    await page.evaluate(() => document.getElementById('sm-settings').click());
    await page.waitForSelector('#set-install-box');
    assert.match(await page.textContent('#set-install-box'), /Install as an app/);
    await page.keyboard.press('Escape');
    // a new version asks first
    await page.evaluate(() => { window.__mv.updateReady && window.__mv.updateReady({ postMessage() { window.__posted = true; } }); });
    await page.waitForSelector('#updatebar');
    await page.click('#update-now');
    assert.equal(await page.evaluate(() => window.__posted), true, 'Update now tells the waiting worker to take over');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});
