'use strict';
// Streams that bypass the server (direct play, local mode) are reported by the pages that play them, so the server can
// count the provider connections they use. Advisory only: a report that is not renewed expires by itself.
const TTL_MS = 45000;

class DirectReports {
  constructor(ttlMs) {
    this.ttl = ttlMs || TTL_MS;
    this.devices = new Map(); // device -> { at, user, streams: [{ p, kind, id, name }] }
  }

  report(device, user, streams) {
    const dev = String(device || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (!dev) return false;
    const list = (Array.isArray(streams) ? streams : []).slice(0, 12).map((s) => ({
      p: String((s && s.p) || '').slice(0, 60),
      kind: s && (s.kind === 'movie' || s.kind === 'series') ? s.kind : 'live',
      id: String((s && s.id) || '').slice(0, 40),
      name: String((s && s.name) || '').slice(0, 80),
    })).filter((s) => s.p && s.id);
    if (!list.length) this.devices.delete(dev);
    else this.devices.set(dev, { at: Date.now(), user: String(user || '').slice(0, 60), streams: list });
    return true;
  }

  prune() {
    const now = Date.now();
    for (const [k, v] of this.devices) if (now - v.at > this.ttl) this.devices.delete(k);
  }

  list() {
    this.prune();
    const out = [];
    for (const [device, v] of this.devices) for (const s of v.streams) out.push(Object.assign({ device, user: v.user }, s));
    return out;
  }

  count(providerId) {
    return this.list().filter((s) => s.p === providerId).length;
  }
}

module.exports = { DirectReports, TTL_MS };
