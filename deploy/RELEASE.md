# Release v0.19.1
Update: now                    (now | later; now only when James said "build, push and update" for this release)
Image: mybadreligon/multiview-iptv:0.19.1   (also 0.19 and latest; built by the push-to-main release workflow, run https://github.com/jameshoffman7667/multiview-iptv/actions/runs/43744612122, all four jobs succeeded)
Short: Show when a live screen is behind after being away
Long: Closing the app froze the page while video resumed from the old spot but showed live. Away time now counts as behind live (up to the rewind buffer), LIVE turns grey, and red LIVE reconnects. P-36.
Release commit: 9b60e10 on main        Tag pushed from authoring session: no (the workflow created v0.19.1 with gh release create --target; the release page has only multiview-iptv-0.19.1.apk)
Type: patch
Port: 1234 (host = container; PORT=1234 in the image)   Exception: none. The register's target for iptv-multiview is 8043; not moved by this release.
Public hostname: unchanged by this release (see the homelab reference)        Needs Caddy route: no
New or changed env vars: none. Compose (only the image tag changes), .env.example and data format: unchanged. No manual step on the server. No API change (the page uses the existing /api/rewind).
Data: /data (accounts, providers, views, settings, downloads.json, fantasy.json and fantasy.key; small), /recordings (REC_DIR), /rewind (REWIND_DIR); the entrypoint chowns them to uid 1000 at start. Migration: none.
Resources: unchanged.
Healthcheck: unchanged. GET /healthz on $PORT -> 200 {"status":"ok","version":"0.19.1"} (JSON, no login, nothing private); compose test: wget -qO- http://127.0.0.1:$${PORT}/healthz | grep -q '\"status\":\"ok\"' || exit 1 (see deploy/compose.yaml for the exact YAML), interval 30s, timeout 5s, retries 3, start_period 30s. On vm101 use: wget -S -qO- http://127.0.0.1:1234/healthz (no curl there).
Verify after deploy:
  1. docker inspect shows "healthy" within about a minute and the logs are clean (no stack traces).
  2. wget -S -qO- http://127.0.0.1:1234/healthz returns {"status":"ok","version":"0.19.1"} with Content-Type application/json and the security headers.
  3. Watch a live channel in the Android app, close the app for a minute, reopen it: a banner says how far behind live it is, the bar shows the offset and the LIVE button is grey; tapping LIVE catches up.
Android: package app.iptvmultiview.tv; versionName 0.19.1, versionCode 190001 (rule unchanged); android job PASSED, signed with the release key; the release has ONLY multiview-iptv-0.19.1.apk. No native change: the fix is in the page, which the app loads from the server, so the app gets it as soon as the server is on 0.19.1 (a new APK is not needed for it).
PWA: unchanged; service worker cache is mv-shell-0.19.1 (changes with the version). Cloudflare Access bypass: none needed.
Docker build: not run locally (no Docker in the authoring session); CI ran npm test (133 passed, 4 skipped), built and pushed the image and compiled and signed the APK (all four jobs succeeded). Browser tests ran in the sandbox: 75 passed, 1 known failure (below); the "guide: grid with programmes" test failed once in a full run and passed three times alone (timing, not related). Not tested: closing the real Android app and coming back.
Rollback: previous image tag 0.19.0 (pin 0.19.0 in the compose file and pull); data restore needed? no
Known issues: direct links carry the provider login and are not counted by the server (no connection limit, no keep-one-free); only admins get them. A direct download is a copied link (browsers cannot save a cross-origin file under a name), not a file saved by the page. One UI test ("admin turns logins on, publishes...") fails in the sandbox browser run since 0.9.0 (CI does not run the browser suite).
Backup tier: small/critical (include /data in Tier 1; no SQLite, JSON files, stop during copy to be safe). /recordings and /rewind are bulk (SnapRAID only; the rewind buffer is cleared at start).
