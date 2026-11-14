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

test('release APK name: multiview-iptv-<version>.apk is uploaded, the old iptv-multiview.apk stays for the README link', () => {
  assert.match(androidJob, /APP: multiview-iptv/);
  assert.match(androidJob, /"\$APP-\$VERSION\.apk"/);
  assert.match(androidJob, /gh release upload "\$TAG" "\$APK" iptv-multiview\.apk --clobber/);
  assert.match(read('README.md'), /iptv-multiview\.apk/);
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
