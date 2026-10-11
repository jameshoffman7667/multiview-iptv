'use strict';
const { httpError } = require('./config');

const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';

function ua(p) { return p.userAgent || process.env.USER_AGENT || DEFAULT_UA; }

function apiUrl(p, action) {
  const u = new URL(`${p.url}/player_api.php`);
  u.searchParams.set('username', p.username);
  u.searchParams.set('password', p.password);
  if (action) u.searchParams.set('action', action);
  return u;
}

async function call(p, action, timeoutMs = 30000) {
  let res;
  try {
    res = await fetch(apiUrl(p, action), {
      headers: { 'User-Agent': ua(p), Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'timed out' : (e.cause && e.cause.code) || e.message;
    throw httpError(502, `Could not reach ${p.name}: ${why}`);
  }
  if (!res.ok) throw httpError(502, `${p.name} answered HTTP ${res.status}`);
  try { return await res.json(); } catch { throw httpError(502, `${p.name} did not return JSON (wrong URL or blocked?)`); }
}

async function userInfo(p) {
  const j = await call(p, '', 20000);
  const ui = j && j.user_info;
  if (!ui || ui.auth === 0 || ui.auth === '0') throw httpError(401, `${p.name}: login rejected (check username/password)`);
  const exp = Number(ui.exp_date);
  return {
    status: String(ui.status || 'unknown'),
    maxConnections: Number(ui.max_connections) || 0,
    activeConnections: Number(ui.active_cons) || 0,
    expires: Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000).toISOString().slice(0, 10) : null,
  };
}

async function liveCategories(p) {
  const j = await call(p, 'get_live_categories', 60000);
  if (!Array.isArray(j)) throw httpError(502, `${p.name}: unexpected category list`);
  return j.map((c) => ({ id: String(c.category_id), name: String(c.category_name || '') }));
}

async function liveStreams(p) {
  const j = await call(p, 'get_live_streams', 120000);
  if (!Array.isArray(j)) throw httpError(502, `${p.name}: unexpected channel list`);
  return j.map((s) => ({
    i: String(s.stream_id),
    n: String(s.name || ''),
    c: String(s.category_id == null ? '' : s.category_id),
    l: typeof s.stream_icon === 'string' ? s.stream_icon : '',
  }));
}

function streamUrl(p, sid) {
  const enc = encodeURIComponent;
  const tail = p.urlStyle === 'plain' ? '' : '/live';
  return `${p.url}${tail}/${enc(p.username)}/${enc(p.password)}/${enc(sid)}.ts`;
}

module.exports = { userInfo, liveCategories, liveStreams, streamUrl, ua, DEFAULT_UA };
