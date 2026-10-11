'use strict';
const { PKT } = require('./ts');

// Circular byte buffer that only ever holds whole 188-byte packets, so any tail()
// of a packet-multiple length starts on a packet boundary.
class Ring {
  constructor(bytes) {
    this.cap = Math.max(PKT * 64, Math.floor(bytes / PKT) * PKT);
    this.buf = null;
    this.pos = 0;
    this.size = 0;
  }

  clear() {
    this.pos = 0;
    this.size = 0;
  }

  write(chunk) {
    if (!this.buf) this.buf = Buffer.allocUnsafe(this.cap);
    const src = chunk.length > this.cap ? chunk.subarray(chunk.length - this.cap) : chunk;
    const first = Math.min(src.length, this.cap - this.pos);
    src.copy(this.buf, this.pos, 0, first);
    if (first < src.length) src.copy(this.buf, 0, first);
    this.pos = (this.pos + src.length) % this.cap;
    this.size = Math.min(this.cap, this.size + src.length);
  }

  // Copy of the newest n bytes (rounded down to whole packets, capped at what we hold).
  tail(n) {
    n = Math.min(Math.floor(n / PKT) * PKT, this.size);
    if (n <= 0) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(n);
    const start = (this.pos - n + this.cap) % this.cap;
    const first = Math.min(n, this.cap - start);
    this.buf.copy(out, 0, start, start + first);
    if (first < n) this.buf.copy(out, first, 0, n - first);
    return out;
  }
}

module.exports = { Ring };
