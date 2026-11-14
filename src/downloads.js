'use strict';
// Downloads of movies and episodes to a device (P-31). A browser cannot tell the page when a download ends, so the page asks the
// server for a one-time ticket first; the server counts running downloads (tickets and open downloads), applies the server-wide
// cap and keeps one provider connection free for watching, and tells the page which of its downloads are still running.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TICKET_MS = 60 * 1000; // a ticket must be used within a minute
const KEEP_MS = 10 * 60 * 1000; // finished jobs stay visible this long
const MAX_CAP = 50;

class Downloads {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'downloads.json');
    this.cap = 0; // server-wide limit of running downloads, 0 = off
    this.jobs = new Map(); // id -> { id, user, p, name, state: ticket|active|done|failed|expired, at }
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.cap = Downloads.cleanCap(j.cap);
    } catch { /* first start */ }
  }

  static cleanCap(v) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_CAP) : 0;
  }

  setCap(v) {
    this.cap = Downloads.cleanCap(v);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ cap: this.cap }));
    fs.renameSync(tmp, this.file);
    return this.cap;
  }

  prune(now = Date.now()) {
    for (const [id, j] of this.jobs) {
      if (j.state === 'ticket' && now - j.at > TICKET_MS) { j.state = 'expired'; j.at = now; } else if (j.state !== 'ticket' && j.state !== 'active' && now - j.at > KEEP_MS) this.jobs.delete(id);
    }
  }

  running(pred = () => true) {
    this.prune();
    let n = 0;
    for (const j of this.jobs.values()) if ((j.state === 'ticket' || j.state === 'active') && pred(j)) n++;
    return n;
  }
  runningAll() { return this.running(); }
  pendingTickets(providerId) { this.prune(); let n = 0; for (const j of this.jobs.values()) if (j.state === 'ticket' && j.p === providerId) n++; return n; }

  // Why a new download must wait now ('' = it may start). used = connections the provider already has in use.
  mustWait(provider, used) {
    if (this.cap > 0 && this.runningAll() >= this.cap) return `the server allows ${this.cap} download${this.cap === 1 ? '' : 's'} at once`;
    const max = Math.max(1, provider.maxConnections || 1);
    const free = max - used - this.pendingTickets(provider.id);
    const need = max > 1 ? 2 : 1; // keep one connection free for watching (a 1-connection provider can only be used when idle)
    if (free < need) return `${provider.name} needs a free connection for watching`;
    return '';
  }

  ticket(user, providerId, name) {
    const id = crypto.randomBytes(8).toString('hex');
    this.jobs.set(id, { id, user, p: providerId, name: String(name || '').slice(0, 120), state: 'ticket', at: Date.now() });
    return id;
  }

  valid(id, user) {
    this.prune();
    const j = this.jobs.get(String(id || ''));
    return !!j && j.user === user && j.state !== 'expired';
  }
  start(id) { const j = this.jobs.get(id); if (j && j.state === 'ticket') { j.state = 'active'; j.at = Date.now(); } }
  end(id, ok) { const j = this.jobs.get(id); if (j && j.state === 'active') { j.state = ok ? 'done' : 'failed'; j.at = Date.now(); } }

  states(user) {
    this.prune();
    const o = {};
    for (const j of this.jobs.values()) if (j.user === user) o[j.id] = j.state;
    return o;
  }
}

module.exports = { Downloads, MAX_CAP };
