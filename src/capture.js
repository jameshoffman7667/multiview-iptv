'use strict';
// Local capture sources: build the ffmpeg command line and list the devices the container can see.
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function ffmpegVersion() {
  try {
    const r = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8', timeout: 5000 });
    if (r.error || r.status !== 0) return '';
    return String(r.stdout).split('\n')[0].trim();
  } catch { return ''; }
}

// Arguments (no shell is involved, and every value was validated in config.js).
function ffmpegArgs(src) {
  const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  const [w, h] = src.size.split('x');
  const test = src.video === 'test';
  const hw = src.encoder === 'vaapi';
  if (hw) a.push('-vaapi_device', process.env.VAAPI_DEVICE || '/dev/dri/renderD128');
  if (test) {
    a.push('-re', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${src.fps}`);
  } else {
    a.push('-f', 'v4l2', '-framerate', String(src.fps), '-video_size', src.size);
    if (src.inputFormat) a.push('-input_format', src.inputFormat);
    a.push('-i', src.video);
  }
  const hasAudio = !!src.audio;
  if (hasAudio) {
    if (src.audio === 'test') a.push('-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
    else a.push('-f', 'alsa', '-ac', '2', '-ar', '48000', '-thread_queue_size', '512', '-i', src.audio);
  }
  const gop = String(Math.max(1, src.fps * 2));
  const kb = `${src.bitrate}k`;
  if (src.encoder === 'vaapi') {
    a.push('-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-b:v', kb, '-g', gop);
  } else if (src.encoder === 'nvenc') {
    a.push('-pix_fmt', 'yuv420p', '-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-b:v', kb, '-g', gop);
  } else {
    a.push('-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', kb, '-maxrate', kb, '-bufsize', `${src.bitrate * 2}k`, '-g', gop, '-sc_threshold', '0');
  }
  if (hasAudio) a.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2');
  else a.push('-an');
  a.push('-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1', '-pat_period', '0.5', 'pipe:1');
  return a;
}

// Start ffmpeg for a source. Returns { body, done, stderrTail() }; kill with done().
function start(src) {
  const child = spawn(FFMPEG, ffmpegArgs(src), { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  const exited = new Promise((resolve) => { child.on('close', (code, sig) => resolve({ code, sig })); });
  return {
    child,
    body: child.stdout,
    exited,
    stderrTail: () => err.trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300),
    kill: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } },
    error: new Promise((resolve) => { child.on('error', (e) => resolve(e)); }),
  };
}

function listDevices() {
  const video = [];
  try {
    for (const f of fs.readdirSync('/dev')) {
      if (!/^video\d+$/.test(f)) continue;
      let name = '';
      try { name = fs.readFileSync(`/sys/class/video4linux/${f}/name`, 'utf8').trim(); } catch { /* not exposed */ }
      video.push({ path: `/dev/${f}`, name });
    }
  } catch { /* no /dev listing */ }
  video.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  const audio = [];
  try {
    const txt = fs.readFileSync('/proc/asound/cards', 'utf8');
    const re = /^\s*(\d+)\s+\[([^\]]*)\]:\s*(.*)$/gm;
    let m;
    while ((m = re.exec(txt))) audio.push({ id: `hw:${m[1]},0`, name: `${m[2].trim()} - ${m[3].trim()}` });
  } catch { /* no ALSA */ }
  return { ffmpeg: ffmpegVersion(), video, audio };
}

module.exports = { ffmpegArgs, start, listDevices, ffmpegVersion };
