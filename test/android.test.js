'use strict';
// Android TV / Shield app build rules (spec v1.11 section 15, native app: no TWA, no assetlinks).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { versionCode } = require('../scripts/android-version');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const wf = read('.github/workflows/docker.yml');
const gradle = read('android/app/build.gradle');
const androidJob = wf.slice(wf.indexOf('\n  android:'));

test('versionCode = MAJOR*100000000 + MINOR*10000 + PATCH, with the limits', () => {
  assert.strictEqual(versionCode('2.11.0'), 200110000);
  assert.strictEqual(versionCode('0.15.0'), 150000);
  assert.strictEqual(versionCode('0.1.0'), 10000);
  assert.strictEqual(versionCode('20.9999.9999'), 2000000000 + 99990000 + 9999);
  assert.ok(versionCode('2.12.0') > versionCode('2.11.9999'));
  assert.throws(() => versionCode('2.10000.0'), /9999 or less/);
  assert.throws(() => versionCode('2.0.10000'), /9999 or less/);
  assert.throws(() => versionCode('21.0.0'), /20 or less/);
  assert.throws(() => versionCode('2.1'), /MAJOR\.MINOR\.PATCH/);
});

test('the new versionCode is higher than the old formula (MAJOR*10000+MINOR*100+PATCH) for every released version', () => {
  const old = (v) => { const [a, b, c] = v.split('.').map(Number); return a * 10000 + b * 100 + c; };
  for (const v of ['0.1.0', '0.4.0', '0.9.0', '0.13.0', '0.14.0', '0.14.1', '0.99.99', '1.0.0', '1.2.3', '19.99.99']) {
    assert.ok(versionCode(v) > old(v), `${v}: ${versionCode(v)} must be above ${old(v)}`);
  }
  // and it keeps rising across MINOR and MAJOR steps
  assert.ok(versionCode('0.15.0') > versionCode('0.14.9999'));
  assert.ok(versionCode('1.0.0') > versionCode('0.9999.9999'));
});

test('the CLI prints the code and fails with a message on bad input', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  assert.strictEqual(execFileSync('node', [path.join(root, 'scripts/android-version.js'), '0.15.0']).toString().trim(), '150000');
  const bad = spawnSync('node', [path.join(root, 'scripts/android-version.js'), '21.0.0']);
  assert.notStrictEqual(bad.status, 0);
});

test('package id never changes and the gradle version code comes from the workflow', () => {
  assert.match(gradle, /applicationId 'app\.iptvmultiview\.tv'/);
  assert.match(gradle, /namespace 'app\.iptvmultiview\.tv'/);
  assert.match(gradle, /versionCode appVersionCode/);
  assert.match(gradle, /minSdk 2[4-9]/);
});

test('release APK name: only multiview-iptv-<version>.apk is uploaded (a second copy breaks fdroid update)', () => {
  assert.match(androidJob, /APP: multiview-iptv/);
  assert.match(androidJob, /"\$APP-\$VERSION\.apk"/);
  assert.match(androidJob, /gh release upload "\$TAG" "\$APK" --clobber/);
  assert.doesNotMatch(wf, /cp "\$APK" iptv-multiview\.apk/);
  assert.doesNotMatch(androidJob, /gh release upload[^\n]*iptv-multiview\.apk/);
  assert.doesNotMatch(read('README.md'), /iptv-multiview\.apk/, 'the README no longer points at the old file name');
  assert.match(read('README.md'), /multiview-iptv-<version>\.apk/);
});

