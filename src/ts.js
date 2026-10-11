'use strict';
// MPEG-TS helpers: packet alignment, PAT/PMT learning and keyframe-aware burst start.

const PKT = 188;
const SYNC = 0x47;
const VIDEO_TYPES = new Set([0x01, 0x02, 0x10, 0x1b, 0x24, 0x42]);

// Offset of the first byte that starts a run of `need` sync bytes spaced 188 apart, or -1.
function findAlignment(buf, need = 5) {
  const maxStart = Math.min(PKT * 4, buf.length - (need - 1) * PKT - 1);
  for (let i = 0; i <= maxStart; i++) {
    let ok = true;
    for (let k = 0; k < need; k++) {
      if (buf[i + k * PKT] !== SYNC) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

function header(buf, o) {
  const pid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2];
  const pusi = (buf[o + 1] & 0x40) !== 0;
  const afc = (buf[o + 3] >> 4) & 3;
  return { pid, pusi, afc };
}

// Learns PAT/PMT (single-packet sections only) so we know which PIDs carry video.
class TsInfo {
  constructor() {
    this.pmtPids = new Set();
    this.videoPids = new Set();
  }

  feed(buf) {
    const n = Math.floor(buf.length / PKT);
    for (let i = 0; i < n; i++) {
      const o = i * PKT;
      // cheap reject: only PUSI packets of PID 0 or a known PMT PID matter
      if (!(buf[o + 1] & 0x40)) continue;
      const pid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2];
      if (pid === 0) this.parsePat(buf, o);
      else if (this.pmtPids.has(pid)) this.parsePmt(buf, o);
    }
  }

  payloadStart(buf, o) {
    const afc = (buf[o + 3] >> 4) & 3;
    if (!(afc & 1)) return -1;
    let p = o + 4;
    if (afc & 2) p += 1 + buf[o + 4];
    if (p >= o + PKT) return -1;
    p += 1 + buf[p]; // pointer_field
    return p < o + PKT ? p : -1;
  }

  parsePat(buf, o) {
    const p = this.payloadStart(buf, o);
    if (p < 0 || buf[p] !== 0x00) return;
    const len = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
    const end = p + 3 + len - 4; // exclude CRC
    if (end > o + PKT || len < 9) return;
    for (let q = p + 8; q + 4 <= end; q += 4) {
      const prog = (buf[q] << 8) | buf[q + 1];
      const pid = ((buf[q + 2] & 0x1f) << 8) | buf[q + 3];
      if (prog !== 0) this.pmtPids.add(pid);
    }
  }

  parsePmt(buf, o) {
    const p = this.payloadStart(buf, o);
    if (p < 0 || buf[p] !== 0x02) return;
    const len = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
    const end = p + 3 + len - 4;
    if (end > o + PKT || len < 13) return;
    const progInfo = ((buf[p + 10] & 0x0f) << 8) | buf[p + 11];
    let q = p + 12 + progInfo;
    while (q + 5 <= end) {
      const type = buf[q];
      const pid = ((buf[q + 1] & 0x1f) << 8) | buf[q + 2];
      const esLen = ((buf[q + 3] & 0x0f) << 8) | buf[q + 4];
      if (VIDEO_TYPES.has(type)) this.videoPids.add(pid);
      q += 5 + esLen;
    }
  }
}

// Picks the packet index a late joiner should start from. buf holds whole packets.
// Prefers the last random-access (keyframe) packet at or before targetPkt so the
// requested cushion is at least honoured, then backs up to the nearest PAT so the
// demuxer sees the program tables first.
function findBurstStart(buf, targetPkt, info) {
  const n = Math.floor(buf.length / PKT);
  if (n === 0) return 0;
  const target = Math.max(0, Math.min(n - 1, targetPkt));
  const haveVideo = info && info.videoPids.size > 0;
  let before = -1;
  let after = -1;
  for (let i = 0; i < n; i++) {
    const o = i * PKT;
    if (buf[o] !== SYNC) continue;
    const h = header(buf, o);
    if (!h.pusi || !(h.afc & 2) || buf[o + 4] === 0 || !(buf[o + 5] & 0x40)) continue;
    if (haveVideo && !info.videoPids.has(h.pid)) continue;
    if (i <= target) before = i;
    else { after = i; break; }
  }
  const k = before >= 0 ? before : after >= 0 ? after : target;
  for (let j = k; j >= Math.max(0, k - 120); j--) {
    const o = j * PKT;
    if (buf[o] !== SYNC) continue;
    const h = header(buf, o);
    if (h.pid === 0 && h.pusi) return j;
  }
  return k;
}

module.exports = { PKT, SYNC, findAlignment, TsInfo, findBurstStart };
