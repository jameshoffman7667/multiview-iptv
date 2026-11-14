# Release v0.15.0
Update: later                    (now | later; now only when James said "build, push and update" for this release)
Image: mybadreligon/multiview-iptv:0.15.0   (also 0.15 and latest; built by the push-to-main release workflow, run https://github.com/jameshoffman7667/multiview-iptv/actions/runs/43533088553, all four jobs succeeded)
Short: Publish the Android TV app to F-Droid
Long: The Android TV APK is now named multiview-iptv-<version>.apk for the F-Droid updater, uses a higher versionCode formula, signs only with the release key (skips without it) and has a guarded manual rebuild.
Release commit: 54eae4b on main        Tag pushed from authoring session: no (the workflow created v0.15.0 with gh release create --target; release page has multiview-iptv-0.15.0.apk and iptv-multiview.apk, 5.8 MB each)
Type: minor
Port: 1234 (host = container; PORT=1234 in the image)   Exception: none. The register's target for iptv-multiview is 8043; not moved by this release.
Public hostname: unchanged by this release (see the homelab reference)        Needs Caddy route: no
New or changed env vars: none. Compose (only the image tag changes), .env.example and data format: unchanged. No manual step on the server. No new API. Server code is unchanged from 0.14.0 (image rebuilt for the new version number only).
Data: /data (accounts, providers, views, settings, fantasy.json and fantasy.key; small), /recordings (REC_DIR), /rewind (REWIND_DIR); the entrypoint chowns them to uid 1000 at start. Migration: none.
Resources: unchanged from 0.14.0 (this release changes only the Android build pipeline).
Healthcheck: unchanged. GET /healthz on $PORT -> 200 {"status":"ok","version":"0.15.0"} (JSON, no login, nothing private); compose test: wget -qO- http://127.0.0.1:$${PORT}/healthz | grep -q '\"status\":\"ok\"' || exit 1 (see deploy/compose.yaml for the exact YAML), interval 30s, timeout 5s, retries 3, start_period 30s. On vm101 use: wget -S -qO- http://127.0.0.1:1234/healthz (no curl there).
Verify after deploy:
  1. docker inspect shows "healthy" within about a minute and the logs are clean (no stack traces).
  2. wget -S -qO- http://127.0.0.1:1234/healthz returns {"status":"ok","version":"0.15.0"} with Content-Type application/json and the security headers.
  3. Nothing else changes on the server; the Android check is the Android line below.
Android: package app.iptvmultiview.tv (native Android TV / Shield app, no phone TWA, no assetlinks); versionName 0.15.0, versionCode 150000 (new rule MAJOR*100000000+MINOR*10000+PATCH); android job PASSED, signed with the release key (alias multiview); files multiview-iptv-0.15.0.apk (F-Droid) and iptv-multiview.apk (same file). The first F-Droid APK is UNTESTED until James confirms it installs and opens on the Shield.
PWA: unchanged; service worker cache is mv-shell-0.15.0 (changes with the version). Cloudflare Access bypass: none needed for the Android TV app (no assetlinks, no TWA).
Docker build: not run locally (no Docker in the authoring session); CI ran npm test (119 passed, 4 skipped), built and pushed the image and compiled and signed the APK (all four jobs succeeded). The android job read the APK back: package app.iptvmultiview.tv, versionName 0.15.0, versionCode 150000, minSdk 24, signed. Not tested: installing or opening the APK on a Shield.
Rollback: previous image tag 0.14.0 (pin whatever tag was running before this update); data restore needed? no
Known issues: the Shield app so far was debug-signed, so the first release-signed APK cannot update it: uninstall the old app once, then install from F-Droid (Droid-ify or Neo Store) and enter the server address again. The old name iptv-multiview.apk stays on each release for the README Downloader link. One UI test ("admin turns logins on, publishes...") fails in the sandbox browser run since 0.9.0 (CI does not run the browser suite).
Backup tier: small/critical (include /data in Tier 1; no SQLite, JSON files, stop during copy to be safe). /recordings and /rewind are bulk (SnapRAID only; the rewind buffer is cleared at start).