test('signing: only the release key, the four B64 secrets, no debug key, a green skip that names the missing secrets', () => {
  for (const s of ['ANDROID_KEYSTORE_B64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) assert.ok(androidJob.includes('secrets.' + s), s);
  assert.doesNotMatch(wf, /ANDROID_KEYSTORE_BASE64/);
  assert.match(androidJob, /Missing secrets:\$missing\. Android build skipped/);
  assert.match(androidJob, /steps\.gate\.outputs\.build == 'true'/);
  assert.doesNotMatch(gradle, /signingConfigs\.debug/);
  assert.match(gradle, /refusing to build a release APK without the release key/);
  assert.doesNotMatch(androidJob, /echo[^\n]*\$(KS|ANDROID_KEYSTORE_PASSWORD|ANDROID_KEY_PASSWORD)\b/, 'no secret is echoed');
});

test('manual rebuild: android_only, tag and overwrite inputs, the overwrite guard, the tag is checked out', () => {
  assert.match(wf, /workflow_dispatch:\n {4}inputs:\n {6}android_only:/);
  assert.match(wf, /\n {6}tag:\n/);
  assert.match(wf, /\n {6}overwrite:\n/);
  assert.match(androidJob, /is already attached to \$TAG\. Re-run with overwrite=true/);
  assert.match(androidJob, /ref: \$\{\{ steps\.ver\.outputs\.tag \}\}/);
  assert.match(androidJob, /needs: \[meta, image\]/, 'built after the image, so it never blocks the Docker release');
});

test('the APK is read back (package, signed, versionName, versionCode, minSdk) before it is published', () => {
  assert.match(androidJob, /androguard/);
  assert.match(androidJob, /app\.iptvmultiview\.tv/);
  assert.match(androidJob, /is_signed\(\)/);
  assert.match(androidJob, /node scripts\/android-version\.js/);
});

test('phone downloads (P-32, P-35): the app has its own download manager, only on phones and tablets', () => {
  const dir = 'android/app/src/main/java/app/iptvmultiview/tv/';
  const main = read(dir + 'MainActivity.java');
  const dl = read(dir + 'Downloader.java');
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(main, /public boolean downloadSupported\(\)/);
  assert.match(main, /UI_MODE_TYPE_TELEVISION/, 'a TV box says no');
  assert.match(main, /FEATURE_TOUCHSCREEN/);
  assert.match(main, /if \(ui == null\) return false;/, 'when it cannot tell, no buttons');
  for (const m of ['downloadConfig', 'downloadAdd', 'downloadStatus', 'downloadPause', 'downloadResume', 'downloadRemove', 'downloadPlay', 'downloadOpen', 'localSeek']) assert.match(main, new RegExp('public \\w+ ' + m + '\\('));
  assert.doesNotMatch(main, /DownloadManager/, 'Android\'s download manager (it paused on every drop) is no longer used');
  assert.match(dl, /"Range", "bytes=" \+ it\.done/, 'a dropped download resumes with a Range request');
  assert.match(dl, /\/api\/dl\/ticket/, 'it asks the server for tickets, so the server rules apply');
  assert.match(dl, /code == 410/, 'a stale ticket is replaced');
  assert.match(dl, /Environment\.DIRECTORY_MOVIES \+ "\/Multiview"/);
  assert.match(dl, /wifiOnly/);
  assert.match(manifest, /WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28"/, 'only Android 9 and older ask');
  assert.match(manifest, /<service[^>]*DownloadService[^>]*foregroundServiceType="dataSync"/);
  assert.match(manifest, /FOREGROUND_SERVICE_DATA_SYNC/);
  assert.match(read(dir + 'LocalPlayer.java'), /DefaultDataSource\.Factory/, 'content:// files play');
});

test('P-40: the downloader keeps one writer per file, checks the size, never shows more than 100% and keeps a copyable report', () => {
  const dl = read('android/app/src/main/java/app/iptvmultiview/tv/Downloader.java');
  assert.match(dl, /int gen;/, 'a generation number so only the newest worker writes');
  assert.match(dl, /it\.gen != g/);
  assert.match(dl, /Accept-Encoding", "identity"/, 'no transparent gzip: counted bytes must equal file bytes');
  assert.match(dl, /actual != it\.total/, 'size check at the end');
  assert.match(dl, /badSize >= 2/, 'a second wrong size fails clearly instead of saving a bad file');
  assert.match(dl, /Math\.min\(it\.done, it\.total\)/, 'progress is capped at the total');
  assert.match(dl, /o\.put\("report", report\(it\)\)/);
  assert.match(dl, /isBusy\(/, 'the same file is not queued twice');
  assert.ok(!/password|secret|token/i.test(dl.slice(dl.indexOf('private static String report'), dl.indexOf('private final Context'))), 'the report never carries credentials');
});
