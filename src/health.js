'use strict';
// Server health numbers for the diagnostics view (P-28): process CPU, memory, machine load, how late the event loop runs
// (a busy server delays every stream) and how many ffmpeg processes are running. Sampled every 5 s, kept in memory only.
const os = require('os');
const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');

function countFfmpeg() {
  try {
    let n = 0;
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try { if (fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim() === 'ffmpeg') n++; } catch { /* gone */ }
    }
    return n;
  } catch { return null; }
}

class Health {
  constructor() {
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
    this.last = process.cpuUsage();
    this.lastAt = Date.now();
    this.cpuPct = 0;
    this.lag = { p99: 0, max: 0 };
    this.ffmpeg = null;
    this.sampled = false;
    this.timer = setInterval(() => this.sample(), 5000);
    if (this.timer.unref) this.timer.unref();
  }

  sample() {
    const now = Date.now();
    const u = process.cpuUsage(this.last);
    const dt = Math.max(1, now - this.lastAt);
    this.cpuPct = Math.round((u.user + u.system) / 1000 / dt * 100);   // percent of ONE core
    this.last = process.cpuUsage();
    this.lastAt = now;
    // the histogram counts the 20 ms timer interval itself, so it is taken off: 0 means the loop was never late
    const late = (ns) => Math.max(0, Math.round(ns / 1e6 - 20));
    this.lag = { p99: late(this.loop.percentile(99)), max: late(this.loop.max) };
    this.loop.reset();
    this.ffmpeg = countFfmpeg();
    this.sampled = true;
  }

  snapshot() {
    if (!this.sampled || Date.now() - this.lastAt > 12000) this.sample();
    const m = process.memoryUsage();
    return {
      cpuPct: this.cpuPct,
      cores: os.cpus().length,
      load1: Math.round(os.loadavg()[0] * 100) / 100,
      rssMB: Math.round(m.rss / 1048576),
      loopLagP99Ms: this.lag.p99,
      loopLagMaxMs: this.lag.max,
      ffmpeg: this.ffmpeg,
      uptimeSec: Math.round(process.uptime()),
    };
  }

  close() { clearInterval(this.timer); this.loop.disable(); }
}

module.exports = { Health };
