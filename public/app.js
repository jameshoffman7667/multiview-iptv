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
    var d = { layout: '3x3', tiles: [], sel: 0, muted: false, bufSec: 4, transport: 'auto', fit: 'contain', failover: true, workers: true, stats: false, labels: false, favs: {} };
    var j = {};
    try { j = JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { j = {}; }
    Object.keys(d).forEach(function (k) { if (j[k] !== undefined && typeof j[k] === typeof d[k]) d[k] = j[k]; });
    if (!LAYOUTS[d.layout]) d.layout = '3x3';
    var tiles = Array.isArray(j.tiles) ? j.tiles : [];
    d.tiles = [];
    for (var i = 0; i < SLOTS; i++) {
      var t = tiles[i];
      d.tiles.push(t && typeof t.p === 'string' && t.sid != null ? { p: t.p, sid: String(t.sid), name: String(t.name || ''), icon: String(t.icon || '') } : null);
    }
    d.sel = clamp(Math.floor(d.sel) || 0, 0, SLOTS - 1);
    d.bufSec = clamp(Number(d.bufSec) || 0, 0, 30);
    return d;
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
    this.label = h('div', { class: 'label' });
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
    this.label.textContent = c ? c.name || ('Channel ' + c.sid) : '';
    this.video.style.visibility = c ? '' : 'hidden';
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

  Tile.prototype.start = function () {
    this.stop();
    if (!this.cfg || !this.visible) { this.render(); return; }
    var self = this;
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
    var path = encodeURIComponent(c.p) + '/' + encodeURIComponent(c.sid) + '.ts?buf=' + S.bufSec + (S.failover ? '' : '&failover=0');
    var url = useWs ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/stream/' + path : location.origin + '/stream/' + path;
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
      this.setStatus('Player error: ' + e.message, true);
      return;
    }
    player.on(mp.Events.ERROR, function (type, detail, info) { if (gen === self.gen) self.onError(type, detail, info); });
    player.on(mp.Events.LOADING_COMPLETE, function () { if (gen === self.gen) self.onError('ended'); });
    player.attachMediaElement(this.video);
    player.load();
    this.player = player;
    this.tickTimer = setInterval(function () { self.tick(); }, 400);
    applyAudio();
  };

  Tile.prototype.stop = function () {
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
      var need = buf > 0 ? Math.min(buf, 12) * 0.8 : 0;
      var waited = now - this.phaseAt;
      if (ahead > 0.05 && (ahead >= need || waited > (buf * 2 + 4) * 1000)) this.beginPlay();
      else if (waited > 25000) this.onError('timeout');
      else this.setStatus(ahead > 0.05 && buf > 0 ? 'Buffering ' + ahead.toFixed(1) + ' / ' + need.toFixed(1) + ' s' : 'Connecting...');
    } else if (this.phase === 'playing') {
      if (v.paused && !v.ended && now - this.playingSince > 1000) { try { var pr = v.play(); if (pr && pr.catch) pr.catch(noop); } catch (e) { /* ignore */ } }
      if (buf > 0 && this.hasPlayed && ahead < 0.15 && !v.paused) {
        v.pause();
        this.phase = 'rebuffer';
        this.phaseAt = now;
        this.setStatus('Buffering...');
      } else if (ahead > buf + 8) {
        var b = v.buffered;
        if (b.length) v.currentTime = Math.max(b.start(b.length - 1), b.end(b.length - 1) - Math.max(buf, 1)); // drifted behind live: catch up
      } else if (this.hasPlayed && now - this.lastTime > 12000 && !v.paused) {
        this.onError('stalled');
        return;
      }
      if ((this.retry || this.mediaErrors) && now - this.playingSince > 20000) { this.retry = 0; this.mediaErrors = 0; }
    } else if (this.phase === 'rebuffer') {
      var need2 = Math.min(Math.max(buf, 1), 3);
      var w2 = now - this.phaseAt;
      if (ahead >= need2 || (w2 > 8000 && ahead > 0.3)) this.beginPlay();
      else if (w2 > 30000) this.onError('timeout');
    }
    if (document.body.classList.contains('stats')) {
      var q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      this.stats.textContent = (v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : '--') + '  buffer ' + ahead.toFixed(1) + 's' + (q ? '  dropped ' + q.droppedVideoFrames : '') + '  ' + this.phase;
    }
  };

  Tile.prototype.setZoomPaused = function (p) {
    if (p === this.zoomPaused) return;
    this.zoomPaused = p;
    if (p) { try { this.video.pause(); } catch (e) { /* ignore */ } }
    else if (this.player) { this.phase = 'rebuffer'; this.phaseAt = Date.now(); }
  };

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
    }, 4500);
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
      s.providers.forEach(function (p) { if (p.enabled) { used += p.active; max += p.max; } });
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
      act('Reload stream', function () { t.reload(); });
      if (isAdmin()) act(S.favs[fk] ? 'Remove from favorites' : 'Add to favorites', function () { toggleFav(c); });
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
  function openPicker(slot) {
    var pst = { prov: '', cat: '', q: '', favs: false, limit: 100, provs: [] };
    var provSel = h('select', { 'aria-label': 'Provider' });
    var catSel = h('select', { 'aria-label': 'Category' });
    var search = h('input', { type: 'text', class: 'search', placeholder: 'Search channels', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    var favBtn = h('button', { class: 'btn', type: 'button', text: 'Favorites' });
    var refBtn = h('button', { class: 'btn', type: 'button', text: 'Refresh' });
    var info = h('div', { class: 'note' });
    var listEl = h('div', { class: 'chlist' });
    var loading = 0;
    var errors = {};
    var m;

    function selectedProviders() { return pst.prov ? pst.provs.filter(function (p) { return p.id === pst.prov; }) : pst.provs.filter(function (p) { return p.enabled; }); }

    function fillCats() {
      catSel.textContent = '';
      catSel.appendChild(h('option', { value: '', text: 'All categories' }));
      var seen = {};
      var any = false;
      selectedProviders().forEach(function (p) {
        var c = chanCache[p.id];
        if (!c) return;
        c.catNames.forEach(function (n) { if (!seen[n]) { seen[n] = true; any = true; catSel.appendChild(h('option', { value: n, text: n })); } });
      });
      catSel.disabled = !any;
      catSel.value = pst.cat;
      if (catSel.value !== pst.cat) { pst.cat = ''; catSel.value = ''; }
    }

    function load(refresh) {
      var provs = selectedProviders();
      provs.forEach(function (p) {
        if (chanCache[p.id] && !refresh) return;
        loading++;
        delete errors[p.id];
        loadChannels(p.id, refresh).catch(function (e) { errors[p.id] = e.message; }).then(function () { loading--; fillCats(); render(); });
      });
      fillCats();
      render();
    }

    function matches() {
      var toks = pst.q.toLowerCase().split(/\s+/).filter(Boolean);
      var out = [];
      function ok(ln) { for (var i = 0; i < toks.length; i++) if (ln.indexOf(toks[i]) < 0) return false; return true; }
      if (pst.favs) {
        Object.keys(S.favs).forEach(function (k) {
          var f = S.favs[k];
          if (pst.prov && f.p !== pst.prov) return;
          if (ok((f.name || '').toLowerCase())) out.push({ p: f.p, sid: f.sid, name: f.name, icon: f.icon });
        });
      } else {
        selectedProviders().forEach(function (p) {
          var c = chanCache[p.id];
          if (!c) return;
          for (var i = 0; i < c.list.length && out.length < 3000; i++) {
            var ch = c.list[i];
            if (pst.cat && ch.cn !== pst.cat) continue;
            if (toks.length && !ok(ch.ln)) continue;
            out.push({ p: p.id, sid: ch.i, name: ch.n, icon: ch.l });
          }
        });
      }
      if (pst.q) out.sort(function (a, b) { return a.name.localeCompare(b.name); });
      return out;
    }

    function provName(id) { for (var i = 0; i < pst.provs.length; i++) if (pst.provs[i].id === id) return pst.provs[i].name; return id; }

    function render() {
      listEl.textContent = '';
      var res = matches();
      var errTxt = Object.keys(errors).map(function (id) { return provName(id) + ': ' + errors[id]; }).join(' | ');
      info.textContent = (loading ? 'Loading channel lists... ' : '') + (errTxt ? errTxt + ' ' : '') + (loading ? '' : res.length + ' channel' + (res.length === 1 ? '' : 's') + (res.length >= 3000 ? '+' : ''));
      res.slice(0, pst.limit).forEach(function (r) {
        var fav = !!S.favs[favKey(r)];
        var pick = h('button', { class: 'pick', type: 'button', onclick: function () { choose(r); } },
          r.icon ? h('img', { src: r.icon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: function (e) { var im = e.target; var ph = h('span', { class: 'noimg' }); if (im.parentNode) im.parentNode.replaceChild(ph, im); } }) : h('span', { class: 'noimg' }),
          h('span', { class: 'nm', text: r.name || ('Channel ' + r.sid) }),
          pst.provs.length > 1 ? h('span', { class: 'chip', text: provName(r.p) }) : null);
        var star = h('button', { class: 'star' + (fav ? ' on' : ''), type: 'button', title: 'Favorite', text: fav ? '\u2605' : '\u2606', onclick: function () { toggleFav(r); var on = !!S.favs[favKey(r)]; star.classList.toggle('on', on); star.textContent = on ? '\u2605' : '\u2606'; } });
        listEl.appendChild(h('div', { class: 'ch' }, pick, star));
      });
      if (res.length > pst.limit) {
        listEl.appendChild(h('div', { class: 'more-row' }, h('button', { class: 'btn', type: 'button', text: 'Show more (' + (res.length - pst.limit) + ' left)', onclick: function () { pst.limit += 150; render(); } })));
      }
    }

    function choose(r) {
      m.close();
      assign(slot, { p: r.p, sid: String(r.sid), name: r.name, icon: r.icon || '' });
      select(slot);
    }

    // arrow keys inside the list: up/down between rows, left/right between channel and star
    listEl.addEventListener('keydown', function (e) {
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
      } else if (e.key === 'ArrowRight' && col === 'pick') { e.preventDefault(); e.stopPropagation(); row.querySelector('.star').focus(); }
      else if (e.key === 'ArrowLeft' && col === 'star') { e.preventDefault(); e.stopPropagation(); row.querySelector('.pick').focus(); }
    });

    var qTimer = null;
    search.addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(function () { pst.q = search.value.trim(); pst.limit = 100; render(); }, 150); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var first = listEl.querySelector('.pick'); if (first) { e.preventDefault(); first.click(); } }
    });
    provSel.addEventListener('change', function () { pst.prov = provSel.value; pst.cat = ''; pst.limit = 100; load(false); });
    catSel.addEventListener('change', function () { pst.cat = catSel.value; pst.limit = 100; render(); });
    favBtn.addEventListener('click', function () { pst.favs = !pst.favs; favBtn.classList.toggle('on', pst.favs); pst.limit = 100; render(); });
    refBtn.addEventListener('click', function () { delete chanCache[pst.prov || '']; pst.provs.forEach(function (p) { if (!pst.prov || p.id === pst.prov) delete chanCache[p.id]; }); load(true); });

    var cur = S.tiles[slot];
    m = openModal({
      title: 'Choose channel for tile ' + (slot + 1),
      wide: true,
      body: [h('div', { class: 'filters' }, provSel, catSel), h('div', { class: 'pickerbar' }, search, favBtn, refBtn), info, listEl],
      foot: [cur ? h('button', { class: 'btn', type: 'button', text: 'Remove channel', onclick: function () { m.close(); assign(slot, null); } }) : null,
        h('button', { class: 'btn', type: 'button', text: 'Close', onclick: function () { m.close(); } })],
      focus: '.search'
    });

    getProviders().then(function (provs) {
      pst.provs = provs;
      provSel.appendChild(h('option', { value: '', text: provs.length > 1 ? 'All providers' : (provs[0] ? provs[0].name : 'No providers') }));
      if (provs.length > 1) provs.forEach(function (p) { provSel.appendChild(h('option', { value: p.id, text: p.name + (p.enabled ? '' : ' (off)') })); });
      if (provs.length === 1) pst.prov = provs[0].id;
      if (!provs.length) { info.textContent = 'No providers yet. Add one under Providers.'; return; }
      load(false);
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
    var bufSel = h('select');
    [[0, 'Off (lowest delay, may stutter)'], [2, '2 seconds'], [4, '4 seconds (default)'], [8, '8 seconds'], [15, '15 seconds (slow links)']].forEach(function (o) {
      bufSel.appendChild(h('option', { value: String(o[0]), text: o[1] }));
    });
    bufSel.value = String(S.bufSec);
    if (bufSel.value !== String(S.bufSec)) { bufSel.appendChild(h('option', { value: String(S.bufSec), text: S.bufSec + ' seconds' })); bufSel.value = String(S.bufSec); }
    bufSel.addEventListener('change', function () { S.bufSec = Number(bufSel.value); saveSoon(); });
    var trSel = h('select', null, h('option', { value: 'auto', text: 'WebSocket (recommended: 9 streams at once)' }), h('option', { value: 'http', text: 'Plain HTTP (browsers allow only about 6 streams)' }));
    trSel.value = S.transport === 'http' ? 'http' : 'auto';
    trSel.addEventListener('change', function () { S.transport = trSel.value; wsBlocked = false; wsFails = 0; saveSoon(); });
    var fitSel = h('select', null, h('option', { value: 'contain', text: 'Fit (black bars, nothing cropped)' }), h('option', { value: 'cover', text: 'Fill (crops edges)' }));
    fitSel.value = S.fit;
    fitSel.addEventListener('change', function () { S.fit = fitSel.value; document.body.classList.toggle('fill', S.fit === 'cover'); saveSoon(); });
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
        field('Buffer before playing (smoother, adds delay)', bufSel),
        field('Video', fitSel),
        field('Stream delivery (applies when a stream reconnects)', trSel),
        check('Use another provider when the chosen one is full', 'failover', function () { tiles.forEach(function (t) { if (t.cfg && t.retry) t.start(); }); }),
        check('Use web workers (lighter on the page; turn off if video will not start)', 'workers'),
        check('Show stats on tiles', 'stats', function () { document.body.classList.toggle('stats', S.stats); }),
        check('Always show channel names', 'labels', function () { document.body.classList.toggle('showlabels', S.labels); }),
        h('div', { class: 'note', text: 'Buffer and failover apply the next time a stream (re)connects.' }),
        keys
      ],
      foot: [
        !isAdmin() ? null : h('button', { class: 'btn', type: 'button', text: 'Clear all tiles', onclick: function () { m.close(); S.tiles = S.tiles.map(function () { return null; }); tiles.forEach(function (t) { t.setCfg(null); }); saveSoon(); updateHint(); } }),
        h('button', { class: 'btn', type: 'button', text: 'Restart all streams', onclick: function () { m.close(); tiles.forEach(function (t) { t.reload(); }); } }),
        h('button', { class: 'btn', type: 'button', text: 'Close', onclick: function () { m.close(); } })
      ]
    });
  }

  // ---------------------------------------------------------------- providers
  function openProviders(intro) {
    var m = openModal({ title: 'Providers', body: h('div', null, h('div', { class: 'note', text: 'Loading...' })), foot: null });
    function done() { providersCache = null; chanCache = {}; refreshState(); }

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
            h('div', { class: 'name' }, h('b', { text: p.name + (p.enabled ? '' : '  (off)') }), h('small', { text: host(p.url) + '  ·  ' + active + ' of ' + p.maxConnections + ' connection' + (p.maxConnections === 1 ? '' : 's') + ' in use' }),
              h('div', { class: 'bar' }, h('i', { class: active >= p.maxConnections ? 'full' : '', style: 'width:' + Math.min(100, Math.round(100 * active / Math.max(1, p.maxConnections))) + '%' }))),
            h('button', { class: 'btn', type: 'button', text: 'Edit', onclick: function () { form(p, provs); } })));
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
      case 'c': case 'C': if (isAdmin()) openPicker(S.sel); break;
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
      var c = v.tiles[i] || null;
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
      out.push(t ? { p: t.p, sid: String(t.sid), name: t.name || '', icon: t.icon || '' } : null);
    }
    return out;
  }

  // copy a published multiview onto the admin's own screen to edit it
  function loadIntoGrid(v) {
    S.layout = LAYOUTS[v.layout] ? v.layout : '3x3';
    zoom = -1;
    for (var i = 0; i < SLOTS; i++) {
      var c = v.tiles[i] || null;
      S.tiles[i] = c ? { p: c.p, sid: String(c.sid), name: c.name || '', icon: c.icon || '' } : null;
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
    for (var i = 0; i < SLOTS; i++) tiles.push(new Tile(i));
    applyBodyPrefs();
    renderGrid();
    applyAudio();
    updateLayoutButtons();

    document.addEventListener('keydown', onKey);
    ['mousemove', 'mousedown', 'touchstart', 'pointerdown'].forEach(function (ev) { document.addEventListener(ev, toolbarWake, { passive: true }); });
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
      return;
    }
    S.tiles.forEach(function (c, i) { if (c) { tiles[i].cfg = c; tiles[i].render(); if (i < visibleCount()) tiles[i].start(); } });
    updateHint();
    refreshState().then(function (s) {
      if (s && !s.providers.length) openProviders(true);
      updateHint();
    });
    pollTimer = setInterval(refreshState, 5000);
    if (tiles[S.sel] && !modals.length) tiles[S.sel].el.focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  // test hook (harmless in production)
  window.__mv = { get S() { return S; }, get ME() { return ME; }, applyView: applyView, tiles: tiles, LAYOUTS: LAYOUTS, setLayout: setLayout, select: select, assign: assign, get zoom() { return zoom; }, get modals() { return modals.length; } };
})();
