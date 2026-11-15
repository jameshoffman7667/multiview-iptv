# Release v0.16.1
Update: later                    (now | later; now only when James said "build, push and update" for this release)
Image: mybadreligon/multiview-iptv:0.16.1   (also 0.16 and latest; built by the push-to-main release workflow, run https://github.com/jameshoffman7667/multiview-iptv/actions/runs/43662487392, all four jobs succeeded)
Short: Attach only the versioned APK to releases
Long: Releases carried the APK twice, so fdroid update failed on a duplicate and blocked the index. Upload only multiview-iptv-<version>.apk; README points at F-Droid or the versioned file. P-33.
Release commit: 0dad664 on main        Tag pushed from authoring session: no (the workflow created v0.16.1 with gh release create --target; the release page has only multiview-iptv-0.16.1.apk, 5.8 MB)
Type: patch
Port: 1234 (host = container; PORT=1234 in the image)   Exception: none. The register's target for iptv-multiview is 8043; not moved by this release.
Public hostname: unchanged by this release (see the homelab reference)        Needs Caddy route: no
New or changed env vars: none. Compose (only the image tag changes), .env.example and data format: unchanged. No manual step on the server. No new API. Server code is unchanged from 0.16.0 (image rebuilt for the new version number only).
Data: /data (accounts, providers, views, settings, downloads.json, fantasy.json and fantasy.key; small), /recordings (REC_DIR), /rewind (REWIND_DIR); the entrypoint chowns them to uid 1000 at start. Migration: none.
Resources: unchanged from 0.16.0 (this release changes only the Android release pipeline).
Healthcheck: unchanged. GET /healthz on $PORT -> 200 {"status":"ok","version":"0.16.1"} (JSON, no login, nothing private); compose test: wget -qO- http://127.0.0.1:$${PORT}/healthz | grep -q '\"status\":\"ok\"' || exit 1 (see deploy/compose.yaml for the exact YAML), interval 30s, timeout 5s, retries 3, start_period 30s. On vm101 use: wget -S -qO- http://127.0.0.1:1234/healthz (no curl there).
Verify after deploy:
  1. docker inspect shows "healthy" within about a minute and the logs are clean (no stack traces).
  2. wget -S -qO- http://127.0.0.1:1234/healthz returns {"status":"ok","version":"0.16.1"} with Content-Type application/json and the security headers.
  3. After deleting iptv-multiview.apk from v0.16.0 on the release page, run the F-Droid sync: it must finish without "is a duplicate" and list multiview-iptv-0.16.1.apk.
Android: package app.iptvmultiview.tv (native Android TV / Shield app, no phone TWA, no assetlinks); versionName 0.16.1, versionCode 160001 (rule MAJOR*100000000+MINOR*10000+PATCH, unchanged); android job PASSED, signed with the release key (alias multiview, unchanged); the release has ONLY multiview-iptv-0.16.1.apk (iptv-multiview.apk is no longer attached, so fdroid update no longer sees a duplicate). v0.16.0 still has its two assets until James deletes iptv-multiview.apk there. The README no longer links the old file name; a Downloader shortcut on the Shield that used releases/latest/download/iptv-multiview.apk will stop working (use the F-Droid repo).
PWA: unchanged; service worker cache is mv-shell-0.16.1 (changes with the version). Cloudflare Access bypass: none needed.
Docker build: not run locally (no Docker in the authoring session); CI ran npm test (130 passed, 4 skipped), built and pushed the image and compiled and signed the APK (all four jobs succeeded). Not tested: installing the APK, or an fdroid update run on the server with this release.
Rollback: previous image tag 0.16.0 (pin whatever tag was running before this update); data restore needed? no
Known issues: one UI test ("admin turns logins on, publishes...") fails in the sandbox browser run since 0.9.0 (CI does not run the browser suite). A browser cannot report when a file finishes, so a download shows as finished when the server has sent it all; a cancelled browser download is marked failed. Downloads count as one provider connection each and wait if only one is left.
Backup tier: small/critical (include /data in Tier 1; no SQLite, JSON files, stop during copy to be safe). /recordings and /rewind are bulk (SnapRAID only; the rewind buffer is cleared at start).
