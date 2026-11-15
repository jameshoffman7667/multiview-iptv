# Release v0.18.0
Update: now                    (now | later; now only when James said "build, push and update" for this release)
Image: mybadreligon/multiview-iptv:0.18.0   (also 0.18 and latest; built by the push-to-main release workflow, run https://github.com/jameshoffman7667/multiview-iptv/actions/runs/43734108220, all four jobs succeeded)
Short: Add phone downloads to the Android app
Long: Phones and tablets get the download buttons; files go to Movies/Multiview via Android's download manager. A Downloaded files list plays in the app or opens elsewhere. None on TV boxes. P-32.
Release commit: f2e0c3a on main        Tag pushed from authoring session: no (the workflow created v0.18.0 with gh release create --target; the release page has only multiview-iptv-0.18.0.apk)
Type: minor
Port: 1234 (host = container; PORT=1234 in the image)   Exception: none. The register's target for iptv-multiview is 8043; not moved by this release.
Public hostname: unchanged by this release (see the homelab reference)        Needs Caddy route: no
New or changed env vars: none. Compose (only the image tag changes), .env.example and data format: unchanged. No manual step on the server. No server API change (the app reuses the P-31 ticket downloads).
Data: /data (accounts, providers, views, settings, downloads.json, fantasy.json and fantasy.key; small), /recordings (REC_DIR), /rewind (REWIND_DIR); the entrypoint chowns them to uid 1000 at start. Migration: none.
Resources: unchanged. A phone download streams through the server like a browser download and holds one provider connection (the P-31 limits apply).
Healthcheck: unchanged. GET /healthz on $PORT -> 200 {"status":"ok","version":"0.18.0"} (JSON, no login, nothing private); compose test: wget -qO- http://127.0.0.1:$${PORT}/healthz | grep -q '\"status\":\"ok\"' || exit 1 (see deploy/compose.yaml for the exact YAML), interval 30s, timeout 5s, retries 3, start_period 30s. On vm101 use: wget -S -qO- http://127.0.0.1:1234/healthz (no curl there).
Verify after deploy:
  1. docker inspect shows "healthy" within about a minute and the logs are clean (no stack traces).
  2. wget -S -qO- http://127.0.0.1:1234/healthz returns {"status":"ok","version":"0.18.0"} with Content-Type application/json and the security headers.
  3. Install multiview-iptv-0.18.0.apk on a phone (via the F-Droid repo): download buttons appear in Change channel > Movies; a download lands in Movies/Multiview with a notification; Settings > "Downloaded files..." lists it. On the Shield there are no buttons.
Android: package app.iptvmultiview.tv; versionName 0.18.0, versionCode 180000 (rule unchanged); android job PASSED (the new native code compiled), signed with the release key; the release has ONLY multiview-iptv-0.18.0.apk. NEW: download buttons on phones/tablets (the app says "not television mode and has a touch screen"), files saved to Movies/Multiview by Android's download manager, a "Downloaded files..." list in Settings (Play in the app, Open with..., Delete). Android 7-9 ask for storage permission on the first download. The APK must be installed on the phone to get this (same key, updates over the old one); the Shield shows no buttons. NOT tested on a real phone or Shield.
PWA: unchanged; service worker cache is mv-shell-0.18.0 (changes with the version). Cloudflare Access bypass: none needed.
Docker build: not run locally (no Docker in the authoring session); CI ran npm test (132 passed, 4 skipped), built and pushed the image and compiled and signed the APK (all four jobs succeeded). Browser tests ran in the sandbox: 74 passed, 1 known failure (below). Not tested: the Android code on a real device (download manager, notification, in-app playback of a saved file, the storage prompt on Android 7-9).
Rollback: previous image tag 0.17.0 (pin 0.17.0 in the compose file and pull); data restore needed? no
Known issues: direct links carry the provider login and are not counted by the server (no connection limit, no keep-one-free); only admins get them. A direct download is a copied link (browsers cannot save a cross-origin file under a name), not a file saved by the page. One UI test ("admin turns logins on, publishes...") fails in the sandbox browser run since 0.9.0 (CI does not run the browser suite).
Backup tier: small/critical (include /data in Tier 1; no SQLite, JSON files, stop during copy to be safe). /recordings and /rewind are bulk (SnapRAID only; the rewind buffer is cleared at start).
