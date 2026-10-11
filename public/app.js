/* IPTV Multiview - browser side. Plain ES2017, no build step, works with a TV remote (arrow keys + OK). */
(function () {
  'use strict';

  // ---------------------------------------------------------------- helpers
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'value') el.value = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function noop() {}
  function fmtSec(x, scale) { return scale < 20 ? x.toFixed(1) : String(Math.round(x)); }
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
    return fetch(path, init).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { /* not json */ }
        if (!r.ok) { var err = new Error((j && j.message) || ('HTTP ' + r.status)); err.status = r.status; err.code = j && j.error; if (r.status === 401 && j && j.error === 'login_required' && ME) sessionLost(); throw err; }
        return j;
      });
    });
  }
  function host(url) { try { return new URL(url).host; } catch (e) { return url; } }

  // ---------------------------------------------------------------- layouts
  // cell = [column, row, columnSpan, rowSpan]; index order = tile numbers 1..N
  var LAYOUTS = {
    '1': { name: 'Single', cols: 1, rows: 1, cells: [[1, 1, 1, 1]] },
    '2x2': { name: '2 x 2', cols: 2, rows: 2, cells: [[1, 1, 1, 1], [2, 1, 1, 1], [1, 2, 1, 1], [2, 2, 1, 1]] },
    '1+5': { name: '1 + 5', cols: 3, rows: 3, cells: [[1, 1, 2, 2], [3, 1, 1, 1], [3, 2, 1, 1], [1, 3, 1, 1], [2, 3, 1, 1], [3, 3, 1, 1]] },
    '3x3': { name: '3 x 3', cols: 3, rows: 3, cells: [[1, 1, 1, 1], [2, 1, 1, 1], [3, 1, 1, 1], [1, 2, 1, 1], [2, 2, 1, 1], [3, 2, 1, 1], [1, 3, 1, 1], [2, 3, 1, 1], [3, 3, 1, 1]] },
    // one large tile (3x3 cells) top-left, 3 on the right, 3 along the bottom, 1 in the bottom-right corner
    '1+7': { name: '1 + 7', cols: 4, rows: 4, cells: [[1, 1, 3, 3], [4, 1, 1, 1], [4, 2, 1, 1], [4, 3, 1, 1], [1, 4, 1, 1], [2, 4, 1, 1], [3, 4, 1, 1], [4, 4, 1, 1]] }
  };
  var LAYOUT_ORDER = ['1', '2x2', '1+5', '3x3', '1+7'];
  var SLOTS = 9;

  // ---------------------------------------------------------------- state
  var LS_KEY = 'mv.state.v1';
  var S = loadState();
  var ME = null; // set after /api/me: { admin, user, open, authRequired }
  function loadState() {
    var d = { layout: '3x3', tiles: [], sel: 0, muted: false, bufSec: 4, keepSec: 0, transport: 'auto', fit: 'contain', failover: true, smallSd: true, shared: '', workers: true, stats: false, labels: false, epgOn: true, favs: {}, pk: {} };
    var j = {};
    try { j = JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { j = {}; }
    Object.keys(d).forEach(function (k) { if (j[k] !== undefined && typeof j[k] === typeof d[k]) d[k] = j[k]; });
    if (!LAYOUTS[d.layout]) d.layout = '3x3';
    var tiles = Array.isArray(j.tiles) ? j.tiles : [];
    d.tiles = [];
    for (var i = 0; i < SLOTS; i++) {
      var t = tiles[i];
      d.tiles.push(cleanTile(t));
    }
    d.sel = clamp(Math.floor(d.sel) || 0, 0, SLOTS - 1);
    d.bufSec = clamp(Number(d.bufSec) || 0, 0, 300);
    d.keepSec = clamp(Number(d.keepSec) || 0, 0, 900);
    return d;
  }
  // a tile's saved settings; vod/ext mark a movie or episode (played from the provider's file, not as live TV)
  function cleanTile(t) {
    if (!t || typeof t.p !== 'string' || t.sid == null) return null;
    var o = { p: t.p, sid: String(t.sid), name: String(t.name || ''), icon: String(t.icon || '') };
    if (t.q === 'sd' || t.q === 'full' || t.q === '480') o.q = t.q;
    if (t.vod === 'movie' || t.vod === 'series') { o.vod = t.vod; o.ext = String(t.ext || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4'; }
    return o;
  }
  var saveTimer = null;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) { /* private mode */ } }, 250);
  }

  var tiles = [];
  var zoom = -1;
  var userActive = false;
  var serverState = { providers: [], streams: [] };
  var providersCache = null; // full provider records from /api/providers
  var chanCache = {};       // providerId -> { cats, list }

  function layout() { return LAYOUTS[S.layout]; }
  function visibleCount() { return layout().cells.length; }

  // ---------------------------------------------------------------- banner / hint
  var bannerTimer = null;
  function banner(msg, ms) {
    var b = $('#banner');
    clearTimeout(bannerTimer);
    if (!msg) { b.hidden = true; return; }
    b.textContent = msg;
    b.hidden = false;
    if (ms) bannerTimer = setTimeout(function () { b.hidden = true; }, ms);
  }
  function hint(msg) {
    var e = $('#hint');
    if (!msg) { e.hidden = true; return; }
    e.textContent = msg;
    e.hidden = false;
  }

  // ---------------------------------------------------------------- modals (Back button / Esc closes the top one)
  var modals = [];
  var sentinel = false;
  var ignorePops = 0;
  var backTimer = null;

  function pushSentinel() {
    if (backTimer) { clearTimeout(backTimer); backTimer = null; return; }
    if (!sentinel) { try { history.pushState({ mv: 1 }, ''); sentinel = true; } catch (e) { /* ignore */ } }
  }
  function popSentinel() {
    if (modals.length || !sentinel) return;
    backTimer = setTimeout(function () {
      backTimer = null;
      if (sentinel && !modals.length) { sentinel = false; ignorePops++; history.back(); }
    }, 60);
  }
  window.addEventListener('popstate', function () {
    if (ignorePops > 0) { ignorePops--; return; }
    sentinel = false;
    if (modals.length) {
      removeModal(modals[modals.length - 1]);
      if (modals.length) pushSentinel();
    }
  });

  function focusables(root) {
    var list = root.querySelectorAll('button:not([disabled]), select, input:not([disabled]), [tabindex="0"]');
    return Array.prototype.filter.call(list, function (el) { return el.offsetParent !== null; });
  }

  function modalKeys(box, e) {
    var vertical = e.key === 'ArrowDown' || e.key === 'ArrowUp';
    var horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    if (!vertical && !horizontal) return;
    var t = e.target;
    if (t.tagName === 'SELECT') return;
    if (t.tagName === 'INPUT') {
      if (horizontal && t.type !== 'checkbox') return; // keep caret movement in text fields
    }
    var items = focusables(box);
    var i = items.indexOf(t);
    if (i < 0) return;
    var next = items[clamp(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1), 0, items.length - 1)];
    e.preventDefault();
    next.focus();
    if (next.scrollIntoView) next.scrollIntoView({ block: 'nearest' });
  }

  function openModal(opts) {
    var body = h('div', { class: 'body' }, opts.body);
    var box = h('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog' },
      opts.title ? h('h2', { text: opts.title }) : null, body, opts.foot ? h('div', { class: 'foot' }, opts.foot) : null);
    var back = h('div', { class: 'modal-back' }, box);
    back.addEventListener('mousedown', function (e) { if (e.target === back) m.close(); });
    back.addEventListener('keydown', function (e) { if (!e.defaultPrevented) modalKeys(box, e); });
    var m = {
      el: back, box: box, body: body, onClose: opts.onClose, returnFocus: document.activeElement,
      close: function () { closeModal(m); },
      setBody: function (node, foot) {
        body.textContent = '';
        append(body, node);
        var f = box.querySelector('.foot');
        if (foot !== undefined) {
          if (f) f.remove();
          if (foot) box.appendChild(h('div', { class: 'foot' }, foot));
        }
      }
    };
    document.body.appendChild(back);
    modals.push(m);
    pushSentinel();
    toolbarWake();
    var first = opts.focus ? $(opts.focus, box) : focusables(box)[0];
    if (first) first.focus();
    return m;
  }
  function removeModal(m) {
    var i = modals.indexOf(m);
    if (i < 0) return;
    modals.splice(i, 1);
    if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
    if (m.onClose) m.onClose();
    var rf = m.returnFocus;
    if (!modals.length && rf && rf.focus && document.body.contains(rf)) rf.focus();
    else if (!modals.length && tiles[S.sel]) tiles[S.sel].el.focus();
  }
  function closeModal(m) {
    removeModal(m);
    popSentinel();
  }
  function closeTopModal() { if (modals.length) closeModal(modals[modals.length - 1]); }

  // ---------------------------------------------------------------- tiles
  var BACKOFF = [1000, 2000, 4000, 8000, 15000];
  var wsBlocked = false;   // set when WebSockets repeatedly fail before any video (e.g. a proxy that blocks them)
  var wsFails = 0;
  var wsWorked = false;

  function Tile(idx) {
    this.idx = idx;
    this.cfg = null;
    this.visible = false;
    this.player = null;
    this.phase = 'idle';
    this.gen = 0;
    this.retry = 0;
    this.zoomPaused = false;
    this.hasPlayed = false;
    this.lastTime = 0;
    this.mediaErrors = 0;
    var self = this;
    this.video = h('video', { playsinline: true, muted: true, preload: 'auto' });
    this.video.muted = true;
    this.video.setAttribute('disablepictureinpicture', '');
    this.num = h('div', { class: 'num', text: String(idx + 1) });
    this.labName = h('span', { class: 'lname' });
    this.labNow = h('span', { class: 'lnow' });
    this.label = h('div', { class: 'label' }, this.labName, this.labNow);
    this.now = null;
    this.speaker = h('div', { class: 'speaker', text: 'sound' });
    this.more = h('button', { class: 'more', type: 'button', tabindex: '-1', title: 'Tile menu', text: '...' });
    this.status = h('div', { class: 'status', hidden: true });
    this.stats = h('div', { class: 'stats' });
    this.empty = h('div', { class: 'empty' }, h('b', { text: '+' }), h('span', { text: 'Add channel' }));
    this.el = h('div', { class: 'tile', tabindex: '0', 'data-idx': String(idx) },
      this.video, this.empty, this.num, this.label, this.speaker, this.more, this.status, this.stats);
    this.touch = false;
    this.el.addEventListener('pointerdown', function (e) { self.touch = e.pointerType === 'touch'; });
    this.el.addEventListener('click', function () { tileClick(self); });
    this.el.addEventListener('dblclick', function () { if (self.cfg) toggleZoom(self.idx); });
    this.el.addEventListener('contextmenu', function (e) { e.preventDefault(); select(self.idx); openTileMenu(self.idx); });
    this.el.addEventListener('focus', function () { if (S.sel !== self.idx) select(self.idx, true); });
    this.more.addEventListener('click', function (e) { e.stopPropagation(); select(self.idx); openTileMenu(self.idx); });
    this.video.addEventListener('playing', function () { self.hasPlayed = true; if (self.viaWs) { wsWorked = true; wsFails = 0; } });
    this.video.addEventListener('timeupdate', function () { self.lastTime = Date.now(); });
    this.render();
  }

  Tile.prototype.render = function () {
    var c = this.cfg;
    this.empty.style.display = c ? 'none' : '';
    this.labName.textContent = c ? c.name || ('Channel ' + c.sid) : '';
    this.labNow.textContent = c && !c.vod && this.now && S.epgOn ? 'Now: ' + this.now : '';
    this.video.style.visibility = c && !(sharedOn() && !c.vod) ? '' : 'hidden';
    if (!c) this.setStatus('');
  };

  Tile.prototype.setStatus = function (txt, isErr) {
    this.status.hidden = !txt;
    this.status.textContent = txt || '';
    this.status.className = 'status' + (isErr ? ' err' : '');
  };

  Tile.prototype.reload = function () {
    this.retry = 0;
    this.mediaErrors = 0;
    this.start();
  };

  Tile.prototype.setCfg = function (cfg) {
    this.cfg = cfg;
    this.now = null;
    this.retry = 0;
    this.mediaErrors = 0;
    this.render();
    this.start();
  };

  Tile.prototype.setVisible = function (v) {
    if (v === this.visible) return;
    this.visible = v;
    if (v) this.start(); else this.stop();
  };

  Tile.prototype.ahead = function () {
    var v = this.video;
    var b;
    try { b = v.buffered; } catch (e) { return 0; }
    var t = v.currentTime;
    for (var i = 0; i < b.length; i++) {
      if (b.end(i) > t) return b.end(i) - Math.max(t, b.start(i));
    }
    return 0;
  };

  // A small tile (a ninth of the screen or less, not zoomed) asks for the provider's SD version of the channel when one exists.
  function isSmallTile(idx) {
    var L = layout();
    var c = L.cells[idx];
    return !!c && zoom < 0 && L.cells.length > 1 && (c[2] * c[3]) / (L.cols * L.rows) <= 1 / 6;
  }
  Tile.prototype.wantSd = function () {
    var c = this.cfg;
    if (!c || c.vod) return false;
    if (c.q === 'sd') return true;
    if (c.q === 'full' || c.q === '480') return false;
    return !!S.smallSd && isSmallTile(this.idx);
  };
  // after a layout, zoom or setting change: switch the stream only when the wanted quality changed
  Tile.prototype.applyQuality = function () {
    if (!this.cfg || !this.visible || this.cfg.vod || this.phase === 'idle' || this.phase === 'vod') return;
    if (this.wantSd() !== this.sdUsed) this.start();
  };

  Tile.prototype.start = function () {
    this.stop();
    if (!this.cfg || !this.visible) { this.render(); return; }
    var self = this;
    if (this.cfg.vod) { this.startVod(); return; }
    if (sharedOn()) { this.render(); this.setStatus(''); return; } // the shared screen shows live channels
    var mp = window.mpegts;
    if (!mp || !mp.getFeatureList || !mp.getFeatureList().mseLivePlayback) {
      this.setStatus('This browser cannot play live MPEG-TS (no MSE live playback)', true);
      return;
    }
    var gen = ++this.gen;
    var c = this.cfg;
    this.phase = 'prebuffer';
    this.phaseAt = Date.now();
    this.startedAt = Date.now();
    this.hasPlayed = false;
    this.lastTime = Date.now();
    this.setStatus('Connecting...');
    // Absolute address (a worker cannot resolve a relative one). WebSockets avoid the browser's limit of ~6 plain-HTTP
    // connections per address, which a 3x3 grid would hit; plain HTTP stays as a fallback.
    var useWs = S.transport !== 'http' && !wsBlocked && typeof WebSocket !== 'undefined';
    this.viaWs = useWs;
    this.sdUsed = this.wantSd();
    var path = encodeURIComponent(c.p) + '/' + encodeURIComponent(c.sid) + '.ts?buf=' + S.bufSec + (S.failover ? '' : '&failover=0') + (this.sdUsed ? '&q=sd' : '');
    var url = useWs ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/stream/' + path : location.origin + '/stream/' + path;
    this.txUsed = false;
    function begin(url) {
      if (gen !== self.gen) return;
      var player;
      try {
        player = mp.createPlayer({ type: 'mpegts', isLive: true, url: url }, {
          enableWorker: !!S.workers,
          enableStashBuffer: true,
          liveBufferLatencyChasing: false,
          autoCleanupSourceBuffer: true,
          autoCleanupMaxBackwardDuration: 20,
          autoCleanupMinBackwardDuration: 10,
          fixAudioTimestampGap: true
        });
      } catch (e) {
        self.setStatus('Player error: ' + e.message, true);
        return;
      }
      player.on(mp.Events.ERROR, function (type, detail, info) { if (gen === self.gen) self.onError(type, detail, info); });
      player.on(mp.Events.LOADING_COMPLETE, function () { if (gen === self.gen) self.onError('ended'); });
      player.attachMediaElement(self.video);
      player.load();
      self.player = player;
      self.tickTimer = setInterval(function () { self.tick(); }, 400);
      applyAudio();
    }
    if (c.q === '480') {
      // the server re-encodes this one channel at 480p (needs a GPU encoder there); if it declines, play the original
      api('/api/compose', { method: 'POST', body: { kind: 'tile', res: 480, cols: 1, rows: 1, audio: 0, cells: [{ x: 1, y: 1, w: 1, h: 1, p: c.p, sid: c.sid }] } }).then(function (r) {
        if (gen !== self.gen) return;
        self.txUsed = true;
        begin(useWs ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + r.ws : location.origin + r.stream);
      }, function (e) {
        if (gen !== self.gen) return;
        banner('480p transcode not available: ' + e.message + ' - playing the original', 7000);
        begin(url);
      });
      return;
    }
    begin(url);
  };

  // A movie or episode: the browser plays the provider's file through the server's range proxy.
  Tile.prototype.startVod = function () {
    var self = this;
    var c = this.cfg;
    var gen = ++this.gen;
    this.phase = 'vod';
    this.hasPlayed = false;
    this.setStatus('Loading...');
    var url = location.origin + '/vod/' + enc(c.p) + '/' + enc(c.sid + '.' + (c.ext || 'mp4'));
    var v = this.video;
    var key = c.p + ':' + c.sid;
    var resume = this.resumeKey === key ? this.resumeAt : 0;
    this.vodKey = key;
    v.controls = true;
    v.onloadedmetadata = function () { if (gen === self.gen && resume > 1) { try { v.currentTime = resume; } catch (e) { /* not seekable yet */ } } };
    v.onplaying = function () { if (gen === self.gen) { self.hasPlayed = true; self.retry = 0; self.setStatus(''); } };
    v.onwaiting = function () { if (gen === self.gen && self.hasPlayed) self.setStatus('Buffering...'); };
    v.oncanplay = function () { if (gen === self.gen && !self.hasPlayed) self.setStatus(''); };
    v.onerror = function () {
      if (gen !== self.gen) return;
      var code = v.error ? v.error.code : 0;
      // ask the server what happened (a full provider, a login problem...) - the video element only reports "network error"
      fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'same-origin' }).then(function (r) {
        if (gen !== self.gen) return;
        if (r.ok) {
          if (code === 4) { self.setStatus("This browser can't play this file (" + (c.ext || 'mp4') + "; mkv, HEVC and AC-3 audio are common problems)", true); return; }
          self.retryVod(gen, 'Playback error');
          return;
        }
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (gen !== self.gen) return;
          if (r.status === 401) { sessionCheck(); return; }
          if (r.status === 503) { self.setStatus('No free provider connection - stop a channel and retry', true); self.retryVod(gen, null, 8000); return; }
          self.setStatus((j && j.message) || ('Server answered ' + r.status), true);
        });
      }).catch(function () { self.retryVod(gen, 'Connection problem'); });
    };
    v.src = url;
    var pr;
    try { pr = v.play(); } catch (e) { pr = null; }
    if (pr && pr.catch) pr.catch(noop);
    applyAudio();
  };

  Tile.prototype.retryVod = function (gen, msg, delay) {
    var self = this;
    this.retry++;
    if (this.retry > 5) { this.setStatus((msg || 'Playback failed') + ' - use the tile menu to reload', true); return; }
    delay = delay || BACKOFF[clamp(this.retry - 1, 0, BACKOFF.length - 1)];
    if (msg) this.setStatus(msg + ' - retrying in ' + Math.round(delay / 1000) + 's', true);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(function () { if (gen === self.gen) self.start(); }, delay);
  };

  Tile.prototype.stop = function () {
    var v0 = this.video;
    if (this.phase === 'vod' && v0.currentTime > 1) { this.resumeKey = this.vodKey; this.resumeAt = v0.currentTime; }
    v0.controls = false;
    v0.onplaying = v0.onwaiting = v0.oncanplay = v0.onerror = v0.onloadedmetadata = null;
    clearInterval(this.tickTimer);
    clearTimeout(this.retryTimer);
    this.gen++;
    var p = this.player;
    this.player = null;
    this.phase = 'idle';
    if (p) {
      try { p.pause(); p.unload(); p.detachMediaElement(); p.destroy(); } catch (e) { /* already gone */ }
    }
    try { this.video.removeAttribute('src'); this.video.load(); } catch (e) { /* ignore */ }
  };

  // A WebSocket that closes before any video gives the page no reason; ask the server why.
  Tile.prototype.onError = function (type, detail, info) {
    if (this.viaWs && !this.hasPlayed && type !== 'MediaError' && !(info && (info._diag || info.code >= 100))) {
      var self = this;
      var c = this.cfg;
      var gen = this.gen;
      this.stop();
      this.setStatus('Connecting...');
      api('/api/stream-error?p=' + encodeURIComponent(c.p) + '&sid=' + encodeURIComponent(c.sid)).then(function (r) {
        if (self.gen !== gen + 1) return;
        if (r && r.error) {
          var code = r.error === 'provider_limit' ? 503 : r.error === 'user_limit' ? 429 : r.error === 'not_allowed' ? 403 : r.error === 'login_required' ? 401 : r.error === 'bad_channel' ? 404 : 502;
          self.onError('NetworkError', 'HttpStatusCodeInvalid', { code: code, _diag: true });
          return;
        }
        if (!wsWorked && ++wsFails >= 2) {
          wsBlocked = true;
          banner('WebSocket streaming is blocked here; switched to plain HTTP (about 6 streams at once)', 6000);
          self.retry = 0;
          self.start();
          return;
        }
        self.onError(type, detail, { code: info && info.code, _diag: true });
      }).catch(function (e) {
        if (e && e.status === 401) { sessionCheck(); return; }
        self.onError(type, detail, { code: info && info.code, _diag: true });
      });
      return;
    }
    var code = info && info.code;
    var msg;
    var delay;
    var fatal = false;
    this.retry++;
    var backoff = BACKOFF[clamp(this.retry - 1, 0, BACKOFF.length - 1)];
    if (type === 'MediaError') {
      this.mediaErrors++;
      if (detail === 'CodecUnsupported' || detail === 'FormatUnsupported' || this.mediaErrors >= 3) {
        msg = "This browser can't play this channel's video/audio format (HEVC or AC-3/MP2 audio are common culprits)";
        fatal = true;
      } else { msg = 'Video decoder error'; delay = backoff; }
    }
    else if (code === 401) { this.stop(); this.setStatus('Signed out - checking your login...', true); sessionCheck(); return; }
    else if (code === 403) { msg = 'This channel is no longer shared with you'; fatal = true; }
    else if (code === 429) { msg = "Your account's stream limit is reached"; delay = 8000; }
    else if (code === 503) { msg = 'No free provider connection'; delay = 8000; }
    else if (code === 404) { msg = 'Channel not found at the provider'; fatal = true; }
    else if (code === 502 || code === 504) { msg = 'Provider problem'; delay = backoff; }
    else if (type === 'ended') { msg = 'Stream ended'; delay = Math.min(backoff, 2000); }
    else if (type === 'timeout') { msg = 'No data'; delay = backoff; }
    else if (type === 'stalled') { msg = 'Stream froze'; delay = Math.min(backoff, 2000); }
    else { msg = 'Stream error' + (detail ? ' (' + detail + ')' : ''); delay = backoff; }
    this.stop();
    var self = this;
    if (fatal) { this.setStatus(msg + (isAdmin() ? ' - use the tile menu to change channel' : ''), true); return; }
    this.setStatus(msg + ' - retrying in ' + Math.round(delay / 1000) + 's', true);
    this.retryTimer = setTimeout(function () { self.start(); }, delay);
  };

  Tile.prototype.beginPlay = function () {
    this.phase = 'playing';
    this.playingSince = Date.now();
    this.setStatus('');
    var pr;
    try { pr = this.video.play(); } catch (e) { pr = null; }
    if (pr && pr.catch) pr.catch(noop);
  };

  // Cushion manager: wait for `bufSec` of video before playing, and re-fill after a stall.
  Tile.prototype.tick = function () {
    var v = this.video;
    if (!this.player || this.zoomPaused) return;
    var now = Date.now();
    var ahead = this.ahead();
    var buf = S.bufSec;
    if (this.phase === 'prebuffer') {
      var need = buf > 0 ? buf * 0.8 : 0;
      var waited = now - this.phaseAt;
      if (ahead > 0.05 && (ahead >= need || waited > (buf * 1.5 + 8) * 1000)) this.beginPlay();
      else if (waited > 25000 && ahead <= 0.05) this.onError('timeout');
      else this.setStatus(ahead > 0.05 && buf > 0 ? 'Buffering ' + fmtSec(ahead, need) + ' / ' + fmtSec(need, need) + ' s' : 'Connecting...');
    } else if (this.phase === 'playing') {
      if (v.paused && !v.ended && now - this.playingSince > 1000) { try { var pr = v.play(); if (pr && pr.catch) pr.catch(noop); } catch (e) { /* ignore */ } }
      if (buf > 0 && this.hasPlayed && ahead < 0.15 && !v.paused) {
        v.pause();
        this.phase = 'rebuffer';
        this.phaseAt = now;
        this.setStatus('Buffering...');
      } else if (ahead > Math.max(S.keepSec || 0, buf) + 8) {
        var b = v.buffered;
        if (b.length) v.currentTime = Math.max(b.start(b.length - 1), b.end(b.length - 1) - Math.max(buf, 1)); // drifted behind live: catch up
      } else if (this.hasPlayed && now - this.lastTime > 12000 && !v.paused) {
        this.onError('stalled');
        return;
      }
      if ((this.retry || this.mediaErrors) && now - this.playingSince > 20000) { this.retry = 0; this.mediaErrors = 0; }
    } else if (this.phase === 'rebuffer') {
      var need2 = Math.min(Math.max(buf, 1), buf > 15 ? 15 : 3);
      var w2 = now - this.phaseAt;
      if (ahead >= need2 || (w2 > 8000 + need2 * 1000 && ahead > 0.3)) this.beginPlay();
      else if (w2 > 30000 && ahead <= 0.3) this.onError('timeout');
      else if (need2 > 3) this.setStatus('Buffering ' + fmtSec(ahead, need2) + ' / ' + fmtSec(need2, need2) + ' s');
    }
    if (document.body.classList.contains('stats')) {
      var q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      this.stats.textContent = (v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : '--') + '  buffer ' + ahead.toFixed(1) + 's' + (q ? '  dropped ' + q.droppedVideoFrames : '') + (this.txUsed ? '  480p tx' : this.sdUsed ? '  SD' : '') + '  ' + this.phase;
    }
  };

  Tile.prototype.setZoomPaused = function (p) {
    if (p === this.zoomPaused) return;
    this.zoomPaused = p;
    if (p) { try { this.video.pause(); } catch (e) { /* ignore */ } }
    else if (this.player) { this.phase = 'rebuffer'; this.phaseAt = Date.now(); }
    else if (this.phase === 'vod') { try { var pr = this.video.play(); if (pr && pr.catch) pr.catch(noop); } catch (e) { /* ignore */ } }
  };


  // ---------------------------------------------------------------- shared screen
  // For weak devices: the server combines the visible tiles into ONE video stream and this page only plays that.
  // The tiles stay on screen (transparent) so selection, names, the sound marker and menus work as usual.
  var shared = { player: null, gen: 0, sig: '', spec: null, timer: null, retry: 0, failed: false, lastTime: -1, lastAt: 0, video: null };
  function sharedOn() { return !!S.shared && !shared.failed; }

  function sharedSpec() {
    var L = layout();
    var cells = [];
    var audio = -1;
    function add(i, x, y, w, h, small) {
      var c = S.tiles[i];
      if (!c || c.vod) return;
      var sd = c.q === 'sd' ? true : (c.q === 'full' || c.q === '480') ? false : (!!S.smallSd && small);
      if (i === S.sel) audio = cells.length;
      cells.push({ x: x, y: y, w: w, h: h, p: c.p, sid: c.sid, sd: sd });
    }
    var cols = L.cols;
    var rows = L.rows;
    if (zoom >= 0 && zoom < L.cells.length) { cols = 1; rows = 1; add(zoom, 1, 1, 1, 1, false); }
    else L.cells.forEach(function (c, i) { add(i, c[0], c[1], c[2], c[3], L.cells.length > 1 && (c[2] * c[3]) / (L.cols * L.rows) <= 1 / 6); });
    return cells.length ? { res: Number(S.shared) || 720, cols: cols, rows: rows, cells: cells, audio: audio } : null;
  }

  function sharedStopPlayer() {
    shared.gen++;
    var p = shared.player;
    shared.player = null;
    if (p) { try { p.pause(); p.unload(); p.detachMediaElement(); p.destroy(); } catch (e) { /* gone */ } }
    if (shared.video) { try { shared.video.removeAttribute('src'); shared.video.load(); } catch (e) { /* ignore */ } }
  }

  function sharedFallback(msg) {
    shared.failed = true;
    sharedStopPlayer();
    banner('Shared screen unavailable: ' + msg + ' - showing the tiles directly', 9000);
    sharedApply();
  }

  // switch every tile between "own stream" and "part of the shared picture"
  function sharedApply() {
    document.body.classList.toggle('shared', sharedOn());
    tiles.forEach(function (t) { t.render(); if (t.cfg && t.visible) t.start(); });
    applyAudio();
  }

  function sharedBegin(spec, sig) {
    sharedStopPlayer();
    shared.sig = sig;
    shared.spec = spec;
    var gen = shared.gen;
    if (!spec) return;
    var mp = window.mpegts;
    if (!mp || !mp.getFeatureList || !mp.getFeatureList().mseLivePlayback) { sharedFallback('this browser cannot play live MPEG-TS'); return; }
    api('/api/compose', { method: 'POST', body: spec }).then(function (r) {
      if (gen !== shared.gen) return;
      var useWs = S.transport !== 'http' && !wsBlocked && typeof WebSocket !== 'undefined';
      var url = useWs ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + r.ws : location.origin + r.stream;
      var player;
      try {
        player = mp.createPlayer({ type: 'mpegts', isLive: true, url: url }, { enableWorker: !!S.workers, enableStashBuffer: true, liveBufferLatencyChasing: false, autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 20, autoCleanupMinBackwardDuration: 10, fixAudioTimestampGap: true });
      } catch (e) { sharedFallback(e.message); return; }
      function again(why) { if (gen === shared.gen) sharedRetry(why); }
      player.on(mp.Events.ERROR, function () { again('Connection lost'); });
      player.on(mp.Events.LOADING_COMPLETE, function () { again('Stream ended'); });
      player.attachMediaElement(shared.video);
      player.load();
      shared.player = player;
      shared.lastAt = Date.now();
      shared.lastTime = -1;
      applyAudio();
      var pr = shared.video.play();
      if (pr && pr.catch) pr.catch(noop);
    }, function (e) {
      if (gen !== shared.gen) return;
      if (e.status && e.status !== 502 && e.status !== 504) { sharedFallback(e.message); return; }
      sharedRetry(e.message);
    });
  }

  function sharedRetry(why) {
    if (!sharedOn()) return;
    shared.retry++;
    if (shared.retry > 6) { sharedFallback(why || 'it keeps failing'); return; }
    var spec = shared.spec;
    var sig = shared.sig;
    sharedStopPlayer();
    clearTimeout(shared.timer);
    shared.timer = setTimeout(function () { if (sharedOn() && shared.sig === sig) sharedBegin(spec, sig); }, BACKOFF[clamp(shared.retry - 1, 0, BACKOFF.length - 1)]);
  }

  // called after anything that changes the picture; restarts the shared stream only when its description changed
  function sharedSync() {
    if (sharedOn()) sharedEnsureVideo();
    if (!sharedOn()) { if (shared.sig || shared.player) { clearTimeout(shared.timer); sharedStopPlayer(); shared.sig = ''; } return; }
    var spec = sharedSpec();
    var sig = spec ? JSON.stringify(spec) : '';
    if (sig === shared.sig) return;
    shared.sig = sig; // claimed now so repeated calls during the delay below do nothing
    clearTimeout(shared.timer);
    shared.timer = setTimeout(function () { shared.retry = 0; sharedBegin(spec, sig); }, 500);
  }

  // the page only gets a shared <video> once the mode is switched on
  function sharedEnsureVideo() {
    if (shared.video) return;
    shared.video = h('video', { id: 'shared', playsinline: true, muted: true, preload: 'auto' });
    shared.video.muted = true;
    shared.video.setAttribute('disablepictureinpicture', '');
    shared.video.addEventListener('playing', function () { shared.retry = 0; });
    document.body.insertBefore(shared.video, $('#grid'));
  }

  function sharedInit() {
    // a picture that stops moving is restarted
    setInterval(function () {
      if (!sharedOn() || !shared.player || document.hidden) return;
      var t = shared.video.currentTime;
      if (t !== shared.lastTime) { shared.lastTime = t; shared.lastAt = Date.now(); return; }
      if (Date.now() - shared.lastAt > 15000) { shared.lastAt = Date.now(); sharedRetry('The picture stopped'); }
    }, 3000);
    document.body.classList.toggle('shared', sharedOn());
  }

  // ---------------------------------------------------------------- grid, selection, audio
  function renderGrid() {
    var grid = $('#grid');
    var L = layout();
    var n = L.cells.length;
    var z = zoom >= 0 && zoom < n ? zoom : -1;
    zoom = z;
    grid.style.gridTemplateColumns = 'repeat(' + (z >= 0 ? 1 : L.cols) + ', 1fr)';
    grid.style.gridTemplateRows = 'repeat(' + (z >= 0 ? 1 : L.rows) + ', 1fr)';
    tiles.forEach(function (t, i) {
      if (i < n) {
        var c = L.cells[i];
        var hidden = z >= 0 && i !== z;
        t.el.style.gridColumn = z >= 0 ? '1 / span 1' : c[0] + ' / span ' + c[2];
        t.el.style.gridRow = z >= 0 ? '1 / span 1' : c[1] + ' / span ' + c[3];
        t.el.style.display = hidden ? 'none' : '';
        if (!t.el.parentNode) grid.appendChild(t.el);
        t.setVisible(true);
        t.setZoomPaused(hidden);
      } else {
        t.setVisible(false);
        if (t.el.parentNode) t.el.parentNode.removeChild(t.el);
      }
    });
    document.body.classList.toggle('single', n < 2 || z >= 0);
    tiles.forEach(function (t, i) { if (i < n && !(z >= 0 && i !== z)) t.applyQuality(); });
    updateSelection();
    updateLayoutButtons();
  }

  function updateSelection() {
    tiles.forEach(function (t, i) { t.el.classList.toggle('sel', i === S.sel); });
    applyAudio();
  }

  function audioIdx() { return S.muted ? -1 : S.sel; }
  function applyAudio() {
    var a = audioIdx();
    tiles.forEach(function (t, i) {
      var on = i === a && t.cfg;
      t.video.muted = !(userActive && on);
      t.el.classList.toggle('audio', !!on);
    });
    if (shared.video) shared.video.muted = !(userActive && !S.muted && sharedOn());
    sharedSync();
    var b = $('#btn-audio');
    b.textContent = S.muted ? 'Muted' : 'Sound on';
    b.classList.toggle('on', !S.muted);
    b.setAttribute('aria-pressed', S.muted ? 'false' : 'true');
    updateHint();
  }

  function updateHint() {
    var anyTile = S.tiles.some(function (t, i) { return t && i < visibleCount(); });
    if (modals.length) { hint(''); return; }
    if (!isAdmin()) { hint(anyTile && !userActive && !S.muted ? 'Press any key or click once to enable sound' : ''); return; }
    if (!serverState.providers.length && providersLoaded) hint('');
    else if (!anyTile && providersLoaded) hint('Select a tile and press OK / Enter to add a channel');
    else if (anyTile && !userActive && !S.muted) hint('Press any key or click once to enable sound');
    else hint('');
  }

  function select(idx, fromFocus) {
    idx = clamp(idx, 0, visibleCount() - 1);
    S.sel = idx;
    updateSelection();
    saveSoon();
    if (!fromFocus && document.activeElement !== tiles[idx].el && !modals.length) tiles[idx].el.focus();
  }

  function tileClick(t) {
    userGesture();
    if (S.sel !== t.idx) { select(t.idx); return; }
    if (!t.cfg && !isAdmin()) return;
    if (!t.cfg) { openPicker(t.idx); return; }
    if (t.touch) openTileMenu(t.idx); // second tap on the selected tile opens its menu
  }

  function assign(idx, cfg) {
    S.tiles[idx] = cfg;
    tiles[idx].setCfg(cfg);
    saveSoon();
    updateHint();
    sharedSync();
    setTimeout(pollEpg, 1500);
  }

  function swapWithMain(idx) {
    if (idx === 0) return;
    var a = S.tiles[0];
    S.tiles[0] = S.tiles[idx];
    S.tiles[idx] = a;
    tiles[0].setCfg(S.tiles[0]);
    tiles[idx].setCfg(S.tiles[idx]);
    saveSoon();
    select(0);
  }

  function toggleZoom(idx) {
    zoom = zoom === idx ? -1 : idx;
    renderGrid();
    if (zoom >= 0) select(idx);
  }

  function setLayout(key) {
    if (!LAYOUTS[key]) return;
    S.layout = key;
    if (S.sel >= visibleCount()) S.sel = 0;
    zoom = -1;
    renderGrid();
    saveSoon();
    refreshState();
  }

  function cycleLayout() {
    var i = LAYOUT_ORDER.indexOf(S.layout);
    setLayout(LAYOUT_ORDER[(i + 1) % LAYOUT_ORDER.length]);
  }

  function neighbor(from, key) {
    var cells = layout().cells;
    var a = cells[from];
    var best = -1;
    var bestScore = Infinity;
    for (var i = 0; i < cells.length; i++) {
      if (i === from) continue;
      var b = cells[i];
      var ok;
      var primary;
      var secondary;
      var dx = (b[0] + b[2] / 2) - (a[0] + a[2] / 2);
      var dy = (b[1] + b[3] / 2) - (a[1] + a[3] / 2);
      if (key === 'ArrowRight') { ok = b[0] >= a[0] + a[2]; primary = b[0] - (a[0] + a[2]); secondary = Math.abs(dy); }
      else if (key === 'ArrowLeft') { ok = b[0] + b[2] <= a[0]; primary = a[0] - (b[0] + b[2]); secondary = Math.abs(dy); }
      else if (key === 'ArrowDown') { ok = b[1] >= a[1] + a[3]; primary = b[1] - (a[1] + a[3]); secondary = Math.abs(dx); }
      else { ok = b[1] + b[3] <= a[1]; primary = a[1] - (b[1] + b[3]); secondary = Math.abs(dx); }
      if (!ok) continue;
      var score = primary * 10 + secondary;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  // ---------------------------------------------------------------- toolbar
  var toolbarTimer = null;
  function toolbarWake() {
    var tb = $('#toolbar');
    tb.classList.remove('hide');
    document.body.classList.remove('idle');
    clearTimeout(toolbarTimer);
    toolbarTimer = setTimeout(function () {
      if (modals.length || tb.contains(document.activeElement)) { toolbarWake(); return; }
      tb.classList.add('hide');
      document.body.classList.add('idle');
    }, 5000);
  }

  function layoutIcon(key) {
    var L = LAYOUTS[key];
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + L.cols * 10 + ' ' + L.rows * 10);
    svg.setAttribute('preserveAspectRatio', 'none');
    L.cells.forEach(function (c, i) {
      var r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', (c[0] - 1) * 10 + 0.9);
      r.setAttribute('y', (c[1] - 1) * 10 + 0.9);
      r.setAttribute('width', c[2] * 10 - 1.8);
      r.setAttribute('height', c[3] * 10 - 1.8);
      if (i === 0 && (c[2] > 1 || c[3] > 1)) r.setAttribute('class', 'big');
      svg.appendChild(r);
    });
    return svg;
  }

  function buildToolbar() {
    var box = $('#layouts');
    LAYOUT_ORDER.forEach(function (key) {
      var L = LAYOUTS[key];
      var b = h('button', { class: 'btn layout', type: 'button', 'data-layout': key, title: L.name + ' (' + L.cells.length + ' stream' + (L.cells.length > 1 ? 's' : '') + ')', 'aria-label': L.name }, layoutIcon(key));
      b.addEventListener('click', function () { setLayout(key); });
      box.appendChild(b);
    });
    $('#btn-audio').addEventListener('click', toggleMute);
    $('#btn-conn').addEventListener('click', function () { openProviders(); });
    $('#btn-settings').addEventListener('click', function () { openSettings(); });
    $('#btn-full').addEventListener('click', toggleFullscreen);
    $('#btn-views').addEventListener('click', function () { openViews(); });
    $('#btn-acct').addEventListener('click', function () { openAccount(); });
  }

  function updateLayoutButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('#layouts .btn'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-layout') === S.layout);
    });
  }

  function toggleMute() {
    userGesture();
    S.muted = !S.muted;
    applyAudio();
    saveSoon();
  }

  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement; }
  function toggleFullscreen() {
    var el = document.documentElement;
    try {
      if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    } catch (e) { banner('Fullscreen is not available in this browser', 3000); }
  }
  function onFullscreenChange() { $('#btn-full').textContent = fsElement() ? 'Exit fullscreen' : 'Fullscreen'; }

  // ---------------------------------------------------------------- server state
  var providersLoaded = false;
  var pollTimer = null;
  function refreshState() {
    if (!isAdmin()) return Promise.resolve(null);
    return api('/api/state').then(function (s) {
      serverState = s;
      providersLoaded = true;
      var used = 0;
      var max = 0;
      s.providers.forEach(function (p) { if (p.enabled && !p.local) { used += p.active; max += p.max; } });
      var b = $('#btn-conn');
      if (!s.providers.length) { b.textContent = 'Add provider'; b.classList.add('warn'); }
      else { b.textContent = 'Providers ' + used + '/' + max; b.classList.toggle('warn', used >= max); }
      b.title = s.providers.map(function (p) { return p.name + ': ' + p.active + '/' + p.max + ' connections'; }).join('\n');
      banner('');
      updateHint();
      return s;
    }).catch(function (e) {
      if (e.status === 401) return null;
      banner('Cannot reach the server: ' + e.message);
      return null;
    });
  }

  // ---------------------------------------------------------------- what's on now
  function pollEpg() {
    if (!S.epgOn || document.hidden || !ME) return;
    var by = {};
    tiles.forEach(function (t) { var c = t.cfg; if (c && !c.vod && t.visible) { by[c.p] = by[c.p] || {}; by[c.p][c.sid] = true; } });
    var now = Math.floor(Date.now() / 1000);
    Object.keys(by).forEach(function (pid) {
      api('/api/epg?provider=' + enc(pid) + '&sids=' + enc(Object.keys(by[pid]).join(',')) + '&from=' + (now - 60) + '&to=' + (now + 3600)).then(function (r) {
        tiles.forEach(function (t) {
          var c = t.cfg;
          if (!c || c.vod || c.p !== pid) return;
          var list = (r.programmes && r.programmes[c.sid]) || [];
          var cur = null;
          for (var i = 0; i < list.length; i++) if (list[i][0] <= now && now < list[i][1]) cur = list[i];
          t.now = cur ? cur[2] : null;
          t.render();
        });
      }).catch(noop);
    });
  }
  setInterval(pollEpg, 90000);

  // ---------------------------------------------------------------- tile menu
  function openTileMenu(idx) {
    var t = tiles[idx];
    var c = t.cfg;
    var fk = c ? c.p + ':' + c.sid : '';
    var items = [];
    function act(label, fn, cls) { items.push(h('button', { class: 'btn' + (cls ? ' ' + cls : ''), type: 'button', text: label, onclick: function () { m.close(); fn(); } })); }
    if (isAdmin()) act(c ? 'Change channel...' : 'Add channel...', function () { openPicker(idx); });
    if (c) {
      act(S.muted ? 'Unmute' : 'Mute', toggleMute);
      if (idx !== 0 && isAdmin()) act('Make main (swap with tile 1)', function () { swapWithMain(idx); });
      act(zoom === idx ? 'Back to grid' : 'Zoom this tile', function () { toggleZoom(idx); });
      if (c.vod) {
        act(t.video.paused ? 'Play' : 'Pause', function () { if (t.video.paused) { var pr = t.video.play(); if (pr && pr.catch) pr.catch(noop); } else t.video.pause(); });
        act('Back 30 seconds', function () { try { t.video.currentTime = Math.max(0, t.video.currentTime - 30); } catch (e) { /* not seekable */ } });
        act('Forward 30 seconds', function () { try { t.video.currentTime = t.video.currentTime + 30; } catch (e) { /* not seekable */ } });
      }
      if (!c.vod) {
        var qn = { sd: 'SD when available', full: 'As chosen', '480': '480p transcode (server GPU)' }[c.q] || 'Auto (small tiles use SD)';
        act('Quality: ' + qn + ' - change', function () {
          var next = { '': 'sd', sd: 'full', full: '480', '480': '' }[c.q || ''];
          if (next) c.q = next; else delete c.q;
          saveSoon();
          if (c.q === '480' || t.txUsed) t.start(); else t.applyQuality();
          sharedSync();
        });
      }
      act('Reload stream', function () { t.reload(); });
      if (isAdmin() && !c.vod) act(S.favs[fk] ? 'Remove from favorites' : 'Add to favorites', function () { toggleFav(c); });
      if (isAdmin()) act('Remove channel', function () { assign(idx, null); }, 'danger');
    }
    var m = openModal({
      title: 'Tile ' + (idx + 1) + (c ? ' - ' + (c.name || c.sid) : ''),
      body: h('div', { class: 'menu' }, items),
      foot: h('button', { class: 'btn', type: 'button', text: 'Close', onclick: function () { m.close(); } })
    });
  }

  // ---------------------------------------------------------------- favorites + channel lists
  function favKey(c) { return c.p + ':' + c.sid; }
  function toggleFav(c) {
    var k = favKey(c);
    if (S.favs[k]) delete S.favs[k];
    else S.favs[k] = { p: c.p, sid: String(c.sid), name: c.name || '', icon: c.icon || '' };
    saveSoon();
  }

  function loadChannels(pid, refresh) {
    if (chanCache[pid] && !refresh) return Promise.resolve(chanCache[pid]);
    return api('/api/channels?provider=' + encodeURIComponent(pid) + (refresh ? '&refresh=1' : '')).then(function (r) {
      var cats = {};
      r.categories.forEach(function (c) { cats[c.id] = c.name; });
      // Category per channel by name. If the provider's own list is empty or does not match, fall back to the
      // "US| " style prefix in the channel name, so there are always categories to filter by.
      var extra = {};
      var list = r.channels.map(function (ch) {
        var cn = cats[ch.c];
        if (!cn) {
          var mm = /^\s*([^|:]{2,14}?)\s*[|:]/.exec(ch.n);
          cn = mm ? mm[1].toUpperCase() : 'Other';
          extra[cn] = true;
        }
        return { i: ch.i, n: ch.n, ln: ch.n.toLowerCase(), c: ch.c, cn: cn, l: ch.l };
      });
      var names = [];
      var seen = {};
      r.categories.forEach(function (c) { if (c.name && !seen[c.name]) { seen[c.name] = true; names.push(c.name); } });
      Object.keys(extra).sort().forEach(function (n) { if (!seen[n]) { seen[n] = true; names.push(n); } });
      chanCache[pid] = { cats: r.categories, catName: cats, catNames: names, list: list };
      return chanCache[pid];
    });
  }

  function getProviders() {
    if (providersCache) return Promise.resolve(providersCache);
    return api('/api/providers').then(function (r) { providersCache = r.providers; return providersCache; });
  }

  // ---------------------------------------------------------------- channel picker
  // Everything the picker shows (provider, tab, category, search, favorites, rows expanded, scroll position and the
  // channel chosen last) lives in S.pk, so it opens again exactly where it was left.
  var PK_DEFAULT = { prov: '', tab: 'live', cat: '', q: '', favs: false, limit: 100, scroll: 0, last: '' };
  function pkState() {
    var p = S.pk && typeof S.pk === 'object' ? S.pk : {};
    Object.keys(PK_DEFAULT).forEach(function (k) { if (typeof p[k] !== typeof PK_DEFAULT[k]) p[k] = PK_DEFAULT[k]; });
    if (['live', 'guide', 'movie', 'series'].indexOf(p.tab) < 0) p.tab = 'live';
    p.limit = clamp(Math.floor(p.limit) || 100, 20, 5000);
    S.pk = p;
    return p;
  }
  var vodCache = {};   // provider:kind -> { catNames, list }
  function clearListCaches() { chanCache = {}; vodCache = {}; }
  function enc(s) { return encodeURIComponent(s); }

  function loadVod(pid, kind, refresh) {
    var key = pid + ':' + kind;
    if (vodCache[key] && !refresh) return Promise.resolve(vodCache[key]);
    return api('/api/vod?provider=' + enc(pid) + '&kind=' + kind + (refresh ? '&refresh=1' : '')).then(function (r) {
      var cats = {};
      var names = [];
      var seen = {};
      r.categories.forEach(function (c) { cats[c.id] = c.name; if (c.name && !seen[c.name]) { seen[c.name] = true; names.push(c.name); } });
      var hasOther = false;
      var list = r.items.map(function (it) {
        var cn = cats[it.c];
        if (!cn) { cn = 'Other'; hasOther = true; }
        return { i: it.i, n: it.n, ln: it.n.toLowerCase(), cn: cn, l: it.l, x: it.x };
      });
      if (hasOther) names.push('Other');
      vodCache[key] = { catNames: names, list: list };
      return vodCache[key];
    });
  }

  function fmtClock(ts) {
    try { return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }

  function openPicker(slot) {
    var pk = pkState();
    var provs = [];
    var provSel = h('select', { 'aria-label': 'Provider' });
    var catSel = h('select', { 'aria-label': 'Category' });
    var search = h('input', { type: 'text', class: 'search', placeholder: 'Search channels', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    var favBtn = h('button', { class: 'btn', type: 'button', text: 'Favorites' });
    var refBtn = h('button', { class: 'btn', type: 'button', text: 'Refresh' });
    var resetBtn = h('button', { class: 'btn', type: 'button', text: 'Reset filters', title: 'Forget the remembered provider, category, search and position' });
    var tabs = {};
    var tabBar = h('div', { class: 'tabs', role: 'tablist' });
    [['live', 'Live'], ['guide', 'Guide'], ['movie', 'Movies'], ['series', 'Series']].forEach(function (t) {
      tabs[t[0]] = h('button', { class: 'btn tab', type: 'button', role: 'tab', text: t[1], onclick: function () { setTab(t[0]); } });
      tabBar.appendChild(tabs[t[0]]);
    });
    var info = h('div', { class: 'note' });
    var listEl = h('div', { class: 'chlist' });
    var loading = 0;
    var errors = {};
    var m;
    var restore = pk.scroll > 0 || !!pk.last;   // scroll back to the remembered spot once the list is on screen
    var gstart = 0;                              // guide window start (unix seconds)
    var gtoken = 0;
    var gcache = {};                             // provider:sid:gstart -> programmes
    var searchToken = 0;

    function isVod() { return pk.tab === 'movie' || pk.tab === 'series'; }
    function usable(p) { return p.type !== 'local'; }
    function selectedProviders() {
      var list = pk.prov ? provs.filter(function (p) { return p.id === pk.prov; }) : provs.filter(function (p) { return p.enabled; });
      return pk.tab === 'live' ? list : list.filter(usable);
    }
    function remember() { if (m) pk.scroll = m.body.scrollTop; saveSoon(); }

    function tabCats() {
      var seen = {};
      var out = [];
      selectedProviders().forEach(function (p) {
        var c = isVod() ? vodCache[p.id + ':' + pk.tab] : chanCache[p.id];
        if (!c) return;
        c.catNames.forEach(function (n) { if (!seen[n]) { seen[n] = true; out.push(n); } });
      });
      return out;
    }
    function fillCats() {
      catSel.textContent = '';
      catSel.appendChild(h('option', { value: '', text: 'All categories' }));
      var names = tabCats();
      names.forEach(function (n) { catSel.appendChild(h('option', { value: n, text: n })); });
      // while the lists are still loading keep the remembered category instead of forgetting it
      if (loading && pk.cat && names.indexOf(pk.cat) < 0) catSel.appendChild(h('option', { value: pk.cat, text: pk.cat }));
      catSel.disabled = !names.length && !loading;
      catSel.value = pk.cat;
      if (catSel.value !== pk.cat) { pk.cat = ''; catSel.value = ''; }
    }

    function syncControls() {
      Object.keys(tabs).forEach(function (k) {
        tabs[k].classList.toggle('on', k === pk.tab);
        tabs[k].setAttribute('aria-selected', k === pk.tab ? 'true' : 'false');
      });
      var vodOk = provs.some(function (p) { return p.enabled && usable(p); });
      tabs.movie.hidden = !vodOk;
      tabs.series.hidden = !vodOk;
      search.placeholder = pk.tab === 'guide' ? 'Search programmes (e.g. Champions League) or channels' : pk.tab === 'movie' ? 'Search movies' : pk.tab === 'series' ? 'Search series' : 'Search channels';
      favBtn.hidden = isVod();
      favBtn.classList.toggle('on', pk.favs && !isVod());
      search.value = pk.q;
      provSel.value = pk.prov;
      if (provSel.value !== pk.prov) { pk.prov = ''; provSel.value = ''; }
    }

    // the movies and series lists belong to one provider
    function needVodProvider() {
      if (!isVod() || pk.prov) return;
      var first = provs.filter(function (p) { return p.enabled && usable(p); })[0];
      if (first) { pk.prov = first.id; provSel.value = first.id; }
    }

    function load(refresh) {
      needVodProvider();
      selectedProviders().forEach(function (p) {
        var have = isVod() ? vodCache[p.id + ':' + pk.tab] : chanCache[p.id];
        if (have && !refresh) return;
        loading++;
        delete errors[p.id];
        (isVod() ? loadVod(p.id, pk.tab, refresh) : loadChannels(p.id, refresh)).catch(function (e) { errors[p.id] = e.message; }).then(function () { loading--; fillCats(); render(); });
      });
      fillCats();
      render();
    }

    function toks() { return pk.q.toLowerCase().split(/\s+/).filter(Boolean); }
    function okName(ln, t) { for (var i = 0; i < t.length; i++) if (ln.indexOf(t[i]) < 0) return false; return true; }

    function matches() {
      var t = toks();
      var out = [];
      if (isVod()) {
        selectedProviders().forEach(function (p) {
          var c = vodCache[p.id + ':' + pk.tab];
          if (!c) return;
          for (var i = 0; i < c.list.length && out.length < 5000; i++) {
            var it = c.list[i];
            if (pk.cat && it.cn !== pk.cat) continue;
            if (t.length && !okName(it.ln, t)) continue;
            out.push({ p: p.id, id: it.i, sid: pk.tab + ':' + it.i, name: it.n, icon: it.l, vod: pk.tab, ext: it.x });
          }
        });
      } else if (pk.favs) {
        Object.keys(S.favs).forEach(function (k) {
          var f = S.favs[k];
          if (pk.prov && f.p !== pk.prov) return;
          if (okName((f.name || '').toLowerCase(), t)) out.push({ p: f.p, sid: f.sid, name: f.name, icon: f.icon });
        });
      } else {
        selectedProviders().forEach(function (p) {
          var c = chanCache[p.id];
          if (!c) return;
          for (var i = 0; i < c.list.length && out.length < 3000; i++) {
            var ch = c.list[i];
            if (pk.cat && ch.cn !== pk.cat) continue;
            if (t.length && !okName(ch.ln, t)) continue;
            out.push({ p: p.id, sid: ch.i, name: ch.n, icon: ch.l });
          }
        });
      }
      if (pk.q) out.sort(function (a, b) { return a.name.localeCompare(b.name); });
      return out;
    }

    function provName(id) { for (var i = 0; i < provs.length; i++) if (provs[i].id === id) return provs[i].name; return id; }
    function errText() { return Object.keys(errors).map(function (id) { return provName(id) + ': ' + errors[id]; }).join(' | '); }
    function imgOrBlank(src) {
      return src ? h('img', { src: src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: function (e) { var im = e.target; var ph = h('span', { class: 'noimg' }); if (im.parentNode) im.parentNode.replaceChild(ph, im); } }) : h('span', { class: 'noimg' });
    }

    function afterRender() {
      if (!restore || loading) return;
      restore = false;
      var done = false;
      if (pk.last) {
        var els = listEl.querySelectorAll('[data-key]');
        for (var i = 0; i < els.length; i++) {
          if (els[i].getAttribute('data-key') === pk.last) {
            try { els[i].focus({ preventScroll: true }); } catch (e) { els[i].focus(); }
            els[i].scrollIntoView({ block: 'center' });
            done = true;
            break;
          }
        }
      }
      if (!done && pk.scroll) m.body.scrollTop = pk.scroll;
    }

    function render() {
      if (pk.tab === 'guide') return renderGuide();
      listEl.className = 'chlist';
      listEl.textContent = '';
      var res = matches();
      var nWord = pk.tab === 'movie' ? 'movie' : pk.tab === 'series' ? 'series' : 'channel';
      info.textContent = (loading ? 'Loading lists... ' : '') + (errText() ? errText() + ' ' : '') + (loading ? '' : res.length + ' ' + nWord + (res.length === 1 || nWord === 'series' ? '' : 's') + (res.length >= 3000 ? '+' : ''));
      if (isVod() && !selectedProviders().length) info.textContent = 'Choose a provider above to browse its ' + (pk.tab === 'movie' ? 'movies' : 'series') + '.';
      res.slice(0, pk.limit).forEach(function (r) {
        var key = r.p + ':' + r.sid;
        var pick = h('button', { class: 'pick', type: 'button', 'data-key': key, onclick: function () { choose(r); } },
          imgOrBlank(r.icon),
          h('span', { class: 'nm', text: r.name || ('Channel ' + r.sid) }),
          pk.tab === 'series' ? h('span', { class: 'chip', text: 'episodes' }) : null,
          provs.length > 1 && !pk.prov ? h('span', { class: 'chip', text: provName(r.p) }) : null);
        var row;
        if (isVod()) {
          row = h('div', { class: 'ch' }, pick);
        } else {
          var fav = !!S.favs[favKey(r)];
          var star = h('button', { class: 'star' + (fav ? ' on' : ''), type: 'button', title: 'Favorite', text: fav ? '★' : '☆', onclick: function () { toggleFav(r); var on = !!S.favs[favKey(r)]; star.classList.toggle('on', on); star.textContent = on ? '★' : '☆'; } });
          row = h('div', { class: 'ch' }, pick, star);
        }
        listEl.appendChild(row);
      });
      if (res.length > pk.limit) {
        listEl.appendChild(h('div', { class: 'more-row' }, h('button', { class: 'btn', type: 'button', text: 'Show more (' + (res.length - pk.limit) + ' left)', onclick: function () { pk.limit += 150; saveSoon(); render(); } })));
      }
      afterRender();
    }

    // ------------------------------------------------------------ guide
    var GSPAN = 3 * 3600;
    function guideStart() { return gstart || (gstart = Math.floor((Date.now() / 1000 - 900) / 1800) * 1800); }

    function renderGuide() {
      var token = ++gtoken;
      var q = pk.q.trim();
      if (q) return renderProgrammeSearch(token);
      listEl.className = 'guide';
      listEl.textContent = '';
      var res = matches().slice(0, Math.min(pk.limit, 300));
      var all = matches().length;
      info.textContent = (loading ? 'Loading lists... ' : '') + (errText() ? errText() + ' ' : '') + (loading ? '' : all + ' channels. Pick a channel or a programme to put it on the tile.');
      var start = guideStart();
      var nav = h('div', { class: 'gnav' },
        h('button', { class: 'btn', type: 'button', text: '◀ Earlier', onclick: function () { gstart = start - GSPAN / 2; render(); } }),
        h('button', { class: 'btn', type: 'button', text: 'Now', onclick: function () { gstart = 0; render(); } }),
        h('button', { class: 'btn', type: 'button', text: 'Later ▶', onclick: function () { gstart = start + GSPAN / 2; render(); } }));
      var ruler = h('div', { class: 'gruler' });
      for (var k = 0; k < 6; k++) ruler.appendChild(h('span', { style: 'left:' + (k * 100 / 6) + '%', text: fmtClock(start + k * 1800) }));
      listEl.appendChild(h('div', { class: 'grow ghead' }, nav, ruler));
      var rows = {};
      res.forEach(function (r) {
        var line = h('div', { class: 'gline' });
        var key = r.p + ':' + r.sid;
        var name = h('button', { class: 'gch', type: 'button', 'data-key': key, title: r.name, onclick: function () { choose(r); } }, imgOrBlank(r.icon), h('span', { text: r.name }));
        listEl.appendChild(h('div', { class: 'grow' }, name, line));
        rows[key] = { r: r, line: line };
      });
      var now = Date.now() / 1000;
      if (now >= start && now <= start + GSPAN) {
        listEl.appendChild(h('div', { class: 'gnow', style: 'left:calc(var(--gname) + (100% - var(--gname)) * ' + ((now - start) / GSPAN).toFixed(4) + ')' }));
      }
      if (res.length < all) listEl.appendChild(h('div', { class: 'more-row' }, h('button', { class: 'btn', type: 'button', text: 'Show more channels', onclick: function () { pk.limit += 100; saveSoon(); render(); } })));
      // fetch guide data in chunks per provider
      var byProv = {};
      Object.keys(rows).forEach(function (k) {
        var r = rows[k].r;
        (byProv[r.p] = byProv[r.p] || []).push(r.sid);
      });
      var pending = 0;
      var anyData = false;
      Object.keys(byProv).forEach(function (pid) {
        var sids = byProv[pid];
        for (var i = 0; i < sids.length; i += 60) {
          (function (chunk) {
            var need = chunk.filter(function (sid) { return !gcache[pid + ':' + sid + ':' + start]; });
            if (!need.length) { fillGuide(pid, chunk, start, rows, token); anyData = true; return; }
            pending++;
            api('/api/epg?provider=' + enc(pid) + '&sids=' + enc(need.join(',')) + '&from=' + start + '&to=' + (start + GSPAN) + '&desc=1').then(function (r) {
              need.forEach(function (sid) { gcache[pid + ':' + sid + ':' + start] = r.programmes[sid] || []; });
              if (r.available) anyData = true;
            }).catch(function () {
              need.forEach(function (sid) { gcache[pid + ':' + sid + ':' + start] = []; });
            }).then(function () {
              pending--;
              if (token !== gtoken) return;
              fillGuide(pid, chunk, start, rows, token);
              if (!pending && !anyData) info.textContent = 'No programme guide data from this provider. Channels are still listed; use Live.';
            });
          })(sids.slice(i, i + 60));
        }
      });
      afterRender();
    }

    function fillGuide(pid, sids, start, rows, token) {
      if (token !== gtoken) return;
      var now = Date.now() / 1000;
      sids.forEach(function (sid) {
        var row = rows[pid + ':' + sid];
        var progs = gcache[pid + ':' + sid + ':' + start] || [];
        if (!row) return;
        row.line.textContent = '';
        progs.forEach(function (pr) {
          var l = clamp((pr[0] - start) / GSPAN, 0, 1);
          var rgt = clamp((pr[1] - start) / GSPAN, 0, 1);
          if (rgt - l < 0.004) return;
          var isNow = pr[0] <= now && now < pr[1];
          row.line.appendChild(h('button', {
            class: 'prog' + (isNow ? ' now' : ''), type: 'button', 'data-key': pid + ':' + sid,
            style: 'left:' + (l * 100).toFixed(3) + '%;width:' + ((rgt - l) * 100).toFixed(3) + '%',
            title: pr[2] + '\n' + fmtClock(pr[0]) + ' - ' + fmtClock(pr[1]) + (pr[3] ? '\n' + pr[3] : ''),
            onclick: function () { choose(row.r); }
          }, h('span', { text: pr[2] })));
        });
      });
    }

    function renderProgrammeSearch(token) {
      var q = pk.q.trim();
      listEl.className = 'chlist';
      listEl.textContent = '';
      info.textContent = 'Searching programmes...';
      var targets = selectedProviders();
      var results = [];
      var left = targets.length;
      var anyAvail = false;
      if (!left) { info.textContent = 'No provider to search.'; return; }
      targets.forEach(function (p) {
        api('/api/epg-search?provider=' + enc(p.id) + '&q=' + enc(q)).then(function (r) {
          if (r.available) anyAvail = true;
          r.results.forEach(function (x) { results.push({ p: p.id, sid: x.sid, name: x.name, icon: x.icon, s: x.s, e: x.e, t: x.t }); });
        }).catch(function () { /* ignore one provider */ }).then(function () {
          if (--left || token !== gtoken) return;
          listEl.textContent = '';
          if (!anyAvail) {
            info.textContent = 'These providers have no programme guide file, so programmes cannot be searched. Showing channels whose name matches.';
            listEl.className = 'chlist';
            matches().slice(0, 100).forEach(function (r) {
              listEl.appendChild(h('div', { class: 'ch' }, h('button', { class: 'pick', type: 'button', 'data-key': r.p + ':' + r.sid, onclick: function () { choose(r); } }, imgOrBlank(r.icon), h('span', { class: 'nm', text: r.name }))));
            });
            return;
          }
          results.sort(function (a, b) { return a.s - b.s; });
          info.textContent = results.length + ' programme' + (results.length === 1 ? '' : 's') + ' in the next 24 hours';
          results.slice(0, 150).forEach(function (r) {
            var live = r.s <= Date.now() / 1000;
            listEl.appendChild(h('div', { class: 'ch' }, h('button', { class: 'pick', type: 'button', 'data-key': r.p + ':' + r.sid, onclick: function () { choose(r); } },
              imgOrBlank(r.icon),
              h('span', { class: 'nm' }, h('b', { text: r.t }), h('small', { text: '  ' + r.name })),
              h('span', { class: 'chip' + (live ? ' live' : ''), text: (live ? 'now · ' : '') + fmtClock(r.s) + '-' + fmtClock(r.e) }))));
          });
        });
      });
    }

    // arrows inside the guide: left/right along a row, up/down between rows (by time position)
    listEl.addEventListener('keydown', function (e) {
      if (pk.tab !== 'guide' || pk.q.trim()) return;
      var t = e.target;
      var row = t.closest ? t.closest('.grow') : null;
      if (!row || row.classList.contains('ghead')) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        var btns = Array.prototype.slice.call(row.querySelectorAll('button'));
        var i = btns.indexOf(t);
        var nx = btns[i + (e.key === 'ArrowRight' ? 1 : -1)];
        e.preventDefault();
        e.stopPropagation();
        if (nx) { nx.focus(); nx.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var sib = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
        e.preventDefault();
        e.stopPropagation();
        while (sib && !sib.classList.contains('grow')) sib = e.key === 'ArrowDown' ? sib.nextElementSibling : sib.previousElementSibling;
        if (!sib) { if (e.key === 'ArrowUp') search.focus(); return; }
        if (sib.classList.contains('ghead')) { search.focus(); return; }
        var x = t.getBoundingClientRect();
        var cx = x.left + x.width / 2;
        var target = sib.querySelector('.gch');
        if (!t.classList.contains('gch')) {
          var cand = sib.querySelectorAll('.prog');
          for (var j = 0; j < cand.length; j++) {
            var b = cand[j].getBoundingClientRect();
            if (b.left <= cx && b.right >= cx) { target = cand[j]; break; }
          }
        }
        if (target) { target.focus(); target.scrollIntoView({ block: 'nearest' }); }
      }
    });

    // arrow keys inside the list: up/down between rows, left/right between channel and star
    listEl.addEventListener('keydown', function (e) {
      if (pk.tab === 'guide' && !pk.q.trim()) return;
      var t = e.target;
      var row = t.closest ? t.closest('.ch') : null;
      if (!row) return;
      var col = t.classList.contains('star') ? 'star' : 'pick';
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var sib = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
        e.preventDefault();
        e.stopPropagation();
        if (sib) { var tgt = sib.querySelector(col === 'star' ? '.star' : '.pick') || sib.querySelector('button'); if (tgt) { tgt.focus(); tgt.scrollIntoView({ block: 'nearest' }); } }
        else if (e.key === 'ArrowUp') search.focus();
      } else if (e.key === 'ArrowRight' && col === 'pick') { var st = row.querySelector('.star'); if (st) { e.preventDefault(); e.stopPropagation(); st.focus(); } }
      else if (e.key === 'ArrowLeft' && col === 'star') { e.preventDefault(); e.stopPropagation(); row.querySelector('.pick').focus(); }
    });

    function choose(r) {
      pk.last = r.p + ':' + r.sid;
      remember();
      if (r.vod === 'series') { openEpisodes(r, slot, function () { m.close(); }); return; }
      m.close();
      var cfg = { p: r.p, sid: String(r.sid), name: r.name, icon: r.icon || '' };
      if (r.vod) { cfg.vod = r.vod; cfg.ext = r.ext || 'mp4'; }
      assign(slot, cfg);
      select(slot);
    }

    function setTab(t) {
      if (pk.tab === t) return;
      pk.tab = t;
      pk.cat = '';
      pk.limit = 100;
      pk.scroll = 0;
      pk.last = '';
      restore = false;
      m.body.scrollTop = 0;
      saveSoon();
      syncControls();
      load(false);
    }

    var qTimer = null;
    search.addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(function () { pk.q = search.value.trim(); pk.limit = 100; pk.scroll = 0; saveSoon(); render(); }, pk.tab === 'guide' ? 350 : 150); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var first = listEl.querySelector('.pick, .gch'); if (first) { e.preventDefault(); first.click(); } }
    });
    provSel.addEventListener('change', function () { pk.prov = provSel.value; pk.cat = ''; pk.limit = 100; pk.scroll = 0; pk.last = ''; saveSoon(); load(false); });
    catSel.addEventListener('change', function () { pk.cat = catSel.value; pk.limit = 100; pk.scroll = 0; saveSoon(); render(); });
    favBtn.addEventListener('click', function () { pk.favs = !pk.favs; favBtn.classList.toggle('on', pk.favs); pk.limit = 100; pk.scroll = 0; saveSoon(); render(); });
    refBtn.addEventListener('click', function () {
      clearListCaches();
      gcache = {};
      load(true);
    });
    resetBtn.addEventListener('click', function () {
      pk.q = ''; pk.cat = ''; pk.favs = false; pk.limit = 100; pk.scroll = 0; pk.last = ''; pk.tab = 'live';
      pk.prov = provs.length === 1 ? provs[0].id : '';
      restore = false;
      m.body.scrollTop = 0;
      saveSoon();
      syncControls();
      load(false);
      search.focus();
    });

    var cur = S.tiles[slot];
    m = openModal({
      title: 'Choose channel for tile ' + (slot + 1),
      wide: true,
      body: [tabBar, h('div', { class: 'filters' }, provSel, catSel), h('div', { class: 'pickerbar' }, search, favBtn, refBtn, resetBtn), info, listEl],
      foot: [cur ? h('button', { class: 'btn', type: 'button', text: 'Remove channel', onclick: function () { m.close(); assign(slot, null); } }) : null,
        h('button', { class: 'btn', type: 'button', text: 'Close', onclick: function () { m.close(); } })],
      focus: '.search',
      onClose: function () { remember(); }
    });
    // the remembered channel stops being "the place" once the user has scrolled a screen or more away from it
    function checkLast() {
      if (!pk.last) return;
      var box = m.body.getBoundingClientRect();
      var els = listEl.querySelectorAll('[data-key]');
      for (var i = 0; i < els.length; i++) {
        if (els[i].getAttribute('data-key') !== pk.last) continue;
        var r = els[i].getBoundingClientRect();
        if (r.bottom < box.top - box.height || r.top > box.bottom + box.height) pk.last = '';
        return;
      }
    }
    m.body.addEventListener('scroll', function () { if (restore) return; pk.scroll = m.body.scrollTop; checkLast(); saveSoon(); });

    getProviders().then(function (list) {
      provs = list;
      provSel.appendChild(h('option', { value: provs.length === 1 ? provs[0].id : '', text: provs.length > 1 ? 'All providers' : (provs[0] ? provs[0].name : 'No providers') }));
      if (provs.length > 1) provs.forEach(function (p) { provSel.appendChild(h('option', { value: p.id, text: p.name + (p.enabled ? '' : ' (off)') })); });
      if (provs.length === 1) pk.prov = provs[0].id;
      if (pk.prov && !provs.some(function (p) { return p.id === pk.prov; })) pk.prov = '';
      if (!provs.length) { info.textContent = 'No providers yet. Add one under Providers.'; return; }
      syncControls();
      load(false);
    }).catch(function (e) { info.textContent = e.message; });
  }

  // episodes of one series: pick a season, then an episode
  function openEpisodes(series, slot, done) {
    var info = h('div', { class: 'note', text: 'Loading episodes...' });
    var seasonSel = h('select', { 'aria-label': 'Season' });
    var list = h('div', { class: 'chlist' });
    var data = null;
    var m = openModal({
      title: series.name,
      wide: true,
      body: [h('div', { class: 'filters' }, seasonSel), info, list],
      foot: h('button', { class: 'btn', type: 'button', text: 'Back', onclick: function () { m.close(); } })
    });
    function showSeason() {
      list.textContent = '';
      var s = data.seasons[Number(seasonSel.value)];
      if (!s) return;
      s.episodes.forEach(function (ep) {
        var label = 'E' + (ep.num || '?') + '  ' + ep.title;
        list.appendChild(h('div', { class: 'ch' }, h('button', { class: 'pick', type: 'button', onclick: function () {
          m.close();
          done();
          assign(slot, { p: series.p, sid: 'series:' + ep.id, name: series.name + ' S' + s.season + 'E' + (ep.num || '?') + ' ' + ep.title, icon: series.icon || '', vod: 'series', ext: ep.ext });
          select(slot);
        } }, h('span', { class: 'nm', text: label }), ep.minutes ? h('span', { class: 'chip', text: ep.minutes + ' min' }) : null)));
      });
      var first = list.querySelector('.pick');
      if (first) first.focus();
    }
    api('/api/series?provider=' + enc(series.p) + '&id=' + enc(series.id)).then(function (r) {
      data = r;
      if (!r.seasons.length) { info.textContent = 'This series has no episodes listed.'; return; }
      info.textContent = '';
      r.seasons.forEach(function (s, i) { seasonSel.appendChild(h('option', { value: String(i), text: 'Season ' + s.season + ' (' + s.episodes.length + ' episodes)' })); });
      seasonSel.addEventListener('change', showSeason);
      showSeason();
    }).catch(function (e) { info.textContent = e.message; });
  }

  // ---------------------------------------------------------------- settings
  function openSettings() {
    function field(label, control) { return h('div', { class: 'field' }, h('label', { text: label }), control); }
    function check(label, key, after) {
      var cb = h('input', { type: 'checkbox' });
      cb.checked = !!S[key];
      cb.addEventListener('change', function () { S[key] = cb.checked; saveSoon(); if (after) after(); });
      return h('label', { class: 'check' }, cb, h('span', { text: label }));
    }
    function secLabel(n) { return n === 0 ? 'Off (lowest delay, may stutter)' : n < 60 ? n + ' seconds' : n % 60 === 0 ? (n / 60) + ' minute' + (n === 60 ? '' : 's') : n + ' seconds'; }
    var bufSel = h('select');
    [0, 2, 4, 8, 15, 30, 60, 120, 300].forEach(function (n) { bufSel.appendChild(h('option', { value: String(n), text: secLabel(n) + (n === 4 ? ' (default)' : '') })); });
    bufSel.value = String(S.bufSec);
    if (bufSel.value !== String(S.bufSec)) { bufSel.appendChild(h('option', { value: String(S.bufSec), text: secLabel(S.bufSec) })); bufSel.value = String(S.bufSec); }
    var keepSel = h('select');
    keepSel.appendChild(h('option', { value: '0', text: 'Same as above (default)' }));
    [30, 60, 120, 300, 600].forEach(function (n) { keepSel.appendChild(h('option', { value: String(n), text: secLabel(n) })); });
    keepSel.value = String(S.keepSec);
    if (keepSel.value !== String(S.keepSec)) keepSel.value = '0';
    var memNote = h('div', { class: 'note' });
    function memWarn() {
      var keep = Math.max(S.keepSec || 0, S.bufSec);
      var tilesN = visibleCount();
      var mb = Math.round(keep * 0.5 * tilesN);   // about 4 Mbps per channel
      memNote.textContent = keep >= 30 ? 'A cushion of ' + secLabel(keep) + ' on ' + tilesN + ' tiles can use roughly ' + mb + ' MB of browser memory (4 Mbps channels) and the server keeps the same amount per channel (RING_MB). Each tile also waits that long before its picture starts, unless the server already has the video (another viewer is watching it).' : '';
      memNote.className = 'note' + (mb > 800 ? ' warn' : '');
    }
    bufSel.addEventListener('change', function () { S.bufSec = Number(bufSel.value); saveSoon(); memWarn(); });
    keepSel.addEventListener('change', function () { S.keepSec = Number(keepSel.value); saveSoon(); memWarn(); });
    memWarn();
    var trSel = h('select', null, h('option', { value: 'auto', text: 'WebSocket (recommended: 9 streams at once)' }), h('option', { value: 'http', text: 'Plain HTTP (browsers allow only about 6 streams)' }));
    trSel.value = S.transport === 'http' ? 'http' : 'auto';
    trSel.addEventListener('change', function () { S.transport = trSel.value; wsBlocked = false; wsFails = 0; saveSoon(); });
    var fitSel = h('select', null, h('option', { value: 'contain', text: 'Fit (black bars, nothing cropped)' }), h('option', { value: 'cover', text: 'Fill (crops edges)' }));
    fitSel.value = S.fit;
    fitSel.addEventListener('change', function () { S.fit = fitSel.value; document.body.classList.toggle('fill', S.fit === 'cover'); saveSoon(); });
    var shSel = h('select', null, h('option', { value: '', text: 'Off - each tile plays its own stream' }), h('option', { value: '480', text: '480p - lightest' }), h('option', { value: '720', text: '720p - recommended for a TV' }), h('option', { value: '1080', text: '1080p - needs a strong server' }));
    shSel.value = S.shared || '';
    shSel.addEventListener('change', function () { S.shared = shSel.value; shared.failed = false; shared.retry = 0; saveSoon(); sharedApply(); sharedSync(); });
    var shNote = h('div', { class: 'note', text: 'Shared screen: the server combines all tiles into one picture, so a weak TV box decodes a single stream. Uses server CPU/GPU while you watch.' });
    var shInfo = h('div', { class: 'note' });
    var shBtns = h('div', { class: 'viewbtns' });
    if (isAdmin()) {
      api('/api/compose/info').then(function (i) {
        shInfo.textContent = 'Server encoder: ' + (i.encoder === 'x264' ? 'CPU (x264)' : i.encoder === 'vaapi' ? 'GPU (VAAPI ' + i.vaapiDevice + ')' : 'GPU (NVENC)') +
          (i.vaapiPresent ? '' : ' - no GPU device inside the container') + '. Limits: ' + i.max.compose + ' shared screen(s), ' + i.max.tile + ' 480p channel(s). ' + (i.ffmpeg ? '' : 'ffmpeg is missing.');
      }, noop);
      [['x264', 'Test CPU encoder'], ['vaapi', 'Test GPU encoder (VAAPI)']].forEach(function (b) {
        var btn = h('button', { class: 'btn', type: 'button', text: b[1] });
        btn.addEventListener('click', function () {
          btn.disabled = true;
          shInfo.textContent = 'Testing...';
          api('/api/compose/test', { method: 'POST', body: { encoder: b[0] } }).then(function (r) { shInfo.textContent = b[1].replace('Test ', '') + ': ' + (r.ok ? 'works - ' : 'FAILED - ') + r.message; shInfo.className = 'note' + (r.ok ? '' : ' warn'); }, function (e) { shInfo.textContent = e.message; }).then(function () { btn.disabled = false; });
        });
        shBtns.appendChild(btn);
      });
    }
    var keys = h('div', { class: 'keys' },
      h('b', { text: 'Arrows' }), h('span', { text: 'move between tiles (Up from the top row = toolbar)' }),
      h('b', { text: 'OK / Enter' }), h('span', { text: 'tile menu (or add a channel to an empty tile)' }),
      h('b', { text: '1 - 9' }), h('span', { text: 'jump to a tile; the selected tile has the sound' }),
      h('b', { text: 'M  L  F' }), h('span', { text: 'mute, next layout, fullscreen' }),
      h('b', { text: 'S  Z  C  R' }), h('span', { text: 'make main, zoom, change channel, reload' }),
      h('b', { text: 'I' }), h('span', { text: 'show/hide stats (resolution, buffer, dropped frames)' }),
      h('b', { text: 'Back / Esc' }), h('span', { text: 'close a window' }));
    var m = openModal({
      title: 'Settings',
      body: [
        field('Start playing after (video collected before a tile starts; smoother, adds delay)', bufSel),
        field('Keep up to (largest cushion kept while playing)', keepSel),
        memNote,
        field('Video', fitSel),
        field('Shared screen (for weak devices)', shSel),
        shNote, shInfo, shBtns,
        field('Stream delivery (applies when a stream reconnects)', trSel),
        check('Use another provider when the chosen one is full', 'failover', function () { tiles.forEach(function (t) { if (t.cfg && t.retry) t.start(); }); }),
        check('Small tiles prefer the SD version of a channel (less to download and decode)', 'smallSd', function () { tiles.forEach(function (t) { t.applyQuality(); }); }),
        check('Use web workers (lighter on the page; turn off if video will not start)', 'workers'),
        check('Show stats on tiles', 'stats', function () { document.body.classList.toggle('stats', S.stats); }),
        check('Always show channel names', 'labels', function () { document.body.classList.toggle('showlabels', S.labels); }),
        check("Show what's on now under channel names (programme guide)", 'epgOn', function () { tiles.forEach(function (t) { t.render(); }); pollEpg(); }),
        h('div', { class: 'note', text: 'Buffer and failover apply the next time a stream (re)connects.' }),
        keys
      ],
      foot: [
        !isAdmin() ? null : h('button', { class: 'btn', type: 'button', text: 'Clear all tiles', onclick: function () { m.close(); S.tiles = S.tiles.map(function () { return null; }); tiles.forEach(function (t) { t.setCfg(null); }); saveSoon(); updateHint(); } }),
        window.MVApp ? h('button', { class: 'btn', type: 'button', text: 'Server address (TV app)...', onclick: function () { m.close(); window.MVApp.changeServer(); } }) : null,
        h('button', { class: 'btn', type: 'button', text: 'Restart all streams', onclick: function () { m.close(); tiles.forEach(function (t) { t.reload(); }); } }),
        h('button', { class: 'btn', type: 'button', text: 'Close', onclick: function () { m.close(); } })
      ]
    });
  }

  // ---------------------------------------------------------------- providers
  function openProviders(intro) {
    var m = openModal({ title: 'Providers', body: h('div', null, h('div', { class: 'note', text: 'Loading...' })), foot: null });
    function done() { providersCache = null; clearListCaches(); refreshState(); }

    function list() {
      Promise.all([api('/api/providers'), api('/api/state')]).then(function (r) {
        providersCache = r[0].providers;
        serverState = r[1];
        var provs = r[0].providers;
        var body = [];
        if (intro && !provs.length) body.push(h('div', { class: 'note', text: 'Welcome. Add your IPTV provider (Xtream Codes login) to get started. You can add several providers: each one adds connections.' }));
        if (!provs.length) body.push(h('div', { class: 'note', text: 'No providers yet.' }));
        provs.forEach(function (p) {
          var st = null;
          r[1].providers.forEach(function (s) { if (s.id === p.id) st = s; });
          var active = st ? st.active : 0;
          body.push(h('div', { class: 'prov' },
            h('div', { class: 'name' }, h('b', { text: p.name + (p.enabled ? '' : '  (off)') }), h('small', { text: (p.type === 'local' ? 'Capture card · ' + p.sources.length + ' source' + (p.sources.length === 1 ? '' : 's') : host(p.url)) + '  ·  ' + active + ' of ' + p.maxConnections + ' connection' + (p.maxConnections === 1 ? '' : 's') + ' in use' }),
              h('div', { class: 'bar' }, h('i', { class: active >= p.maxConnections ? 'full' : '', style: 'width:' + Math.min(100, Math.round(100 * active / Math.max(1, p.maxConnections))) + '%' }))),
            h('button', { class: 'btn', type: 'button', text: 'Edit', onclick: function () { if (p.type === 'local') formLocal(p, provs); else form(p, provs); } })));
        });
        var streams = r[1].streams;
        if (streams.length) {
          body.push(h('div', { class: 'note', text: 'Open streams' }));
          streams.forEach(function (s) {
            body.push(h('div', { class: 'note', text: s.provider + ' · ' + (s.name || s.sid) + ' · ' + s.viewers + ' viewer' + (s.viewers === 1 ? '' : 's') + (s.kbps ? ' · ' + s.kbps + ' kbps' : '') + (s.error ? ' · ' + s.error : '') }));
          });
        }
        m.setBody(body, [
          h('button', { class: 'btn', type: 'button', text: 'Add provider', onclick: function () { form(null, provs); } }),
          h('button', { class: 'btn', type: 'button', text: 'Add capture card', title: 'A video capture device plugged into the server', onclick: function () { formLocal(null, provs); } }),
          h('button', { class: 'btn', type: 'button', text: 'Close', onclick: function () { m.close(); } })
        ]);
        var first = $('.btn', m.box);
        if (first && !modalHasFocus(m)) first.focus();
      }).catch(function (e) { m.setBody(h('div', { class: 'msg bad', text: e.message }), h('button', { class: 'btn', type: 'button', text: 'Close', onclick: function () { m.close(); } })); });
    }
    function modalHasFocus(mm) { return mm.box.contains(document.activeElement); }

    function form(p, provs) {
      var f = {
        name: h('input', { type: 'text', value: p ? p.name : '', placeholder: 'e.g. My IPTV', autocomplete: 'off' }),
        url: h('input', { type: 'url', value: p ? p.url : '', placeholder: 'http://server.example.com:8080', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }),
        user: h('input', { type: 'text', value: p ? p.username : '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }),
        pass: h('input', { type: 'password', value: '', placeholder: p ? '(unchanged)' : '', autocomplete: 'new-password' }),
        max: h('input', { type: 'number', value: String(p ? p.maxConnections : 1), min: '1', max: '50' }),
        on: h('input', { type: 'checkbox' })
      };
      f.on.checked = p ? p.enabled : true;
      var msg = h('div');
      function rec() {
        return { id: p ? p.id : undefined, name: f.name.value.trim(), url: f.url.value.trim(), username: f.user.value.trim(), password: f.pass.value, maxConnections: Number(f.max.value) || 1, enabled: f.on.checked };
      }
      function show(kind, text) { msg.textContent = ''; if (text) msg.appendChild(h('div', { class: 'msg ' + kind, text: text })); }
      var removeBtn = p ? h('button', { class: 'btn', type: 'button', text: 'Remove', onclick: function () {
        if (removeBtn.getAttribute('data-sure') !== '1') { removeBtn.setAttribute('data-sure', '1'); removeBtn.textContent = 'Really remove?'; return; }
        save(provs.filter(function (x) { return x.id !== p.id; }));
      } }) : null;
      function save(next) {
        api('/api/providers', { method: 'PUT', body: { providers: next } }).then(function () { done(); list(); }).catch(function (e) { show('bad', e.message); });
      }
      m.setBody([
        h('div', { class: 'field' }, h('label', { text: 'Name' }), f.name),
        h('div', { class: 'field' }, h('label', { text: 'Server URL (from your provider, usually http://host:port)' }), f.url),
        h('div', { class: 'row2' }, h('div', { class: 'field' }, h('label', { text: 'Username' }), f.user), h('div', { class: 'field' }, h('label', { text: 'Password' }), f.pass)),
        h('div', { class: 'field' }, h('label', { text: 'Max connections your plan allows' }), f.max),
        h('label', { class: 'check' }, f.on, h('span', { text: 'Enabled' })),
        msg
      ], [
        removeBtn,
        h('button', { class: 'btn', type: 'button', text: 'Test', onclick: function () {
          show('', 'Testing...');
          api('/api/providers/test', { method: 'POST', body: { provider: rec() } }).then(function (r) {
            if (!r.ok) { show('bad', r.error); return; }
            if (r.maxConnections > 0) f.max.value = String(r.maxConnections);
            show('ok', 'Login OK (' + r.status + (r.expires ? ', expires ' + r.expires : '') + '). Your plan allows ' + (r.maxConnections || '?') + ' connection(s)' + (r.maxConnections ? ' - filled in above.' : '.'));
          }).catch(function (e) { show('bad', e.message); });
        } }),
        h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: list }),
        h('button', { class: 'btn on', type: 'button', text: 'Save', onclick: function () {
          var r = rec();
          var next = provs.map(function (x) { return x.id === (p && p.id) ? r : x; });
          if (!p) next.push(r);
          save(next);
        } })
      ]);
      f.name.focus();
    }
    // A capture card (or other V4L2 video device) on the machine running the server, shown as channels.
    function formLocal(p, provs) {
      var name = h('input', { type: 'text', value: p ? p.name : 'Capture card', autocomplete: 'off' });
      var on = h('input', { type: 'checkbox' });
      on.checked = p ? p.enabled : true;
      var msg = h('div');
      var devNote = h('div', { class: 'note', text: 'Looking for devices...' });
      var vlist = h('datalist', { id: 'dl-video' });
      var alist = h('datalist', { id: 'dl-audio' });
      var srcBox = h('div');
      var rows = [];
      function show(kind, text) { msg.textContent = ''; if (text) msg.appendChild(h('div', { class: 'msg ' + kind, text: text })); }
      function sel(options, value) {
        var el = h('select');
        options.forEach(function (o) { el.appendChild(h('option', { value: String(o[0]), text: o[1] })); });
        el.value = String(value);
        if (el.value !== String(value)) { el.appendChild(h('option', { value: String(value), text: String(value) })); el.value = String(value); }
        return el;
      }
      function addSource(src) {
        src = src || { name: '', video: '', audio: '', size: '1280x720', fps: 30, bitrate: 4000, encoder: 'x264', inputFormat: '' };
        var f = {
          id: src.id,
          name: h('input', { type: 'text', value: src.name, placeholder: 'e.g. Console HDMI', autocomplete: 'off' }),
          video: h('input', { type: 'text', value: src.video, placeholder: '/dev/video0', list: 'dl-video', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }),
          audio: h('input', { type: 'text', value: src.audio, placeholder: 'hw:1,0 (leave empty for no sound)', list: 'dl-audio', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }),
          size: sel([['1920x1080', '1920x1080'], ['1280x720', '1280x720'], ['854x480', '854x480'], ['640x480', '640x480']], src.size),
          fps: sel([[25, '25 fps'], [30, '30 fps'], [50, '50 fps'], [60, '60 fps']], src.fps),
          bitrate: h('input', { type: 'number', value: String(src.bitrate), min: '500', max: '20000', step: '500' }),
          encoder: sel([['x264', 'CPU (x264) - works everywhere'], ['vaapi', 'Intel/AMD GPU (VAAPI)'], ['nvenc', 'NVIDIA GPU (NVENC)']], src.encoder),
          fmt: sel([['', 'Automatic'], ['mjpeg', 'MJPEG'], ['yuyv422', 'YUYV (uncompressed)'], ['h264', 'H.264 (camera encodes)'], ['nv12', 'NV12']], src.inputFormat || '')
        };
        var box = h('div', { class: 'prov srcbox' },
          h('div', { class: 'field' }, h('label', { text: 'Channel name' }), f.name),
          h('div', { class: 'row2' }, h('div', { class: 'field' }, h('label', { text: 'Video device' }), f.video), h('div', { class: 'field' }, h('label', { text: 'Audio device' }), f.audio)),
          h('div', { class: 'row2' }, h('div', { class: 'field' }, h('label', { text: 'Resolution' }), f.size), h('div', { class: 'field' }, h('label', { text: 'Frame rate' }), f.fps)),
          h('div', { class: 'row2' }, h('div', { class: 'field' }, h('label', { text: 'Video bitrate (kbps)' }), f.bitrate), h('div', { class: 'field' }, h('label', { text: 'Encoder' }), f.encoder)),
          h('div', { class: 'field' }, h('label', { text: 'Device output format' }), f.fmt),
          h('button', { class: 'btn danger', type: 'button', text: 'Remove this source', onclick: function () { rows.splice(rows.indexOf(f), 1); box.remove(); } }));
        f.box = box;
        rows.push(f);
        srcBox.appendChild(box);
      }
      function rec() {
        return {
          id: p ? p.id : undefined, type: 'local', name: name.value.trim(), enabled: on.checked,
          sources: rows.map(function (f) { return { id: f.id, name: f.name.value.trim(), video: f.video.value.trim(), audio: f.audio.value.trim(), size: f.size.value, fps: Number(f.fps.value), bitrate: Number(f.bitrate.value) || 4000, encoder: f.encoder.value, inputFormat: f.fmt.value }; })
        };
      }
      function save(next) {
        api('/api/providers', { method: 'PUT', body: { providers: next } }).then(function () { done(); list(); }).catch(function (e) { show('bad', e.message); });
      }
      (p && p.sources.length ? p.sources : [null]).forEach(function (s0) { addSource(s0); });
      api('/api/devices').then(function (d) {
        d.video.forEach(function (v) { vlist.appendChild(h('option', { value: v.path, label: v.name })); });
        vlist.appendChild(h('option', { value: 'test', label: 'Test pattern (no hardware needed)' }));
        d.audio.forEach(function (a) { alist.appendChild(h('option', { value: a.id, label: a.name })); });
        alist.appendChild(h('option', { value: 'test', label: 'Test tone' }));
        devNote.textContent = (d.ffmpeg ? '' : 'ffmpeg is not installed in this container. ') +
          (d.video.length ? 'Video devices seen by the container: ' + d.video.map(function (v) { return v.path + (v.name ? ' (' + v.name + ')' : ''); }).join(', ') + '.' : 'No video devices are visible inside the container. Add  devices: [/dev/video0, /dev/snd]  to the stack, then restart it. (You can still try the test pattern: type "test" as the video device.)') +
          (d.audio.length ? ' Audio: ' + d.audio.map(function (a) { return a.id + ' (' + a.name + ')'; }).join(', ') + '.' : '');
      }).catch(function (e) { devNote.textContent = e.message; });
      m.setBody([
        h('div', { class: 'field' }, h('label', { text: 'Name of this group' }), name),
        devNote, vlist, alist, srcBox,
        h('button', { class: 'btn', type: 'button', text: 'Add another source', onclick: function () { addSource(null); } }),
        h('label', { class: 'check' }, on, h('span', { text: 'Enabled' })),
        h('div', { class: 'note', text: 'The server encodes each source to H.264/AAC and shares it like any channel. It uses no provider connection. HDMI sources protected by HDCP cannot be captured.' }),
        msg
      ], [
        p ? h('button', { class: 'btn', type: 'button', text: 'Remove', onclick: function () { save(provs.filter(function (x) { return x.id !== p.id; })); } }) : null,
        h('button', { class: 'btn', type: 'button', text: 'Test', onclick: function () {
          show('', 'Checking...');
          api('/api/providers/test', { method: 'POST', body: { provider: rec() } }).then(function (r) { show(r.ok ? 'ok' : 'bad', r.ok ? 'Looks fine: ' + r.status : r.error); }).catch(function (e) { show('bad', e.message); });
        } }),
        h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: list }),
        h('button', { class: 'btn on', type: 'button', text: 'Save', onclick: function () {
          var r = rec();
          var next = provs.map(function (x) { return x.id === (p && p.id) ? r : x; });
          if (!p) next.push(r);
          save(next);
        } })
      ]);
      name.focus();
    }
    list();
  }

  // ---------------------------------------------------------------- input
  var wakeLock = null;
  function userGesture() {
    if (userActive) return;
    userActive = true;
    applyAudio();
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(noop); } catch (e) { /* ignore */ }
  }

  function typing(t) { return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'); }

  function onKey(e) {
    if (!ME) return;
    userGesture();
    toolbarWake();
    if (modals.length) {
      if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack' || e.keyCode === 4 || (e.key === 'Backspace' && !typing(e.target))) {
        e.preventDefault();
        closeTopModal();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;
    if (typing(t)) return;
    var inToolbar = $('#toolbar').contains(t);
    var key = e.key;
    var n = visibleCount();
    if (key === 'Escape' && zoom >= 0) { toggleZoom(zoom); e.preventDefault(); return; }
    if (key.length === 1 && key >= '1' && key <= '9') {
      var i = Number(key) - 1;
      if (i < n && zoom < 0) { select(i); e.preventDefault(); }
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
      if (inToolbar) {
        var items = focusables($('#toolbar'));
        var at = items.indexOf(t);
        if (key === 'ArrowDown') { tiles[S.sel].el.focus(); e.preventDefault(); }
        else if (key === 'ArrowLeft' || key === 'ArrowRight') { var nx = items[clamp(at + (key === 'ArrowRight' ? 1 : -1), 0, items.length - 1)]; if (nx) nx.focus(); e.preventDefault(); }
        return;
      }
      e.preventDefault();
      if (zoom >= 0) return;
      var from = t && t.classList && t.classList.contains('tile') ? Number(t.getAttribute('data-idx')) : S.sel;
      var to = neighbor(from, key);
      if (to >= 0) select(to);
      else if (key === 'ArrowUp') { var b = $('#layouts .btn.on') || $('#toolbar .btn'); if (b) b.focus(); }
      else if (!t || !t.classList || !t.classList.contains('tile')) tiles[S.sel].el.focus();
      return;
    }
    var tile = tiles[S.sel];
    switch (key) {
      case 'Enter':
      case ' ':
        if (t && t.classList && t.classList.contains('tile')) {
          e.preventDefault();
          if (tile.cfg) openTileMenu(S.sel); else if (isAdmin()) openPicker(S.sel);
        }
        break;
      case 'm': case 'M': toggleMute(); break;
      case 'l': case 'L': if (isAdmin()) cycleLayout(); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 's': case 'S': if (tile.cfg && isAdmin()) swapWithMain(S.sel); break;
      case 'z': case 'Z': if (tile.cfg) toggleZoom(S.sel); break;
      case 'c': case 'C': if (isAdmin()) { e.preventDefault(); openPicker(S.sel); } break;
      case 'r': case 'R': tile.reload(); break;
      case 'i': case 'I': S.stats = !S.stats; document.body.classList.toggle('stats', S.stats); saveSoon(); break;
      case 'Delete': if (tile.cfg && isAdmin()) assign(S.sel, null); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- accounts, login, shared multiviews
  function isAdmin() { return !ME || ME.admin; }
  function field(label, control) { return h('div', { class: 'field' }, h('label', { text: label }), control); }
  function closeBtn(m, text) { return h('button', { class: 'btn', type: 'button', text: text || 'Close', onclick: function () { m.close(); } }); }

  var sessionTimer = null;
  function sessionLost() {
    if (sessionTimer) return;
    sessionTimer = setTimeout(function () { location.reload(); }, 300);
  }
  function sessionCheck() {
    api('/api/me').then(function (me) {
      if (me.authRequired && !me.user) sessionLost();
    }).catch(noop);
  }

  function showLogin(done) {
    var user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
    var pass = h('input', { type: 'password', autocomplete: 'current-password' });
    var msg = h('div', { class: 'msg bad', hidden: true });
    var go = h('button', { class: 'btn primary', type: 'button', text: 'Log in' });
    var busy = false;
    var box = h('div', { class: 'modal login', role: 'dialog' }, h('h2', { text: 'IPTV Multiview' }),
      h('div', { class: 'body' }, field('Username', user), field('Password', pass), msg), h('div', { class: 'foot' }, go));
    var back = h('div', { class: 'modal-back login-back' }, box);
    function submit() {
      if (busy) return;
      busy = true;
      msg.hidden = true;
      api('/api/login', { method: 'POST', body: { username: user.value.trim(), password: pass.value } }).then(function () {
        if (back.parentNode) back.parentNode.removeChild(back);
        done();
      }).catch(function (e) {
        busy = false;
        msg.hidden = false;
        msg.textContent = e.message;
        pass.value = '';
        pass.focus();
      });
    }
    go.addEventListener('click', submit);
    user.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); pass.focus(); } });
    pass.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    document.body.appendChild(back);
    user.focus();
  }

  function askText(title, label, initial, okText, cb) {
    var inp = h('input', { type: 'text', value: initial || '', autocomplete: 'off', maxlength: '60' });
    var msg = h('div');
    var m = openModal({
      title: title,
      body: [field(label, inp), msg],
      foot: [closeBtn(m0(), 'Cancel'), h('button', { class: 'btn primary', type: 'button', text: okText, onclick: go })]
    });
    function m0() { return { close: function () { m.close(); } }; }
    function go() {
      var v = inp.value.trim();
      if (!v) { msg.textContent = ''; msg.appendChild(h('div', { class: 'msg bad', text: 'Enter a name' })); return; }
      m.close();
      cb(v);
    }
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    inp.focus();
    inp.select();
  }

  // ---- viewing a shared multiview
  var viewsCache = [];
  var curView = null; // { id, rev, name }
  var viewPoll = null;

  function fetchViews() {
    return api('/api/views').then(function (r) { viewsCache = r.views || []; return viewsCache; });
  }

  function sameCfg(a, b) { return (!a && !b) || !!(a && b && a.p === b.p && String(a.sid) === String(b.sid)); }

  function applyView(v) {
    curView = { id: v.id, rev: v.rev, name: v.name };
    S.layout = LAYOUTS[v.layout] ? v.layout : '3x3';
    zoom = -1;
    var changed = [];
    for (var i = 0; i < SLOTS; i++) {
      var c = cleanTile(v.tiles[i]);
      if (!sameCfg(S.tiles[i], c)) {
        changed.push({ i: i, was: tiles[i].visible });
        tiles[i].stop();
        tiles[i].retry = 0;
        tiles[i].mediaErrors = 0;
      }
      S.tiles[i] = c;
      tiles[i].cfg = c;
      tiles[i].render();
    }
    if (S.sel >= visibleCount() || !S.tiles[S.sel]) {
      var pick = 0;
      for (var k = 0; k < visibleCount(); k++) { if (S.tiles[k]) { pick = k; break; } }
      S.sel = pick;
    }
    renderGrid();
    changed.forEach(function (x) { if (x.was && tiles[x.i].visible) tiles[x.i].start(); });
    $('#view-title').textContent = v.name;
    try { localStorage.setItem('mv.lastview', v.id); } catch (e) { /* ignore */ }
    saveSoon();
    updateHint();
    if (!modals.length && tiles[S.sel]) tiles[S.sel].el.focus();
  }

  function clearGrid() {
    curView = null;
    $('#view-title').textContent = '';
    S.tiles = S.tiles.map(function () { return null; });
    tiles.forEach(function (t) { t.stop(); t.cfg = null; t.render(); });
    updateHint();
  }

  function pollViews() {
    if (isAdmin() || document.hidden || !ME) return;
    fetchViews().then(function (list) {
      if (!curView) return;
      var v = null;
      list.forEach(function (x) { if (x.id === curView.id) v = x; });
      if (!v) {
        clearGrid();
        banner('That multiview is no longer shared with you', 4000);
        if (!modals.length) openViews();
        return;
      }
      if (v.rev !== curView.rev) { applyView(v); banner('"' + v.name + '" was updated', 3000); }
    }).catch(function (e) { if (e.status !== 401) noop(); });
  }

  function layoutName(key) { return LAYOUTS[key] ? LAYOUTS[key].name : key; }
  function countTiles(v) { return v.tiles.filter(function (t) { return t; }).length; }

  function openViews() {
    var m = openModal({ title: isAdmin() ? 'Shared multiviews' : 'Choose a multiview', body: h('div', { class: 'note', text: 'Loading...' }), foot: null, wide: isAdmin() });
    function render() {
      var admin = isAdmin();
      var body = [];
      if (admin) body.push(h('div', { class: 'note', text: 'Arrange tiles on the main screen, then publish the layout here. People with a login see it in their list and can just click it. Clicking a name here loads it onto your own screen so you can change it. Changes you save reach people who are already watching within about 15 seconds.' }));
      if (!viewsCache.length) body.push(h('div', { class: 'note', text: admin ? 'Nothing published yet.' : 'No multiviews have been shared with you yet. Ask the person who runs this server.' }));
      viewsCache.forEach(function (v) {
        var info = layoutName(v.layout) + '  ·  ' + countTiles(v) + ' channel' + (countTiles(v) === 1 ? '' : 's') + (admin ? '  ·  ' + (v.users && v.users.length ? v.users.join(', ') : 'everyone') : '');
        var open = h('button', { class: 'view-open', type: 'button', onclick: function () { m.close(); if (admin) loadIntoGrid(v); else applyView(v); } },
          h('b', { text: v.name }), h('small', { text: info }), curView && curView.id === v.id ? h('i', { text: 'now showing' }) : null);
        if (!admin) { body.push(h('div', { class: 'viewrow' }, open)); return; }
        body.push(h('div', { class: 'viewrow adm' }, open, h('div', { class: 'viewbtns' },
          h('button', { class: 'btn', type: 'button', text: 'Update from my screen', title: 'Replace this multiview with the layout and channels on your main screen', onclick: function () { updateFromGrid(v); } }),
          h('button', { class: 'btn', type: 'button', text: 'Who can see it', onclick: function () { editAccess(v); } }),
          h('button', { class: 'btn', type: 'button', text: 'Rename', onclick: function () { askText('Rename multiview', 'Name', v.name, 'Save', function (n) { saveView(v.id, { name: n }); }); } }),
          h('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: function () { deleteView(v); } }))));
      });
      var foot = [];
      if (admin) foot.push(h('button', { class: 'btn primary', type: 'button', text: 'Publish my current screen...', onclick: publishCurrent }));
      foot.push(closeBtn(m));
      m.setBody(body, foot);
      var f = $('.view-open', m.box) || $('.btn', m.box);
      if (f && !m.box.contains(document.activeElement)) f.focus();
    }
    function reload() { return fetchViews().then(render).catch(function (e) { m.setBody(h('div', { class: 'msg bad', text: e.message }), closeBtn(m)); }); }
    function publishCurrent() {
      var n = layout().cells.length;
      var used = S.tiles.slice(0, n).filter(function (t) { return t; }).length;
      if (!used) { banner('Add at least one channel to the screen first', 3000); return; }
      askText('Publish multiview', 'Name (what people will see)', '', 'Publish', function (name) {
        api('/api/views', { method: 'POST', body: { name: name, layout: S.layout, tiles: tilesForPublish() } }).then(function () { banner('Published "' + name + '"', 3000); openViews(); }).catch(function (e) { banner(e.message, 4000); });
      });
      m.close();
    }
    function updateFromGrid(v) {
      confirmBox('Replace "' + v.name + '" with what is on your screen now?', 'Replace', function () {
        saveView(v.id, { layout: S.layout, tiles: tilesForPublish() }, 'Updated "' + v.name + '"');
      });
    }
    function saveView(id, patch, okMsg) {
      api('/api/views/' + encodeURIComponent(id), { method: 'PUT', body: patch }).then(function () { if (okMsg) banner(okMsg, 3000); return reload(); }).catch(function (e) { banner(e.message, 4000); });
    }
    function deleteView(v) {
      confirmBox('Delete "' + v.name + '"? People will lose access to it.', 'Delete', function () {
        api('/api/views/' + encodeURIComponent(v.id), { method: 'DELETE' }).then(reload).catch(function (e) { banner(e.message, 4000); });
      });
    }
    function editAccess(v) {
      api('/api/users').then(function (r) {
        var viewers = r.users.filter(function (u) { return u.role !== 'admin'; });
        var every = h('input', { type: 'checkbox' });
        every.checked = !v.users || !v.users.length;
        var boxes = viewers.map(function (u) {
          var cb = h('input', { type: 'checkbox' });
          cb.checked = (v.users || []).map(function (x) { return x.toLowerCase(); }).indexOf(u.username.toLowerCase()) >= 0;
          cb.addEventListener('change', function () { if (cb.checked) every.checked = false; });
          return { u: u, cb: cb };
        });
        every.addEventListener('change', function () { if (every.checked) boxes.forEach(function (b) { b.cb.checked = false; }); });
        var mm = openModal({
          title: 'Who can see "' + v.name + '"',
          body: [
            h('label', { class: 'check' }, every, h('span', { text: 'Everyone with a viewer login' })),
            viewers.length ? h('div', { class: 'note', text: 'Or only these people:' }) : h('div', { class: 'note', text: 'No viewer accounts yet. Add some under Account > Users.' }),
            boxes.map(function (b) { return h('label', { class: 'check' }, b.cb, h('span', { text: b.u.username })); })
          ],
          foot: [closeBtn({ close: function () { mm.close(); } }, 'Cancel'), h('button', { class: 'btn primary', type: 'button', text: 'Save', onclick: function () {
            var names = boxes.filter(function (b) { return b.cb.checked; }).map(function (b) { return b.u.username; });
            mm.close();
            saveView(v.id, { users: every.checked ? [] : names });
          } })]
        });
      }).catch(function (e) { banner(e.message, 4000); });
    }
    reload();
  }

  function tilesForPublish() {
    var out = [];
    for (var i = 0; i < SLOTS; i++) {
      var t = i < visibleCount() ? S.tiles[i] : null;
      out.push(cleanTile(t));
    }
    return out;
  }

  // copy a published multiview onto the admin's own screen to edit it
  function loadIntoGrid(v) {
    S.layout = LAYOUTS[v.layout] ? v.layout : '3x3';
    zoom = -1;
    for (var i = 0; i < SLOTS; i++) {
      var c = v.tiles[i] || null;
      S.tiles[i] = cleanTile(c);
      tiles[i].stop();
      tiles[i].cfg = S.tiles[i];
      tiles[i].render();
    }
    S.sel = 0;
    var was = tiles.map(function (t) { return t.visible; });
    renderGrid();
    tiles.forEach(function (t, i) { if (was[i] && t.visible) t.start(); });
    saveSoon();
    updateHint();
    banner('Loaded "' + v.name + '" onto your screen. Change it, then use Update from my screen.', 5000);
  }

  function confirmBox(text, okText, cb) {
    var m = openModal({
      title: 'Please confirm',
      body: h('div', { class: 'note', text: text }),
      foot: [closeBtn(m1(), 'Cancel'), h('button', { class: 'btn primary', type: 'button', text: okText, onclick: function () { m.close(); cb(); } })]
    });
    function m1() { return { close: function () { m.close(); } }; }
  }

  // ---- account menu + user management
  function openAccount() {
    var items = [];
    function act(label, fn, cls) { items.push(h('button', { class: 'btn' + (cls ? ' ' + cls : ''), type: 'button', text: label, onclick: function () { m.close(); fn(); } })); }
    if (isAdmin()) act('Users and logins...', openUsers);
    if (ME && ME.user) act('Change my password...', changeOwnPassword);
    if (ME && ME.user) act('Log out', logout, 'danger');
    var m = openModal({
      title: ME && ME.user ? ME.user.username + (ME.admin ? ' (admin)' : '') : 'Accounts',
      body: h('div', { class: 'menu' }, items),
      foot: closeBtn({ close: function () { m.close(); } })
    });
  }

  function logout() {
    api('/api/logout', { method: 'POST', body: {} }).then(function () { location.reload(); }).catch(function () { location.reload(); });
  }

  function changeOwnPassword() {
    var pw = h('input', { type: 'password', autocomplete: 'new-password' });
    var msg = h('div');
    var m = openModal({
      title: 'Change my password',
      body: [field('New password (at least 6 characters)', pw), msg],
      foot: [closeBtn({ close: function () { m.close(); } }, 'Cancel'), h('button', { class: 'btn primary', type: 'button', text: 'Change', onclick: function () {
        api('/api/users/' + encodeURIComponent(ME.user.username), { method: 'PUT', body: { password: pw.value } }).then(function () { location.reload(); }).catch(function (e) {
          msg.textContent = '';
          msg.appendChild(h('div', { class: 'msg bad', text: e.message }));
        });
      } })]
    });
  }

  function openUsers() {
    var m = openModal({ title: 'Users and logins', body: h('div', { class: 'note', text: 'Loading...' }), foot: null });
    function list() {
      api('/api/users').then(function (r) {
        var body = [h('div', { class: 'note', text: 'Admins can do everything. Viewers only see multiviews you publish for them; they never see your provider details or channel lists. "Max streams" is how many tiles one viewer can play at once (each distinct channel uses one provider connection; viewers of the same channel share it).' })];
        r.users.forEach(function (u) {
          body.push(h('div', { class: 'prov' },
            h('div', { class: 'name' }, h('b', { text: u.username + (u.disabled ? '  (disabled)' : '') }), h('small', { text: (u.role === 'admin' ? 'Admin' : 'Viewer') + (u.maxStreams ? '  ·  max ' + u.maxStreams + ' streams' : '  ·  no stream limit') })),
            h('button', { class: 'btn', type: 'button', text: 'Edit', onclick: function () { form(u); } })));
        });
        m.setBody(body, [
          h('button', { class: 'btn primary', type: 'button', text: 'Add user', onclick: function () { form(null); } }),
          closeBtn(m)
        ]);
        var f = $('.btn', m.box);
        if (f) f.focus();
      }).catch(function (e) { m.setBody(h('div', { class: 'msg bad', text: e.message }), closeBtn(m)); });
    }
    function form(u) {
      var f = {
        name: h('input', { type: 'text', value: u ? u.username : '', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' }),
        pass: h('input', { type: 'password', value: '', placeholder: u ? '(unchanged)' : '', autocomplete: 'new-password' }),
        role: h('select', null, h('option', { value: 'viewer', text: 'Viewer (watches published multiviews)' }), h('option', { value: 'admin', text: 'Admin (full control)' })),
        max: h('input', { type: 'number', min: '0', max: '50', value: String(u ? u.maxStreams : 9) }),
        off: h('input', { type: 'checkbox' })
      };
      f.role.value = u ? u.role : 'viewer';
      f.off.checked = !!(u && u.disabled);
      if (u) f.name.disabled = true;
      var msg = h('div');
      function fail(e) { msg.textContent = ''; msg.appendChild(h('div', { class: 'msg bad', text: e.message })); }
      m.setBody([
        h('div', { class: 'field' }, h('label', { text: 'Username' }), f.name),
        h('div', { class: 'field' }, h('label', { text: u ? 'New password (leave blank to keep)' : 'Password (at least 6 characters)' }), f.pass),
        h('div', { class: 'field' }, h('label', { text: 'Role' }), f.role),
        h('div', { class: 'field' }, h('label', { text: 'Max streams at once (0 = no limit)' }), f.max),
        u ? h('label', { class: 'check' }, f.off, h('span', { text: 'Disabled (cannot log in)' })) : null,
        msg
      ], [
        u ? h('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: function () {
          confirmBox('Delete the login "' + u.username + '"?', 'Delete', function () {
            api('/api/users/' + encodeURIComponent(u.username), { method: 'DELETE' }).then(function () { openUsers(); }).catch(function (e) { openUsers(); banner(e.message, 4000); });
          });
          m.close();
        } }) : null,
        h('button', { class: 'btn', type: 'button', text: 'Back', onclick: list }),
        h('button', { class: 'btn primary', type: 'button', text: 'Save', onclick: function () {
          var body = { role: f.role.value, maxStreams: Number(f.max.value) || 0 };
          if (f.pass.value) body.password = f.pass.value;
          if (u) {
            body.disabled = f.off.checked;
            api('/api/users/' + encodeURIComponent(u.username), { method: 'PUT', body: body }).then(list).catch(fail);
          } else {
            body.username = f.name.value.trim();
            body.password = f.pass.value;
            api('/api/users', { method: 'POST', body: body }).then(list).catch(fail);
          }
        } })
      ]);
      f.name.focus();
    }
    // First account on an open server: this turns logins on.
    if (ME && ME.open) {
      var nm = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', value: 'admin' });
      var pw = h('input', { type: 'password', autocomplete: 'new-password' });
      var msg = h('div');
      m.setBody([
        h('div', { class: 'note', text: 'Right now anyone who can reach this page can do everything. Create your admin account to turn logins on. After that, everyone has to log in, and you can add viewers and publish multiviews for them.' }),
        field('Admin username', nm), field('Password (at least 6 characters)', pw), msg
      ], [closeBtn(m, 'Not now'), h('button', { class: 'btn primary', type: 'button', text: 'Create admin and turn on logins', onclick: function () {
        api('/api/users', { method: 'POST', body: { username: nm.value.trim(), password: pw.value } }).then(function () { location.reload(); }).catch(function (e) {
          msg.textContent = '';
          msg.appendChild(h('div', { class: 'msg bad', text: e.message }));
        });
      } })]);
      pw.focus();
      return;
    }
    list();
  }

  // ---------------------------------------------------------------- init
  function init() {
    buildToolbar();
    sharedInit();
    for (var i = 0; i < SLOTS; i++) tiles.push(new Tile(i));
    applyBodyPrefs();
    renderGrid();
    applyAudio();
    updateLayoutButtons();

    document.addEventListener('keydown', onKey);
    ['mousemove', 'mousedown', 'touchstart', 'pointerdown', 'wheel'].forEach(function (ev) { document.addEventListener(ev, toolbarWake, { passive: true }); });
    ['click', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, userGesture, { passive: true }); });
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        refreshState();
        pollViews();
        if (userActive && navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(noop);
      }
    });
    window.addEventListener('pagehide', function () { tiles.forEach(function (t) { t.stop(); }); });

    if (!window.mpegts) banner('Player library (vendor/mpegts.js) failed to load');
    toolbarWake();
    boot();
  }

  function applyBodyPrefs() {
    document.body.classList.toggle('fill', S.fit === 'cover');
    document.body.classList.toggle('stats', S.stats);
    document.body.classList.toggle('showlabels', S.labels);
  }

  function boot() {
    api('/api/me').then(function (me) {
      if (me.authRequired && !me.user) { showLogin(boot); return; }
      enter(me);
    }).catch(function (e) {
      banner('Cannot reach the server: ' + e.message);
      setTimeout(boot, 3000);
    });
  }

  function enter(me) {
    banner('');
    ME = { admin: !!me.admin, user: me.user, open: !!me.open, authRequired: !!me.authRequired };
    document.body.classList.toggle('viewer', !ME.admin);
    var acct = $('#btn-acct');
    acct.textContent = ME.user ? ME.user.username : 'Logins';
    acct.hidden = !ME.user && !ME.admin;
    if (!ME.admin) {
      LS_KEY = 'mv.state.viewer.v1';
      S = loadState();
      applyBodyPrefs();
      renderGrid();
      applyAudio();
      fetchViews().then(function (list) {
        var last = '';
        try { last = localStorage.getItem('mv.lastview') || ''; } catch (e) { /* ignore */ }
        var pick = null;
        list.forEach(function (v) { if (v.id === last) pick = v; });
        if (!pick && list.length === 1) pick = list[0];
        if (pick) applyView(pick); else openViews();
      }).catch(function (e) { banner('Cannot load multiviews: ' + e.message); });
      viewPoll = setInterval(pollViews, 15000);
      setTimeout(pollEpg, 2500);
      return;
    }
    S.tiles.forEach(function (c, i) { if (c) { tiles[i].cfg = c; tiles[i].render(); if (i < visibleCount()) tiles[i].start(); } });
    sharedSync();
    updateHint();
    refreshState().then(function (s) {
      if (s && !s.providers.length) openProviders(true);
      updateHint();
    });
    pollTimer = setInterval(refreshState, 5000);
    setTimeout(pollEpg, 2500);
    if (tiles[S.sel] && !modals.length) tiles[S.sel].el.focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  // test hook (harmless in production)
  window.__mv = { get S() { return S; }, get ME() { return ME; }, applyView: applyView, tiles: tiles, LAYOUTS: LAYOUTS, setLayout: setLayout, select: select, assign: assign, toggleZoom: toggleZoom, sharedApply: sharedApply, get zoom() { return zoom; }, get modals() { return modals.length; } };
})();
