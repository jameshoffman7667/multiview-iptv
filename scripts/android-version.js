#!/usr/bin/env node
// Prints the Android versionCode for a MAJOR.MINOR.PATCH version:
//   versionCode = MAJOR*100000000 + MINOR*10000 + PATCH
// Fails if MINOR or PATCH is above 9999 or MAJOR is above 20 (the code would stop increasing
// or pass Google's 2,100,000,000 limit). Usage: node scripts/android-version.js 2.11.0
function versionCode(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ""));
  if (!m) throw new Error(`'${version}' is not MAJOR.MINOR.PATCH`);
  const [major, minor, patch] = [+m[1], +m[2], +m[3]];
  if (minor > 9999 || patch > 9999) throw new Error(`MINOR (${minor}) and PATCH (${patch}) must each be 9999 or less for the Android versionCode`);
  if (major > 20) throw new Error(`MAJOR (${major}) must be 20 or less for the Android versionCode`);
  return major * 100000000 + minor * 10000 + patch;
}
module.exports = { versionCode };
if (require.main === module) {
  try { console.log(versionCode(process.argv[2])); } catch (e) { console.error(e.message); process.exit(1); }
}
