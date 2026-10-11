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
    e: String(s.epg_channel_id || ''),
  }));
}

async function vodCategories(p) {
  const j = await call(p, 'get_vod_categories', 60000);
  if (!Array.isArray(j)) throw httpError(502, `${p.name}: unexpected movie category list`);
  return j.map((c) => ({ id: String(c.category_id), name: String(c.category_name || '') }));
}

async function vodStreams(p) {
  const j = await call(p, 'get_vod_streams', 180000);
  if (!Array.isArray(j)) throw httpError(502, `${p.name}: unexpected movie list`);
  return j.map((s) => ({
    i: String(s.stream_id),
    n: String(s.name || ''),
    c: String(s.category_id == null ? '' : s.category_id),
    l: typeof s.stream_icon === 'string' ? s.stream_icon : '',
    x: String(s.container_extension || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4',
  }));
}

async function seriesCategories(p) {
  const j = await call(p, 'get_series_categories', 60000);
  if (!Array.isArray(j)) throw httpError(502, `${p.name}: unexpected series category list`);
  return j.map((c) => ({ id: String(c.category_id), name: String(c.category_name || '') }));
}

async function seriesList(p) {
  const j = await call(p, 'get_series', 180000);
  if (!Array.isArray(j)) throw httpError(502, `${p.name}: unexpected series list`);
  return j.map((s) => ({
    i: String(s.series_id),
    n: String(s.name || ''),
    c: String(s.category_id == null ? '' : s.category_id),
    l: typeof s.cover === 'string' ? s.cover : '',
    x: '',
  }));
}

// { seasons: [{ season, episodes: [{ id, num, title, ext, minutes }] }] }
async function seriesInfo(p, seriesId) {
  const u = apiUrl(p, 'get_series_info');
  u.searchParams.set('series_id', String(seriesId));
  const res = await fetch(u, { headers: { 'User-Agent': ua(p), Accept: 'application/json' }, signal: AbortSignal.timeout(30000) }).catch((e) => {
    throw httpError(502, `Could not reach ${p.name}: ${(e.cause && e.cause.code) || e.message}`);
  });
  if (!res.ok) throw httpError(502, `${p.name} answered HTTP ${res.status}`);
  const j = await res.json().catch(() => null);
  const eps = j && j.episodes;
  const seasons = [];
  const groups = Array.isArray(eps) ? eps.map((list, i) => [String(i + 1), list]) : Object.entries(eps || {});
  for (const [num, list] of groups) {
    if (!Array.isArray(list)) continue;
    seasons.push({
      season: Number(num) || 0,
      episodes: list.map((e) => ({
        id: String(e.id),
        num: Number(e.episode_num) || 0,
        title: String(e.title || `Episode ${e.episode_num || ''}`).slice(0, 200),
        ext: String(e.container_extension || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4',
        minutes: e.info && Number(e.info.duration_secs) ? Math.round(Number(e.info.duration_secs) / 60) : 0,
      })).sort((a, b) => a.num - b.num),
    });
  }
  seasons.sort((a, b) => a.season - b.season);
  return { name: String((j && j.info && j.info.name) || ''), seasons };
}

function vodUrl(p, kind, id, ext) {
  const enc = encodeURIComponent;
  return `${p.url}/${kind === 'series' ? 'series' : 'movie'}/${enc(p.username)}/${enc(p.password)}/${enc(id)}.${String(ext || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4'}`;
}

async function shortEpg(p, sid, limit = 8) {
  const u = apiUrl(p, 'get_short_epg');
  u.searchParams.set('stream_id', String(sid));
  u.searchParams.set('limit', String(limit));
  const res = await fetch(u, { headers: { 'User-Agent': ua(p), Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];
  const j = await res.json().catch(() => null);
  const list = j && Array.isArray(j.epg_listings) ? j.epg_listings : [];
  const dec = (v) => { try { return Buffer.from(String(v || ''), 'base64').toString('utf8'); } catch { return ''; } };
  const looksB64 = (v) => /^[A-Za-z0-9+/=]{4,}$/.test(String(v || '')) && String(v).length % 4 === 0;
  return list.map((e) => ({
    s: Number(e.start_timestamp) || 0,
    e: Number(e.stop_timestamp) || 0,
    t: String(looksB64(e.title) ? dec(e.title) : (e.title || '')).slice(0, 200),
    d: String(looksB64(e.description) ? dec(e.description) : (e.description || '')).slice(0, 400),
  })).filter((x) => x.s && x.e && x.t);
}

function xmltvUrl(p) {
  const u = new URL(`${p.url}/xmltv.php`);
  u.searchParams.set('username', p.username);
  u.searchParams.set('password', p.password);
  return u;
}

function streamUrl(p, sid) {
  const enc = encodeURIComponent;
  const tail = p.urlStyle === 'plain' ? '' : '/live';
  return `${p.url}${tail}/${enc(p.username)}/${enc(p.password)}/${enc(sid)}.ts`;
}

module.exports = { userInfo, liveCategories, liveStreams, vodCategories, vodStreams, seriesCategories, seriesList, seriesInfo, vodUrl, shortEpg, xmltvUrl, streamUrl, ua, DEFAULT_UA };
