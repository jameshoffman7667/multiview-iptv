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

// Tap a screen away from the controls that sit in its middle, top and edges (the controls live inside the screen now).
const tap = async (page, idx) => {
  const b = await page.locator(`.tile[data-idx="${idx}"]`).boundingBox();
  if (!b) return page.click(`.tile[data-idx="${idx}"]`);
  await page.mouse.click(b.x + b.width * 0.2, b.y + b.height * 0.33);
};

// Controls up, screen selected, then the third tap on an empty screen opens the channel selection.
const tapPicker = async (page, idx) => {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.modal h2').count()) return;
    await tap(page, idx);
    await page.waitForTimeout(60);
  }
};
const near = (a, b, tol = 2.5) => Math.abs(a - b) <= tol;
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
  async function openPage({ fake = true, init, state, viewport = { width: 1920, height: 1080 } } = {}) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const errors = [];
    if (fake) {
      await ctx.route('**/vendor/mpegts.js', (route) => route.fulfill({ contentType: 'text/javascript', body: FAKE_MPEGTS }));
      await ctx.addInitScript(MEDIA_STUBS);
      if (init) await ctx.addInitScript(init);
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
    await tapPicker(page, 0);   // tap an empty screen up to the third tap: the controls, select, then the channel selection
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

  // ---- Auto quality (P-29). The page's clock is driven by hand: autoTick(now, ahead) with times 40 s ahead of the real clock.
  const AUTO_STATE = { layout: '1', tiles: [{ p: 'p1', sid: '2', name: 'CNN', q: 'auto' }] };
  async function autoPlaying(extra = {}) {
    const o = await openPage({ state: { ...AUTO_STATE, ...extra } });
    await o.page.waitForFunction(() => window.__players.length === 1);
    await o.page.evaluate(() => { document.querySelector('video').__ahead = 3.5; });
    await o.page.waitForFunction(() => window.__mv.tiles[0].phase === 'playing', null, { timeout: 4000 });
    return o;
  }
  const feed = (page, from, n, fn) => page.evaluate(({ from, n, fn }) => {
    const t = window.__mv.tiles[0];
    const f = new Function('k', 'return ' + fn);
    for (let k = 0; k < n; k++) t.autoTick(Date.now() + 40000 + (from + k) * 1000, f(from + k));
  }, { from, n, fn });
  const playersN = (page) => page.evaluate(() => window.__players.length);
  async function swapUp(page) {
    await page.evaluate(() => { document.querySelector('video').__ahead = 11; });
    await feed(page, 0, 24, '11');
    await page.waitForFunction(() => window.__players.length === 2, null, { timeout: 3000 });
    await page.evaluate(() => { window.__players[1].v.__ahead = 3; });
    await page.waitForFunction(() => window.__mv.tiles[0].au.q === 'full', null, { timeout: 3000 });
  }

  test('auto quality: starts on the SD step with a 3 s cushion; a channel without an SD version plays as chosen', async () => {
    const { ctx, page, errors } = await openPage({ state: { layout: '1', tiles: [{ p: 'p1', sid: '2', name: 'CNN', q: 'auto' }] } });
    await page.waitForFunction(() => window.__players.length === 1);
    const u = await page.evaluate(() => window.__players[0].ds.url);
    assert.match(u, /buf=3&/);
    assert.match(u, /q=sd/);
    assert.equal(await page.evaluate(() => window.__mv.tiles[0].au.q), 'sd');
    await ctx.close();
    const o = await openPage({ state: { layout: '1', tiles: [{ p: 'p1', sid: '1', name: 'ESPN', q: 'auto' }] } });
    await o.page.waitForFunction(() => window.__players.length === 1);
    const u2 = await o.page.evaluate(() => window.__players[0].ds.url);
    assert.match(u2, /buf=4/, 'one step only: the normal cushion');
    assert.doesNotMatch(u2, /q=sd/);
    assert.equal(await o.page.evaluate(() => window.__mv.tiles[0].au), null);
    assert.deepEqual([...errors, ...o.errors], []);
    await o.ctx.close();
  });

  test('auto quality: the Settings switch applies it to channels with no quality chosen; the menu offers Auto', async () => {
    const { ctx, page, errors } = await openPage({ state: { layout: '1', autoQ: true, tiles: [{ p: 'p1', sid: '2', name: 'CNN' }] } });
    await page.waitForFunction(() => window.__players.length === 1);
    assert.match(await page.evaluate(() => window.__players[0].ds.url), /buf=3&.*q=sd/);
    await page.evaluate(() => { window.__mv.ovlShow(); });
    await page.click('#ov-arrow');
    await page.click('#ov-o-quality');
    const items = await page.$$eval('#ov-sub button, .ov-sub button', (b) => b.map((x) => x.textContent));
    assert.ok(items.some((t) => /^Auto \(adaptive/.test(t)), 'Auto (adaptive) is offered: ' + items.join('|'));
    assert.ok(items.some((t) => /^Standard/.test(t)));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('auto quality: a healthy buffer (10 s for 20 s) swaps up to full quality with no gap, and the old stream is closed', async () => {
    const { ctx, page, errors } = await autoPlaying();
    await swapUp(page);
    assert.doesNotMatch(await page.evaluate(() => window.__players[1].ds.url), /q=sd/);
    assert.equal(await page.evaluate(() => window.__players[0].destroyed), true, 'old stream closed');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.tile video').length), 1, 'one picture');
    assert.equal(await page.evaluate(() => window.__mv.tiles[0].video === window.__players[1].v), true);
    assert.equal(await page.evaluate(() => window.__mv.tiles[0].phase), 'playing');
    assert.equal(await page.evaluate(() => window.__mv.tiles[0].sdUsed), false);
    assert.match(await page.evaluate(() => window.__mv.tiles[0].dgInfo().switches[0]), /sd to full: buffer over 10 s/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('auto quality: it does not step up before 20 s of healthy buffer, and while waiting it plays slightly slower to build the cushion', async () => {
    const { ctx, page, errors } = await autoPlaying();
    await page.evaluate(() => { document.querySelector('video').__ahead = 6; });
    await feed(page, 0, 10, '11');
    assert.equal(await playersN(page), 1, '10 s is not enough');
    await page.evaluate(() => { document.querySelector('video').__ahead = 8; });
    await page.waitForFunction(() => document.querySelector('video').playbackRate < 1, null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => document.querySelector('video').playbackRate), 0.95);
    await page.evaluate(() => { document.querySelector('video').__ahead = 12.5; });
    await page.waitForFunction(() => document.querySelector('video').playbackRate === 1, null, { timeout: 3000 });
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('auto quality: a buffer under 5 s that is not growing for 10 s steps down; a growing one does not', async () => {
    const { ctx, page, errors } = await autoPlaying();
    await swapUp(page);
    await page.evaluate(() => { document.querySelector('video').__ahead = 3; });
    await feed(page, 0, 13, '3 + k * 0.3'); // growing: healthy
    assert.equal(await playersN(page), 2, 'a growing buffer is left alone');
    await page.evaluate(() => { window.__mv.tiles[0].au.samples = []; });
    await feed(page, 20, 13, '3.2 - k * 0.02 + 0.4'); // draining
    await page.waitForFunction(() => window.__players.length === 3, null, { timeout: 3000 });
    assert.match(await page.evaluate(() => window.__players[2].ds.url), /q=sd/);
    await page.evaluate(() => { window.__players[2].v.__ahead = 3; });
    await page.waitForFunction(() => window.__mv.tiles[0].au.q === 'sd', null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => window.__players[1].destroyed), true);
    assert.match(await page.evaluate(() => window.__mv.tiles[0].dgInfo().switches.slice(-1)[0]), /full to sd: buffer under 5 s for 10 s/);
    assert.ok(await page.evaluate(() => window.__mv.tiles[0].auLock > Date.now() + 50000), 'no step up for about a minute');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('auto quality: a stall steps down at once', async () => {
    const { ctx, page, errors } = await autoPlaying();
    await swapUp(page);
    await page.evaluate(() => { document.querySelector('video').dispatchEvent(new Event('playing')); document.querySelector('video').__ahead = 0.05; });
    await page.waitForFunction(() => window.__players.length === 3, null, { timeout: 3000 });
    assert.match(await page.evaluate(() => window.__players[2].ds.url), /q=sd/);
    await page.evaluate(() => { window.__players[2].v.__ahead = 3; });
    await page.waitForFunction(() => window.__mv.tiles[0].au.q === 'sd', null, { timeout: 3000 });
    assert.match(await page.evaluate(() => window.__mv.tiles[0].dgInfo().switches.slice(-1)[0]), /full to sd: stall/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('auto quality: when the new stream cannot open (provider full) the switch is skipped and the picture keeps playing', async () => {
    const { ctx, page, errors } = await autoPlaying();
    await page.evaluate(() => { document.querySelector('video').__ahead = 11; });
    await feed(page, 0, 24, '11');
    await page.waitForFunction(() => window.__players.length === 2, null, { timeout: 3000 });
    await page.evaluate(() => window.__players[1].handlers.error('NetworkError', 'HttpStatusCodeInvalid', { code: 503 }));
    assert.equal(await page.evaluate(() => window.__players[1].destroyed), true, 'standby closed');
    assert.equal(await page.evaluate(() => window.__players[0].destroyed), false, 'current stream untouched');
    assert.equal(await page.evaluate(() => window.__mv.tiles[0].phase), 'playing');
    assert.equal(await page.evaluate(() => window.__mv.tiles[0].au.q), 'sd');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.tile video').length), 1);
    assert.match(await page.evaluate(() => window.__mv.tiles[0].dgInfo().switches[0]), /skipped/);
    assert.ok(await page.evaluate(() => window.__mv.tiles[0].auLock > Date.now() + 50000));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('auto quality: a restart (Reload, error) closes a half-built switch', async () => {
    const { ctx, page, errors } = await autoPlaying();
    await page.evaluate(() => { document.querySelector('video').__ahead = 11; });
    await feed(page, 0, 24, '11');
    await page.waitForFunction(() => window.__players.length === 2, null, { timeout: 3000 });
    await page.evaluate(() => window.__mv.tiles[0].reload());
    await page.waitForFunction(() => window.__players.length === 3, null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => window.__players[1].destroyed), true);
    assert.equal(await page.evaluate(() => !!window.__mv.tiles[0].switching), false);
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
    await tap(page, 1); await tap(page, 1); // first tap brings the controls up, second selects it
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
    await tapPicker(page, 0);   // tap an empty screen up to the third tap: the controls, select, then the channel selection
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
    await tapPicker(page, 0);   // tap an empty screen up to the third tap: the controls, select, then the channel selection
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

  test('downloads: a button on every movie and episode, one for the season, none for Live; Settings holds the device limit', async () => {
    const { ctx, page, errors } = await openPage();
    await page.evaluate(() => window.__mv.setLayout('1'));
    await tapPicker(page, 0);
    await page.waitForSelector('.modal .tabs');
    assert.equal(await page.locator('.chlist .dlb').count(), 0, 'Live channels have no download button');
    await page.click('.tab:has-text("Movies")');
    await page.waitForFunction(() => document.querySelectorAll('.chlist .pick').length === 2);
    assert.equal(await page.locator('.chlist .dlb').count(), 2, 'one per movie');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.chlist .dlb >> nth=0')]);
    assert.match(dl.suggestedFilename(), /Big Movie|501/);
    await dl.cancel().catch(() => {});
    await page.keyboard.press('Escape');
    await page.keyboard.press('c');
    await page.waitForSelector('.modal .tabs');
    await page.click('.tab:has-text("Series")');
    await page.waitForFunction(() => document.querySelectorAll('.chlist .pick').length === 1);
    assert.equal(await page.locator('.chlist .dlb').count(), 0, 'a series is opened first; its episodes carry the buttons');
    await page.click('.chlist .pick');
    await page.waitForFunction(() => document.querySelectorAll('.modal-back:last-of-type .pick').length === 2);
    assert.equal(await page.locator('.modal-back:last-of-type .dlb').count(), 2, 'one per episode');
    assert.match(await page.textContent('#dl-season'), /Download this season \(2 episodes\)/);
    await page.selectOption('.modal-back:last-of-type select', '1');
    await page.waitForFunction(() => document.querySelectorAll('.modal-back:last-of-type .pick').length === 1);
    assert.match(await page.textContent('#dl-season'), /\(1 episode\)/, 'the season button follows the season being viewed');
    assert.deepEqual(errors.filter((e) => !/ERR_ABORTED|aborted|download/i.test(e)), []);
    await ctx.close();
  });

  test('downloads: Settings has the per-device limit (default 3), and the Android TV app shows no download buttons', async () => {
    let r = await openPage();
    await r.page.keyboard.press('Escape');
    await r.page.evaluate(() => document.getElementById('sm-settings').click());
    await r.page.waitForSelector('#set-dlmax');
    assert.equal(await r.page.inputValue('#set-dlmax'), '3');
    await r.page.selectOption('#set-dlmax', '5');
    assert.equal(await r.page.evaluate(() => window.__mv.S.dlMax), 5);
    assert.deepEqual(r.errors, []);
    await r.ctx.close();
    r = await openPage({ init: `window.MVApp = { canPip: function () { return false; }, setAutoPip: function () {}, changeServer: function () {} };` });
    await r.page.evaluate(() => window.__mv.setLayout('1'));
    await tapPicker(r.page, 0);
    await r.page.waitForSelector('.modal .tabs');
    await r.page.click('.tab:has-text("Movies")');
    await r.page.waitForFunction(() => document.querySelectorAll('.chlist .pick').length === 2);
    assert.equal(await r.page.locator('.dlb').count(), 0);
    await r.ctx.close();
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
    await page.waitForSelector('.modal input[type=text]');
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
    await v.tap(page, 2);
    await v.tap(page, 2);
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
    await tapPicker(page, 0);   // tap an empty screen up to the third tap: the controls, select, then the channel selection
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
    await tapPicker(page2, 0);   // third tap on an empty screen opens the channel selection
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
    await tapPicker(page, 0);   // tap an empty screen up to the third tap: the controls, select, then the channel selection
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
      await page.evaluate(() => window.__mv.select(1)); await tapPicker(page, 1);   // tap an empty screen up to the third tap: the controls, select, then the channel selection
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
    await tapPicker(page, 0);   // tap an empty screen up to the third tap: the controls, select, then the channel selection
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

  async function open(state, { viewport = { width: 1600, height: 900 }, sw = 'block', init = '', colorScheme } = {}) {
    const ctx = await browser.newContext(colorScheme ? { viewport, serviceWorkers: sw, colorScheme } : { viewport, serviceWorkers: sw });
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
  const vis = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && (e.offsetParent !== null || getComputedStyle(e).position === 'fixed') && getComputedStyle(e).visibility !== 'hidden'; }, sel);
  const centre = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });

  test('tap rules: hidden controls just come up; then the active screen zooms and an inactive one only becomes active', async () => {
    const { ctx, page, errors } = await open(two);
    await page.waitForFunction(() => window.__players.length === 2);
    const sel = () => page.evaluate(() => window.__mv.S.sel);
    const zoom = () => page.evaluate(() => window.__mv.zoom);
    await tap(page, 1);
    await page.waitForFunction(() => window.__mv.ovl.shown);
    assert.equal(await sel(), 0, 'controls were hidden: the tap did not select');
    assert.equal(await zoom(), -1);
    await tap(page, 1);
    assert.equal(await sel(), 1, 'controls up: tapping an inactive screen makes it active');
    assert.equal(await zoom(), -1, '... without zooming');
    await tap(page, 1);
    await page.waitForFunction(() => window.__mv.zoom === 1);
    await page.mouse.click(300, 300); // away from the controls in the middle
    await page.waitForFunction(() => window.__mv.zoom === -1);
    // hide the controls: tapping the active screen only brings them up
    await page.evaluate(() => window.__mv.ovlHide());
    await tap(page, 1);
    await page.waitForFunction(() => window.__mv.ovl.shown);
    assert.equal(await zoom(), -1);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('tapping a screen brings up the controls where the design says they go', async () => {
    const { ctx, page, errors } = await open(two);
    await page.waitForFunction(() => window.__players.length === 2);
    assert.equal(await vis(page, '#ov-play'), false, 'hidden until tapped');
    await tap(page, 0);
    await page.waitForFunction(() => window.__mv.ovl.shown);
    assert.equal(await page.evaluate(() => window.__mv.ovl.idx), 0, 'the controls are on the tapped screen');
    for (const id of ['#ov-guide', '#ov-pull', '#ov-back', '#ov-play', '#ov-fwd', '#ov-up', '#ov-down', '#ov-mute', '#ov-vol', '#ov-seek', '#ov-arrow']) assert.equal(await vis(page, id), true, id);
    assert.equal(await vis(page, '#ov-cast'), false, 'no cast icon when no cast device is around');
    const pos = {};
    for (const id of ['guide', 'pull', 'back', 'play', 'fwd', 'up', 'down', 'mute', 'seek', 'arrow']) pos[id] = await centre(page, '#ov-' + id);
    assert.ok(pos.guide.x < 200 && pos.guide.y < 100, 'change-channel button top left');
    assert.ok(pos.pull.x < 60 && Math.abs(pos.pull.y - pos.play.y) < 60, 'pull-out arrow on the left side of the page, level with the controls');
    assert.ok(pos.back.x < pos.play.x && pos.play.x < pos.fwd.x && Math.abs(pos.play.x - 400) < 5 && Math.abs(pos.play.y - 225) < 5, 'play in the middle of the screen, skip back and forward either side');
    assert.ok(pos.up.x > 650 && pos.down.x > 650 && pos.up.y < pos.down.y, 'channel up and down on the right');
    assert.ok(pos.mute.x < 200 && pos.mute.y > 380, 'mute bottom left');
    assert.ok(pos.seek.y > 380 && pos.seek.x > pos.mute.x, 'progress bar along the bottom');
    assert.ok(pos.arrow.y > pos.seek.y - 5 && Math.abs(pos.arrow.x - 400) < 5, 'options arrow below the progress bar');
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
    assert.equal(await page.textContent('#ov-o-quality .ic-tv text'), 'STD');
    await page.click('#ov-arrow');
    assert.equal(await vis(page, '#ov-o-layout'), false, 'tapping again closes the row');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('the layout option holds every layout; expand is the magnifying glass and a second tap on the same tile does it too', async () => {
    const { ctx, page, errors } = await open(two);
    await tap(page, 0);
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
    await tap(page, 1);
    await page.waitForFunction(() => window.__mv.ovl.shown);
    await tap(page, 1);    // controls up on it, it is not selected yet: the next tap only selects it
    await page.waitForFunction(() => window.__mv.S.sel === 1);
    assert.equal(await page.evaluate(() => window.__mv.zoom), -1);
    await tap(page, 1);    // the selected tile expands
    await page.waitForFunction(() => window.__mv.zoom === 1);
    await page.mouse.click(300, 300);
    await page.waitForFunction(() => window.__mv.zoom === -1);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('quality, reload, favourite', async () => {
    const { ctx, page, errors } = await open(one);
    await page.waitForFunction(() => window.__players.length === 1);
    await tap(page, 0);
    await page.click('#ov-arrow');
    await page.click('#ov-o-quality');
    assert.equal(await page.locator('#ov-o-quality ~ .ov-sub .ovitem').count(), 5);
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
    await tap(page, 0);
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
    await tap(page, 0);
    await page.click('#ov-down');
    await page.waitForFunction(() => window.__mv.S.tiles[0].sid === '2');
    await page.click('#ov-down');   // category US has two channels in this list: wraps to the first
    await page.waitForFunction(() => window.__mv.S.tiles[0].sid !== '2');
    assert.equal(await page.evaluate(() => window.__mv.S.tiles[0].sid), '1');
    await page.click('#ov-up');
    await page.waitForFunction(() => window.__mv.S.tiles[0].sid === '2');
    await tap(page, 0);
    await page.waitForFunction(() => window.__mv.ovl.shown);
    await page.click('#ov-guide');
    await page.waitForSelector('.modal .tabs .tab.on');
    assert.equal(await page.evaluate(() => document.querySelector('.tab.on').textContent.trim()), 'Guide');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('controls sit inside the tapped screen: tap 1 opens them there, tap 2 selects, tap 3 zooms, a zoomed screen un-zooms', async () => {
    const { ctx, page, errors } = await open(two);
    const state = () => page.evaluate(() => ({ sel: window.__mv.S.sel, shown: window.__mv.ovl.shown, idx: window.__mv.ovl.idx, zoomed: document.body.classList.contains('single') }));
    const box = (sel) => page.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
    // tap 1 on the second screen (not selected): the controls come up on it, nothing is selected
    await tap(page, 1);
    await page.waitForFunction(() => window.__mv.ovl.shown);
    let st = await state();
    assert.deepEqual([st.sel, st.shown, st.idx], [0, true, 1]);
    const t1 = await box('.tile[data-idx="1"]');
    const o = await box('#ovl');
    assert.ok(near(o.x, t1.x, 2) && near(o.y, t1.y, 2) && near(o.w, t1.w, 2) && near(o.h, t1.h, 2), 'the controls cover exactly that screen');
    assert.match(await page.textContent('#view-title'), /CNN/, 'the controls show that screen\'s channel');
    // the menu arrow stays at the page edge, the cast / mini player strip at the top right, whichever screen it is on
    assert.ok((await box('#ov-pull')).x < 60, 'menu arrow at the page edge');
    assert.ok((await box('#ov-pip')).x + (await box('#ov-pip')).w > 1500, 'mini player at the page edge');
    // tap 2: the screen is selected and the controls stay on it
    await tap(page, 1);
    st = await state();
    assert.deepEqual([st.sel, st.shown, st.idx, st.zoomed], [1, true, 1, false]);
    // tap 3: zoom; the controls follow the zoomed screen
    await tap(page, 1);
    st = await state();
    assert.equal(st.zoomed, true);
    const full = await box('#ovl');
    assert.ok(full.w > 1500 && full.h > 800, 'zoomed screen: controls cover the page');
    // tapping the zoomed screen goes back to the grid
    await tap(page, 1);
    st = await state();
    assert.equal(st.zoomed, false);
    // moving to another screen with the controls up selects it and moves them (no zoom)
    await tap(page, 0);
    st = await state();
    assert.deepEqual([st.sel, st.idx, st.zoomed], [0, 0, false]);
    const t0 = await box('.tile[data-idx="0"]');
    const o0 = await box('#ovl');
    assert.ok(near(o0.x, t0.x, 2) && near(o0.w, t0.w, 2), 'controls moved to the selected screen');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('an empty screen: tap 3 opens the channel selection (tap 1 only brings the controls up)', async () => {
    const { ctx, page, errors } = await open(two);
    await tap(page, 2);
    assert.equal(await page.locator('.modal h2').count(), 0, 'tap 1: no picker yet');
    assert.equal(await page.evaluate(() => window.__mv.ovl.idx), 2);
    await tap(page, 2);
    assert.equal(await page.evaluate(() => window.__mv.S.sel), 2);
    assert.equal(await page.locator('.modal h2').count(), 0, 'tap 2: selected, still no picker');
    await tap(page, 2);
    await page.waitForSelector('.modal h2');
    assert.match(await page.textContent('.modal h2'), /Choose channel for tile 3/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('small screens get compact controls that fit inside them', async () => {
    const { ctx, page, errors } = await open({ layout: '3x3', sel: 0, tiles: [{ p: 'p1', sid: '1', name: 'ESPN' }] }, { viewport: { width: 1280, height: 720 } });
    await tap(page, 0);
    await page.waitForFunction(() => window.__mv.ovl.shown);
    assert.equal(await page.evaluate(() => document.getElementById('ovl').classList.contains('compact')), true);
    const fits = await page.evaluate(() => {
      const o = document.getElementById('ovl').getBoundingClientRect();
      return ['ov-play', 'ov-back', 'ov-fwd', 'ov-up', 'ov-down', 'ov-seek', 'ov-mute', 'ov-guide'].every((id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return r.left >= o.left - 1 && r.right <= o.right + 1 && r.top >= o.top - 1 && r.bottom <= o.bottom + 1;
      });
    });
    assert.equal(fits, true, 'every control is inside the screen');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('theme: follows the device setting by default, Settings can force Light or Dark, video area stays black', async () => {
    const panel = (page) => page.evaluate(() => getComputedStyle(document.querySelector('.modal') || document.body).backgroundColor);
    const bodyBg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lum = (rgb) => { const m = rgb.match(/\d+/g).map(Number); return (m[0] + m[1] + m[2]) / 3; };
    const openSettings = async (page) => {
      await tap(page, 0);
      await page.click('#ov-pull');
      await page.click('#sm-settings');
      await page.waitForSelector('.modal h2');
    };
    for (const [scheme, expectLight] of [['light', true], ['dark', false]]) {
      const { ctx, page, errors } = await open(one, { viewport: { width: 1280, height: 720 }, colorScheme: scheme });
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-theme')), false, 'system by default');
      await openSettings(page);
      assert.equal(lum(await panel(page)) > 128, expectLight, `system theme with a ${scheme} device`);
      assert.equal(lum(await bodyBg(page)), 0, 'the video area stays black');
      // force the opposite theme from the Settings dialog
      const sel = page.locator('.modal select', { has: page.locator('option[value="system"]') });
      await sel.selectOption(expectLight ? 'dark' : 'light');
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), expectLight ? 'dark' : 'light');
      assert.equal(lum(await panel(page)) > 128, !expectLight, 'forced theme wins over the device setting');
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mv.state.v1')).theme), expectLight ? 'dark' : 'light', 'saved on this device');
      await page.reload();
      await page.waitForFunction(() => window.__mv && window.__mv.ME);
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), expectLight ? 'dark' : 'light', 'kept after reload');
      assert.deepEqual(errors, [], 'no console errors (a blocked script would show up here as a policy violation)');
      await ctx.close();
    }
  });

  test('pull-out menu: Watch, Multiviews, Recordings & Downloads, Settings, Providers, Log out', async () => {
    const { ctx, page, errors } = await open(one);
    await tap(page, 0);
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
    await tap(page, 0);
    await page.click('#ov-pull');
    await page.click('#sm-settings');
    await page.waitForSelector('.modal h2');
    assert.equal(await page.textContent('.modal h2'), 'Settings');
    assert.equal(await page.evaluate(() => window.__mv.side.open), false);
    assert.equal(await vis(page, '#set-users'), true, 'admin options live under Settings');
    assert.equal(await vis(page, '#set-full'), true);
    assert.equal(await vis(page, '#set-install-box'), true);
    await page.keyboard.press('Escape');
    await tap(page, 0);
    await page.click('#ov-pull');
    await page.click('#sm-recs');
    await page.waitForSelector('.modal h2:has-text("Recordings")');
    await page.keyboard.press('Escape');
    // a tap outside closes it
    await tap(page, 0);
    await page.click('#ov-pull');
    await page.mouse.click(1200, 400);
    await page.waitForFunction(() => !window.__mv.side.open);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('record: to the end of the event (with the stop time shown) or for a length; the Recordings screen lists, plays and deletes', async () => {
    const { ctx, page, errors } = await open(one);
    await tap(page, 0);
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
    await tap(page, 0);
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
    await tapPicker(page, 0);   // tap an empty screen up to the third tap: the controls, select, then the channel selection
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
    await tap(page, 0);
    await page.click('#ov-pull');
    await page.waitForFunction(() => window.__mv.side.open);
    await page.goBack();
    await page.waitForFunction(() => !window.__mv.side.open);
    assert.equal(await page.evaluate(() => window.__mv.ovl.shown), true, 'the controls are still up after the first Back');
    await page.goBack();
    await page.waitForFunction(() => !window.__mv.ovl.shown);
    assert.equal(page.url(), url0, 'Back stayed in the app');
    // an opened row and sub-menu close one step at a time
    await tap(page, 0);
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
    await tap(page, 1);
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

  test('fullscreen button: top right of the page, after cast and the mini player, toggles fullscreen', async () => {
    const { ctx, page, errors } = await open(two, { init: `window.__fs = []; Element.prototype.requestFullscreen = function () { window.__fs.push('enter'); return Promise.resolve(); }; document.exitFullscreen = function () { window.__fs.push('exit'); return Promise.resolve(); };` });
    await page.waitForFunction(() => window.__players.length === 2);
    await tap(page, 1);
    await page.waitForFunction(() => window.__mv.ovl.shown);
    assert.equal(await vis(page, '#ov-full'), true);
    await page.evaluate(() => { window.__mv.castState.avail = true; window.__mv.ovlShow(); });
    await page.waitForFunction(() => !document.getElementById('ov-cast').hidden);
    const c = await centre(page, '#ov-cast');
    const f = await centre(page, '#ov-full');
    assert.ok(f.x > c.x && f.x > 1500 && f.y < 100, 'fullscreen button is top right, right of cast');
    await page.click('#ov-full');
    await page.waitForFunction(() => window.__fs.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__fs), ['enter']);
    await ctx.close();
  });

  test('fullscreen button is absent where the browser has no fullscreen or in the Android app', async () => {
    let r = await open(two, { init: `Element.prototype.requestFullscreen = undefined; Element.prototype.webkitRequestFullscreen = undefined;` });
    await r.page.waitForFunction(() => window.__players.length === 2);
    await tap(r.page, 1);
    await r.page.waitForFunction(() => window.__mv.ovl.shown);
    assert.equal(await vis(r.page, '#ov-full'), false, 'no browser fullscreen');
    await r.ctx.close();
    r = await open(two, { init: `window.MVApp = { canPip: function () { return false; }, setAutoPip: function () {}, changeServer: function () {} };` });
    await r.page.waitForFunction(() => window.__players.length === 2);
    await tap(r.page, 1);
    await r.page.waitForFunction(() => window.__mv.ovl.shown);
    assert.equal(await vis(r.page, '#ov-full'), false, 'Android app is already full screen');
    await r.ctx.close();
  });

  const fpEvent = (id, player, name, delta, extra = {}) => Object.assign({ id, playerId: player, name, pos: 'WR', nflTeam: 'CIN', delta, age: 0,
    leagues: [{ leagueId: 'a', name: 'The Forgotten Titans', side: 'mine', delta, mineBefore: 96.4, mineAfter: Math.round((96.4 + delta) * 10) / 10, oppBefore: 78.2, oppAfter: 78.2, colour: 'green' },
      { leagueId: 'b', name: 'IRONMAN FF', side: 'opp', delta, mineBefore: 48.5, mineAfter: 48.5, oppBefore: 83.9, oppAfter: Math.round((83.9 + delta) * 10) / 10, colour: 'red' }] }, extra);

  test('score pop-up: one at a time, before values then a roll up, slides in and out, no background, small scores ignored', async () => {
    const { ctx, page, errors } = await open(two, { init: `window.__fpTiming = { slide: 120, hold0: 250, roll: 300, show: 900, gap: 60 };` });
    await page.waitForFunction(() => window.__players.length === 2);
    const ev = fpEvent;
    await page.evaluate(([a, b, c]) => { window.__mv.fpIncoming(a); window.__mv.fpIncoming(b); window.__mv.fpIncoming(c); }, [ev('e1', '6794', "Ja'Marr Chase", 6.4), ev('e2', '4046', 'Josh Allen', 4.0), ev('e3', '1111', 'Small Play', 2.0)]);
    await page.waitForSelector('#fpop');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#fpop').length), 1);
    // right after it appears: league totals from before the play and 0 points
    const first = await page.evaluate(() => ({ a: [...document.querySelectorAll('.fp-a')].map((e) => e.textContent), b: [...document.querySelectorAll('.fp-b')].map((e) => e.textContent), n: [...document.querySelectorAll('.fp-n')].map((e) => e.textContent), name: document.querySelector('.fp-nm').textContent }));
    assert.deepEqual(first.a, ['96.4', '48.5']);
    assert.deepEqual(first.b, ['78.2', '83.9']);
    assert.deepEqual(first.n, ['+0.0', '+0.0']);
    assert.match(first.name, /J\. Chase/);
    const look = await page.evaluate(() => { const e = document.getElementById('fpop'); const b = e.querySelector('.fp-box'); const r = e.getBoundingClientRect(); return { bg: getComputedStyle(e).backgroundColor, bg2: getComputedStyle(b).backgroundColor, border: getComputedStyle(e).borderTopWidth, pe: getComputedStyle(e).pointerEvents, cx: r.x + r.width / 2, top: r.top, img: '/api/fantasy/headshot/' + document.querySelector('.fp-ph').getAttribute('data-id'),
      mineSide: !!document.querySelector('.fp-col.l .fp-lg') && document.querySelector('.fp-col.l .fp-lg').textContent, oppSide: document.querySelector('.fp-col.r .fp-lg').textContent, colL: getComputedStyle(document.querySelector('.fp-col.l .fp-lg')).color, colR: getComputedStyle(document.querySelector('.fp-col.r .fp-lg')).color }; });
    assert.equal(look.bg, 'rgba(0, 0, 0, 0)');
    assert.equal(look.bg2, 'rgba(0, 0, 0, 0)');
    assert.equal(look.border, '0px');
    assert.equal(look.pe, 'none');
    assert.ok(Math.abs(look.cx - 800) < 3, 'centred ' + look.cx);
    assert.equal(look.img, '/api/fantasy/headshot/6794');
    assert.equal(look.mineSide, 'The Forgotten Titans', 'my league on the left');
    assert.equal(look.oppSide, 'IRONMAN FF', "opponent's league on the right");
    assert.equal(look.colL, 'rgb(63, 174, 88)');
    assert.equal(look.colR, 'rgb(214, 83, 59)');
    // then the numbers roll up to the real values
    await page.waitForFunction(() => document.querySelector('.fp-n') && document.querySelector('.fp-n').textContent === '+6.4' && document.querySelector('.fp-a').textContent === '102.8');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.fp-b')[1].textContent), '90.3');
    // the next player only comes after this one has gone, never together
    let overlap = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const n = await page.evaluate(() => document.querySelectorAll('#fpop').length);
      if (n > 1) overlap = true;
      const nm = await page.evaluate(() => (document.querySelector('.fp-nm') || {}).textContent || '');
      if (/J\. Allen/.test(nm)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(overlap, false, 'never two at once');
    assert.match(await page.evaluate(() => document.querySelector('.fp-nm').textContent), /J\. Allen/, 'second player followed');
    await page.waitForFunction(() => !document.getElementById('fpop'), null, { timeout: 4000 });
    assert.equal(await page.evaluate(() => window.__mv.FP.queue.length), 0, 'the 2.0 point play never queued');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('score pop-up: delay holds it back, the same player scoring again merges, opponents can be left out, a late one is dropped', async () => {
    const { ctx, page, errors } = await open(two, { init: `window.__fpTiming = { slide: 80, hold0: 100, roll: 100, show: 500, gap: 30 };` });
    await page.waitForFunction(() => window.__players.length === 2);
    await page.evaluate(() => { window.__mv.S.fdelay = 1; });
    const t0 = Date.now();
    await page.evaluate((e) => window.__mv.fpIncoming(e), fpEvent('d1', '6794', "Ja'Marr Chase", 5.0));
    await page.evaluate((e) => window.__mv.fpIncoming(e), fpEvent('d2', '6794', "Ja'Marr Chase", 3.0));
    assert.equal(await page.evaluate(() => window.__mv.FP.queue.length), 1, 'merged into one');
    assert.equal(await page.evaluate(() => window.__mv.FP.queue[0].leagues[0].delta), 8, 'points added up');
    await page.waitForSelector('#fpop', { timeout: 5000 });
    assert.ok(Date.now() - t0 >= 950, 'held back by the delay: ' + (Date.now() - t0));
    await page.waitForFunction(() => document.querySelector('.fp-n') && document.querySelector('.fp-n').textContent === '+8.0');
    await page.waitForFunction(() => !document.getElementById('fpop'), null, { timeout: 4000 });
    // opponents off: only my side shows
    await page.evaluate(() => { window.__mv.S.fdelay = 0; window.__mv.S.fopp = false; });
    await page.evaluate((e) => window.__mv.fpIncoming(e), fpEvent('d3', '4046', 'Josh Allen', 6.0));
    await page.waitForSelector('#fpop');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.fp-col.r .fp-row').length), 0);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.fp-col.l .fp-row').length), 1);
    await page.waitForFunction(() => !document.getElementById('fpop'), null, { timeout: 4000 });
    // late: due long ago beyond the age limit -> never shown
    await page.evaluate(() => { window.__mv.S.fage = 5; });
    await page.evaluate((e) => window.__mv.fpIncoming(e), fpEvent('d4', '9', 'Late Guy', 6.0, { age: 20000 }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await page.evaluate(() => !!document.getElementById('fpop')), false);
    assert.equal(await page.evaluate(() => window.__mv.FP.queue.length), 0);
    // a duplicate id is ignored
    await page.evaluate((e) => { window.__mv.fpIncoming(e); window.__mv.fpIncoming(e); }, fpEvent('d5', '7', 'Twice Guy', 6.0));
    await page.waitForSelector('#fpop');
    await page.waitForFunction(() => !document.getElementById('fpop'), null, { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await page.evaluate(() => !!document.getElementById('fpop')), false, 'shown once, not twice');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('score pop-up settings: admins see them and the sample pop-up shows; it waits while a window is open; pop-ups can be switched off', async () => {
    const { ctx, page, errors } = await open(two, { init: `window.__fpTiming = { slide: 80, hold0: 100, roll: 100, show: 400, gap: 30 };` });
    await page.waitForFunction(() => window.__players.length === 2);
    await page.evaluate(() => { window.__mv.FP.avail = true; });
    await page.evaluate(() => document.getElementById('sm-settings').click());
    await page.waitForSelector('#fp-on');
    assert.equal(await page.evaluate(() => document.getElementById('fp-min').value), '3', 'default smallest score is 3 points');
    assert.equal(await page.evaluate(() => document.getElementById('fp-delay').value), '0');
    await page.selectOption('#fp-min', '5');
    await page.selectOption('#fp-delay', '10');
    assert.deepEqual(await page.evaluate(() => [window.__mv.S.fmin, window.__mv.S.fdelay]), [5, 10]);
    await page.selectOption('#fp-min', '3');
    await page.selectOption('#fp-delay', '0');
    await page.click('#fp-test');
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => !!document.getElementById('fpop')), false, 'held while the settings window is open');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#fpop', { timeout: 3000 });
    await page.waitForFunction(() => !document.getElementById('fpop'), null, { timeout: 4000 });
    await page.evaluate(() => { window.__mv.S.fpop = false; });
    await page.evaluate((e) => window.__mv.fpIncoming(e), fpEvent('o1', '6794', "Ja'Marr Chase", 7.0));
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => !!document.getElementById('fpop')), false, 'off means off');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  const tkPl = (id, name, pos, side, order, pts, st, extra = {}) => Object.assign({ playerId: id, name, pos, nflTeam: 'CIN', side, starter: true, slot: pos, slotOrder: order, kickoffAt: '2026-11-08T18:00:00Z', points: pts, projected: 10, gameStatus: st, gameClock: null, stats: null }, extra);
  const tkSum = (mod) => {
    const s = { leagues: [
      { leagueId: 'a', name: 'The Forgotten Titans', status: 'live', colour: 'green', mine: { name: 'The All Days', points: 96.4, projected: 130 }, opp: { name: 'Bills Mafia', points: 78.2, projected: 120 }, players: [
        tkPl('2', 'Runner Mine', 'RB', 'mine', 2, 11.2, 'live', { stats: { rushAtt: 12, rushYds: 61, rushTd: 1, rec: 2, recYds: 14 } }),
        tkPl('1', 'Quarterback Mine', 'QB', 'mine', 1, 18.4, 'final', { stats: { passCmp: 21, passAtt: 31, passYds: 250, passTd: 2, int: 1 } }),
        tkPl('5', 'Later Guy', 'WR', 'mine', 3, 0, 'pre', { kickoffAt: '2026-11-08T21:25:00Z' }),
        tkPl('7', 'Opp Runner', 'RB', 'opp', 2, 4.1, 'live', { stats: { rushAtt: 5, rushYds: 21, rec: 1, recYds: 9 } }),
        tkPl('6', 'Opp Quarterback', 'QB', 'opp', 1, 9.9, 'final', { stats: { passCmp: 10, passAtt: 20, passYds: 120 } })] },
      { leagueId: 'b', name: 'IRONMAN FF', status: 'live', colour: 'red', mine: { name: 'Iron Team', points: 48.5, projected: 90 }, opp: { name: 'Steel Team', points: 83.9, projected: 120 }, players: [
        tkPl('2', 'Runner Mine', 'RB', 'mine', 1, 11.2, 'live', { stats: { rushAtt: 12, rushYds: 61, rushTd: 1 } }),
        tkPl('8', 'Steel Wide', 'WR', 'opp', 1, 14.3, 'live', { stats: { rec: 5, recYds: 80 } })] }] };
    if (mod) mod(s);
    return s;
  };
  const tkOpen = async (init = '') => {
    const r = await open(two, { init: `window.__ftSpeed = 0; window.__ftTiming = { roll: 150, glow: 600 }; window.__ftPollMs = 3600000;` + init });
    await r.page.waitForFunction(() => window.__players.length === 2);
    await r.page.waitForFunction(() => window.__mv.FP.status !== null);   // the page's own status call has answered (not set up), so it cannot overwrite the next line
    await r.page.evaluate(() => { window.__mv.FP.avail = true; });
    return r;
  };
  const tkSet = (page, sum) => page.evaluate((x) => window.__mv.ftSet(x), sum);
  const tkAt = async (page, x) => { await page.evaluate((v) => { window.__mv.FT.x = v; }, x); await page.waitForTimeout(60); await page.evaluate(() => window.__mv.ftCheck()); };

  test('ticker: bar below the video, league header with colours, lineups in roster-slot order, pre/live/final formats', async () => {
    const { ctx, page, errors } = await tkOpen();
    await tkSet(page, tkSum());
    await page.waitForSelector('#ftick:not([hidden])');
    const d = await page.evaluate(() => {
      const seg = document.querySelector('.ft-seg');
      const col = (e) => getComputedStyle(e).color;
      const bar = document.getElementById('ftick').getBoundingClientRect();
      const grid = document.getElementById('grid').getBoundingClientRect();
      const its = [...seg.querySelectorAll('.ft-it')];
      return { name: seg.querySelector('.ft-name').textContent, me: seg.querySelector('.ft-me').textContent, op: seg.querySelector('.ft-op').textContent, tn: [...seg.querySelectorAll('.ft-tn')].map((e) => e.textContent),
        meCol: col(seg.querySelector('.ft-me')), opCol: col(seg.querySelector('.ft-op')), nameCol: col(seg.querySelector('.ft-name')),
        divs: [...seg.querySelectorAll('.ft-div')].map((e) => e.textContent), order: its.map((e) => e.querySelector('.ft-nm').textContent),
        l2: its.map((e) => e.querySelector('.ft-l2').textContent), pts: its.map((e) => e.querySelector('.ft-pts').textContent + '|' + e.querySelector('.ft-pts').style.display),
        finalCol: col(its[0].querySelector('.ft-nm')), liveCol: col(its[1].querySelector('.ft-nm')), barH: bar.height, barBottom: bar.bottom, vh: innerHeight, gridBottom: grid.bottom, barBg: getComputedStyle(document.getElementById('ftick')).backgroundColor,
        copies: document.querySelectorAll('.ft-copy').length, leagues: seg.parentNode.querySelectorAll('.ft-name').length };
    });
    assert.equal(d.name, 'The Forgotten Titans');
    assert.equal(d.me, '96.4'); assert.equal(d.op, '78.2');
    assert.deepEqual(d.tn, ['The All Days', 'Bills Mafia']);
    assert.equal(d.meCol, 'rgb(63, 174, 88)', 'my score and team name take the league colour (green)');
    assert.equal(d.opCol, 'rgb(255, 255, 255)');
    assert.equal(d.nameCol, 'rgb(255, 255, 255)');
    assert.deepEqual(d.order, ['Quarterback Mine', 'Runner Mine', 'Later Guy', 'Opp Quarterback', 'Opp Runner'], 'mine then opponent, each in roster-slot order');
    assert.deepEqual(d.divs, ['The All Days', 'vs Bills Mafia']);
    assert.equal(d.l2[0], '(21/31, 250 yds, 2 TD, 1 INT)', 'final stats');
    assert.equal(d.l2[1], '(12 car, 61 yds, 1 TD, 2 rec, 14 yds)', 'live stats in brackets');
    assert.match(d.l2[2], /\d/, 'a game time for a player who has not played');
    assert.doesNotMatch(d.l2[2], /\(/);
    assert.equal(d.pts[0].split('|')[0], '18.4'); assert.equal(d.pts[1].split('|')[0], '11.2'); assert.match(d.pts[2], /none$/, 'no points shown before the game');
    assert.notEqual(d.finalCol, d.liveCol, 'final players are lighter grey');
    assert.match(d.finalCol, /rgb\((1[5-9]\d|2\d\d)/);
    assert.equal(d.barBg, 'rgb(11, 14, 20)', 'opaque bar');
    assert.ok(Math.abs(d.barH - 57) <= 2 && Math.abs(d.barBottom - d.vh) <= 1);
    assert.ok(d.gridBottom <= d.vh - 54, 'below the video: the grid is shorter so nothing is covered, got ' + d.gridBottom);
    assert.equal(d.leagues, 2);
    assert.ok(d.copies >= 2);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('ticker: overlap keeps the grid full height; setting is saved; can be switched off', async () => {
    const { ctx, page, errors } = await tkOpen();
    await tkSet(page, tkSum());
    await page.waitForSelector('#ftick:not([hidden])');
    await page.evaluate(() => document.getElementById('sm-settings').click());
    await page.waitForSelector('#ft-pos');
    assert.equal(await page.evaluate(() => document.getElementById('ft-pos').value), 'below', 'default is below the video');
    await page.selectOption('#ft-pos', 'overlap');
    assert.equal(await page.evaluate(() => window.__mv.S.fpos), 'overlap');
    await page.waitForTimeout(100);
    const o = await page.evaluate(() => ({ grid: document.getElementById('grid').getBoundingClientRect().bottom, vh: innerHeight, below: document.body.classList.contains('ftick-below'), bar: !document.getElementById('ftick').hidden }));
    assert.equal(o.below, false); assert.ok(o.bar); assert.ok(Math.abs(o.grid - o.vh) <= 1);
    await page.selectOption('#ft-speed', 'fast');
    assert.equal(await page.evaluate(() => window.__mv.S.fspeed), 'fast');
    await page.click('#ft-on');
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.getElementById('ftick').hidden), true, 'switched off');
    assert.equal(await page.evaluate(() => Math.abs(document.getElementById('grid').getBoundingClientRect().bottom - innerHeight) <= 1), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('ticker: league name and score stall at the left, team names drop away, the next league pushes them off', async () => {
    const { ctx, page, errors } = await tkOpen();
    await tkSet(page, tkSum());
    await page.waitForSelector('#ftick:not([hidden])');
    const g = await page.evaluate(() => { const m = window.__mv.FT.model; const s = m.leagues[0].segs[0]; const t = m.leagues[1].segs[0]; return { x: s.x, w: s.w, pinW: s.pinW, nx: t.x, nw: s.nw }; });
    // before it reaches the edge: nothing pinned, team names visible
    await tkAt(page, Math.max(0, g.x - 5));
    assert.equal(await page.evaluate(() => document.querySelector('.ft-seg').classList.contains('pinned')), false);
    // well into the league: name at the left edge, score right of it, team names gone, items going behind the block
    await tkAt(page, g.x + 400);
    const p = await page.evaluate(() => { const seg = document.querySelector('.ft-seg'); const v = document.getElementById('ft-view').getBoundingClientRect(); const n = seg.querySelector('.ft-name').getBoundingClientRect(); const sc = seg.querySelector('.ft-score').getBoundingClientRect(); const tn = getComputedStyle(seg.querySelector('.ft-tn')).opacity;
      const z = (e) => Number(getComputedStyle(e).zIndex); const it = seg.querySelector('.ft-it');
      return { pinned: seg.classList.contains('pinned'), nameLeft: Math.round(n.left - v.left), scoreLeft: Math.round(sc.left - n.right), tn, zPin: z(seg.querySelector('.ft-score')), zIt: z(it) || 0 }; });
    assert.equal(p.pinned, true);
    assert.equal(p.nameLeft, 0, 'league name sits at the left edge');
    assert.ok(Math.abs(p.scoreLeft) <= 1, 'score sits right beside the name');
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.ft-seg .ft-tn')).opacity), '0', 'team names fall off');
    assert.ok(p.zPin > p.zIt, 'the lineup slides behind the pinned block');
    // the next league's name arrives and pushes the block off the left edge
    await tkAt(page, g.nx - 60);
    const q = await page.evaluate(() => { const v = document.getElementById('ft-view').getBoundingClientRect(); const n = document.querySelector('.ft-seg .ft-name').getBoundingClientRect(); const n2 = document.querySelectorAll('.ft-seg')[1].querySelector('.ft-name').getBoundingClientRect(); return { left: Math.round(n.left - v.left), right: Math.round(n.right - v.left), n2: Math.round(n2.left - v.left) }; });
    assert.ok(q.left < 0, 'first league name is being pushed off the left, at ' + q.left);
    assert.ok(q.n2 > 0 && q.n2 < 200, 'second league name arrives from the right: ' + q.n2);
    await tkAt(page, g.nx + 300);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.ft-seg')[1].classList.contains('pinned')), true);
    assert.equal(await page.evaluate(() => document.querySelector('.ft-seg').classList.contains('pinned')), false);
    // the tape loops: it wraps by one copy
    const wrap = await page.evaluate(() => { const F = window.__mv.FT; F.x = F.copyW - 1; return F.copyW; });
    assert.ok(wrap > 800);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('ticker: a player who scored since last on screen glows (green mine, red opponent) and rolls up with the team total; first sight is only a baseline', async () => {
    const { ctx, page, errors } = await tkOpen();
    await tkSet(page, tkSum());
    await page.waitForSelector('#ftick:not([hidden])');
    const g = await page.evaluate(() => { const s = window.__mv.FT.model.leagues[0].segs[0]; return { x: s.x, pinW: s.pinW }; });
    // the lineup comes on screen for the first time: baseline, no glow
    await tkAt(page, g.x + 120);
    const glow = () => page.evaluate(() => ({ mine: document.querySelectorAll('.up-mine').length, opp: document.querySelectorAll('.up-opp').length }));
    assert.deepEqual(await glow(), { mine: 0, opp: 0 }, 'first time on screen is a baseline');
    // scrolled off to the far side of the tape (league b), then new scores arrive for both sides
    const nx = await page.evaluate(() => window.__mv.FT.model.leagues[1].segs[0].x);
    await tkAt(page, nx + 400);
    await tkSet(page, tkSum((s) => { s.leagues[0].players[0].points = 15.2; s.leagues[0].mine.points = 100.4; s.leagues[0].players[3].points = 8.1; s.leagues[0].opp.points = 82.2; }));
    // league a is off screen: its total waits and nothing glows yet
    assert.deepEqual(await glow(), { mine: 0, opp: 0 });
    const shown = await page.evaluate(() => document.querySelector('.ft-seg .ft-me').textContent);
    assert.equal(shown, '96.4', 'the total waits for the player to come on screen');
    // back to league a: both players are on screen again, scored since last time
    await tkAt(page, g.x + 120);
    await page.waitForFunction(() => document.querySelectorAll('.up-mine').length > 0 && document.querySelectorAll('.up-opp').length > 0, null, { timeout: 3000 });
    await page.waitForFunction(() => { const e = document.querySelector('.up-mine'); return !e || getComputedStyle(e).color === 'rgb(63, 174, 88)'; }, null, { timeout: 2000 }).catch(() => {});
    const col = await page.evaluate(() => ({ mine: getComputedStyle(document.querySelector('.up-mine')).color, opp: getComputedStyle(document.querySelector('.up-opp')).color, glow: getComputedStyle(document.querySelector('.up-mine')).textShadow }));
    assert.equal(col.mine, 'rgb(63, 174, 88)'); assert.equal(col.opp, 'rgb(214, 83, 59)'); assert.notEqual(col.glow, 'none');
    await page.waitForFunction(() => document.querySelector('.ft-seg .ft-me').textContent === '100.4' && document.querySelector('.ft-seg .ft-op').textContent === '82.2', null, { timeout: 3000 });
    const pts = await page.evaluate(() => [...document.querySelector('.ft-seg').querySelectorAll('.ft-it')].map((e) => e.querySelector('.ft-pts').textContent));
    assert.ok(pts.includes('15.2') && pts.includes('8.1'), 'player numbers rolled up: ' + pts.join(','));
    // the glow fades afterwards
    await page.waitForFunction(() => document.querySelectorAll('.up-mine,.up-opp').length === 0, null, { timeout: 3000 });
    // same player in league b (same id, same side) did not change: no glow there
    assert.deepEqual(await glow(), { mine: 0, opp: 0 });
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('ticker: not shown to viewers or when the server link is off', async () => {
    const { ctx, page, errors } = await open(two, { init: `window.__ftSpeed = 0;` });
    await page.waitForFunction(() => window.__players.length === 2);
    await page.evaluate((s) => window.__mv.ftSet(s), tkSum());
    assert.equal(await page.evaluate(() => { const b = document.getElementById('ftick'); return !b || b.hidden; }), true, 'FP.avail is false when Fantasy Manager is not set up');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('Settings > Fantasy Manager: save, test and remove a connection; the token is never shown again', async () => {
    const { ctx, page, errors } = await open(two, {});
    await page.waitForFunction(() => window.__players.length === 2);
    let cfg = { configured: false, url: '', tokenSaved: false, tokenLast4: '' };
    const posted = [];
    await page.route('**/api/fantasy/config', async (route) => {
      const r = route.request();
      if (r.method() === 'POST') {
        const b = r.postDataJSON(); posted.push(b);
        if (/^http:\/\/(127|localhost)/.test(b.url)) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'bad_address', message: 'localhost is not allowed' }) });
        cfg = { configured: true, url: b.url, tokenSaved: true, tokenLast4: String(b.token || 'wxyz').slice(-4), readable: true };
      } else if (r.method() === 'DELETE') cfg = { configured: false, url: '', tokenSaved: false, tokenLast4: '' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cfg) });
    });
    await page.route('**/api/fantasy/test', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().postDataJSON().token === 'goodtoken123' ? { ok: true, version: '4.17.1' } : { ok: false, error: 'Fantasy Manager refused the token' }) }));
    await page.route('**/api/fantasy/status', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: cfg.configured, connected: false, lastEventAt: null, summaryAt: null, error: '' }) }));
    await page.route('**/api/fantasy/stream*', (route) => route.abort());
    await page.route('**/api/fantasy/summary', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ leagues: [] }) }));
    await page.evaluate(() => document.getElementById('sm-settings').click());
    await page.waitForSelector('#fm-url');
    assert.equal(await vis(page, '#fm-remove'), false, 'nothing to remove yet');
    assert.equal(await page.evaluate(() => !!document.getElementById('fp-on')), false, 'pop-up options appear once a connection exists');
    await page.fill('#fm-url', 'http://127.0.0.1:5000'); await page.fill('#fm-token', 'goodtoken123');
    await page.click('#fm-save');
    await page.waitForFunction(() => /not allowed/.test(document.getElementById('fm-msg').textContent));
    await page.fill('#fm-url', 'http://192.168.4.11:5000');
    await page.click('#fm-test');
    await page.waitForFunction(() => /^ok - connected to Fantasy Manager 4\.17\.1/.test(document.getElementById('fm-msg').textContent));
    await page.fill('#fm-token', 'badtoken');
    await page.click('#fm-test');
    await page.waitForFunction(() => /refused the token/.test(document.getElementById('fm-msg').textContent));
    await page.fill('#fm-token', 'goodtoken123');
    await page.click('#fm-save');
    await page.waitForFunction(() => document.getElementById('fm-msg').textContent === 'Saved.');
    const after = await page.evaluate(() => ({ token: document.getElementById('fm-token').value, ph: document.getElementById('fm-token').placeholder, url: document.getElementById('fm-url').value, type: document.getElementById('fm-token').type, opts: !!document.getElementById('fp-on'), tkpos: !!document.getElementById('ft-pos'), html: document.documentElement.innerHTML.includes('goodtoken123') }));
    assert.equal(after.token, ''); assert.match(after.ph, /ends n123/); assert.equal(after.url, 'http://192.168.4.11:5000'); assert.equal(after.type, 'password');
    assert.equal(after.html, false, 'the saved token is nowhere in the page');
    assert.ok(after.opts && after.tkpos, 'pop-up and ticker options appear once saved');
    assert.equal(await page.evaluate(() => window.__mv.FP.avail), true);
    assert.equal(await vis(page, '#fm-remove'), true);
    assert.equal(posted[posted.length - 1].token, 'goodtoken123');
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('goodtoken123')), false, 'never in browser storage');
    await page.click('#fm-remove');
    await page.waitForFunction(() => document.getElementById('fm-msg').textContent === 'Removed.');
    assert.equal(await page.evaluate(() => window.__mv.FP.avail), false);
    assert.equal(await page.evaluate(() => document.getElementById('fm-url').value), '');
    assert.equal(await vis(page, '#fm-remove'), false);
    assert.deepEqual(errors.filter((e) => !/fantasy|stream|ERR_FAILED|aborted/i.test(e)), []);
    await ctx.close();
  });

  const dgScreen = (o = {}) => Object.assign({ slot: 1, name: 'ESPN', phase: 'playing', via: 'WebSocket', tx: false, sd: false, res: '1280x720', ahead: 4.1, minAhead: 3.2, stalls: 0, stallMs: 0, longest: 0, dropped: 0, frames: 1000, kbpsIn: 4000, startupMs: 2100, restarts: 0, seconds: 60 }, o);
  const dgStream = (o = {}) => Object.assign({ key: 'p1:1', provider: 'One', sid: '1', name: 'ESPN', state: 'live', kbps: 4000, connectMs: 80, firstByteMs: 300, maxGapMs: 200, reconnects: 0, errors: [], seconds: 100, viewers: [{ seconds: 60, kbpsSent: 4000, queueKB: 0, peakKB: 20, backups: 0 }], viewerCount: 1 }, o);
  const dgServer = (o = {}) => Object.assign({ cpuPct: 20, cores: 4, load1: 0.5, rssMB: 120, loopLagP99Ms: 5, loopLagMaxMs: 12, ffmpeg: 0, uptimeSec: 999 }, o);
  const dgSnap = (sc, st, sv) => ({ at: Date.now(), screens: [dgScreen(sc)], streams: [dgStream(st)], server: dgServer(sv) });

  test('diagnostics: stalls are counted per screen, and the verdict names provider, server, link or device', async () => {
    const { ctx, page, errors } = await open(two, {});
    await page.waitForFunction(() => window.__players.length === 2);
    const info = await page.evaluate(async () => {
      const t = window.__mv.tiles[0];
      t.dgStallStart(); await new Promise((r) => setTimeout(r, 300)); t.dgStallEnd();
      t.dgStallStart(); t.dgStallStart(); await new Promise((r) => setTimeout(r, 400)); t.dgStallEnd(); t.dgStallEnd();
      t.dgStallStart(); t.dgStallEnd();                    // too short to count
      return t.dgInfo();
    });
    assert.equal(info.stalls, 2);
    assert.ok(info.stallMs >= 650 && info.longest >= 380 && info.slot === 1);
    const v = (r) => page.evaluate((x) => window.__mv.diagVerdict(x), r);
    const run = (first, last, extra = {}) => ({ snaps: [first, last], mbps: 300, ...extra });
    let r = await v({ snaps: [{ screens: [], streams: [], server: dgServer() }, { screens: [], streams: [], server: dgServer() }] });
    assert.match(r.summary, /Nothing is playing/);
    r = await v(run(dgSnap(), dgSnap()));
    assert.match(r.summary, /No stalls/); assert.equal(r.findings.length, 0);
    r = await v(run(dgSnap(), dgSnap({ stalls: 3, stallMs: 4000, minAhead: 0.1 }, { maxGapMs: 6500, reconnects: 2, kbps: 900 })));
    assert.deepEqual(r.findings.map((f) => f.cause), ['provider']); assert.match(r.summary, /3 stall/);
    r = await v(run(dgSnap(), dgSnap({ stalls: 2, stallMs: 2000, minAhead: 0.2 }, {}, { loopLagP99Ms: 400, cpuPct: 95 })));
    assert.deepEqual(r.findings.map((f) => f.cause), ['server']);
    r = await v(run(dgSnap(), dgSnap({ stalls: 2, stallMs: 2000, minAhead: 0.2 }, { viewers: [{ seconds: 60, kbpsSent: 1000, queueKB: 900, peakKB: 2000, backups: 4 }] })));
    assert.deepEqual(r.findings.map((f) => f.cause), ['link']);
    r = await v(run(dgSnap(), dgSnap({ stalls: 2, stallMs: 2000, minAhead: 0.2 }), { mbps: 6 }));
    assert.deepEqual(r.findings.map((f) => f.cause), ['link'], 'a slow speed test against the stream needs');
    r = await v(run(dgSnap(), dgSnap({ stalls: 1, stallMs: 1000, minAhead: 3, dropped: 120, frames: 2000 })));
    assert.deepEqual(r.findings.map((f) => f.cause), ['browser']);
    r = await v(run(dgSnap(), dgSnap({ stalls: 2, stallMs: 2000, minAhead: 0.2 })));
    assert.equal(r.findings.length, 0); assert.match(r.summary, /no network, server or device problem/);
    const rep = await page.evaluate((x) => window.__mv.diagReport(x, window.__mv.diagVerdict(x)), run(dgSnap(), dgSnap({ stalls: 1, minAhead: 0.1 })));
    assert.match(rep, /Verdict:/); assert.match(rep, /ESPN \(One\)/);
    assert.equal(/https?:\/\//.test(rep.replace(/Mozilla[^\n]*/, '')), false, 'the report holds no web addresses');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('diagnostics window: opens from Settings, live tables, a short test ends with a verdict and a copyable report', async () => {
    const { ctx, page, errors } = await open(two, { init: `window.__dgSecs = 4;` });
    await page.waitForFunction(() => window.__players.length === 2);
    let n = 0;
    await page.route('**/api/diag', (route) => { n++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ at: Date.now(), server: dgServer(), streams: [dgStream(n > 1 ? { maxGapMs: 7000, reconnects: n } : {})] }) }); });
    await page.route('**/api/diag/speed*', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.alloc(1024 * 1024) }));
    await page.evaluate(() => document.getElementById('sm-settings').click());
    await page.waitForSelector('#set-diag');
    await page.click('#set-diag');
    await page.waitForSelector('#dg-table table');
    assert.match(await page.textContent('#dg-table'), /ESPN/);
    assert.match(await page.textContent('#dg-table'), /event loop delay 5 ms/);
    await page.click('#dg-run');
    await page.waitForFunction(() => !document.getElementById('dg-report').hidden, null, { timeout: 20000 });
    assert.match(await page.textContent('#dg-verdict'), /./);
    const rep = await page.inputValue('#dg-report');
    assert.match(rep, /Multiview diagnostics/); assert.match(rep, /Channels on the server/);
    assert.equal(await vis(page, '#dg-copy'), true);
    assert.deepEqual(errors.filter((e) => !/clipboard/i.test(e)), []);
    await ctx.close();
  });

  test('mini player in the Android app: native call, auto-start flag, page chrome hides while floating', async () => {
    const { ctx, page, errors } = await open(two, { init: `window.__app = []; window.MVApp = { canPip: function () { return true; }, enterPip: function () { window.__app.push('enter'); }, setAutoPip: function (on) { window.__app.push('auto:' + on); }, changeServer: function () {} };` });
    await page.waitForFunction(() => window.__players.length === 2);
    await tap(page, 0);
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
    await tap(page, 0);
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
    await tap(page, 0);
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
