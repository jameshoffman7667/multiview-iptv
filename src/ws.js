'use strict';
// Minimal WebSocket (RFC 6455) server side: enough to push binary video to a browser.
// Browsers allow only ~6 plain-HTTP connections per address, but far more WebSockets, so a 9-tile
// multiview needs this. Incoming frames are only read for close/ping.
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function isUpgrade(req) {
  return String(req.headers.upgrade || '').toLowerCase() === 'websocket' && !!req.headers['sec-websocket-key'] && req.headers['sec-websocket-version'] === '13';
}

function handshake(req, socket) {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
}

function header(opcode, len) {
  if (len < 126) return Buffer.from([0x80 | opcode, len]);
  if (len < 65536) return Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]);
  const h = Buffer.alloc(10);
  h[0] = 0x80 | opcode;
  h[1] = 127;
  h.writeUInt32BE(Math.floor(len / 4294967296), 2);
  h.writeUInt32BE(len >>> 0, 6);
  return h;
}

// Looks like a response stream to the relay (write / end / destroy / writableLength / destroyed / on).
class WsSink {
  constructor(socket) {
    this.socket = socket;
    this.inbuf = Buffer.alloc(0);
    this.closing = false;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('error', () => {});
  }

  get destroyed() { return this.socket.destroyed; }
  get writableLength() { return this.socket.writableLength; }
  on(ev, fn) { this.socket.on(ev, fn); }

  write(chunk) {
    if (this.closing || this.socket.destroyed) return false;
    this.socket.cork();
    this.socket.write(header(2, chunk.length));
    this.socket.write(chunk);
    this.socket.uncork();
    return true;
  }

  close(code, reason) {
    if (this.closing || this.socket.destroyed) return;
    this.closing = true;
    const r = Buffer.from(String(reason || '').slice(0, 100));
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code || 1000, 0);
    r.copy(p, 2);
    this.socket.end(Buffer.concat([header(8, p.length), p]));
  }

  end() { this.close(1000, ''); }
  destroy() { this.socket.destroy(); }

  onData(d) {
    this.inbuf = Buffer.concat([this.inbuf, d]);
    if (this.inbuf.length > 1 << 20) return this.destroy();
    for (;;) {
      const b = this.inbuf;
      if (b.length < 2) return;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = b.readUInt32BE(2) * 4294967296 + b.readUInt32BE(6); off = 10; }
      if (len > 1 << 20) return this.destroy();
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      const mask = masked ? b.subarray(off, off + 4) : null;
      const payload = Buffer.from(b.subarray(off + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.inbuf = b.subarray(need);
      if (opcode === 8) { this.close(1000, ''); return; }
      if (opcode === 9 && !this.closing && !this.socket.destroyed) this.socket.write(Buffer.concat([header(10, payload.length), payload]));
    }
  }
}

module.exports = { isUpgrade, handshake, WsSink, header };
