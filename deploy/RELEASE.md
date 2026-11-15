# Release v0.20.0
Update: now                    (now | later; now only when James said "build, push and update" for this release)
Image: mybadreligon/multiview-iptv:0.20.0   (also 0.20 and latest; built by the push-to-main release workflow, run https://github.com/jameshoffman7667/multiview-iptv/actions/runs/43776882479, all four jobs succeeded)
Short: Ticker sizes, grouped settings, download fixes
Long: P-39 downloads bar and phone section, P-40 downloader size checks, P-41/44/45 ticker and pop-up sizes, P-46/47 projections, P-48 settings groups, P-51 menu resume, P-52 direct stream report.
Release commit: 1ece607 on main        Tag pushed from authoring session: no (the workflow created v0.20.0 with gh release create --target; the release page has only multiview-iptv-0.20.0.apk)
Type: minor
Port: 1234 (host = container; PORT=1234 in the image)   Exception: none. The register's target for iptv-multiview is 8043; not moved by this release.
Public hostname: unchanged by this release (see the homelab reference)        Needs Caddy route: no
New or changed env vars: none. Compose (only the image tag changes), .env.example and data format: unchanged. No manual step on the server. New API: POST /api/direct/report (admins) and extra fields in GET /api/state (direct, directStreams); both additive.
Data: /data (accounts, providers, views, settings, downloads.json, fantasy.json and fantasy.key; small), /recordings (REC_DIR), /rewind (REWIND_DIR); the entrypoint chowns them to uid 1000 at start. Migration: none.
Resources: unchanged.
Healthcheck: unchanged. GET /healthz on $PORT -> 200 {"status":"ok","version":"0.19.1"} (JSON, no login, nothing private); compose test: wget -qO- http://127.0.0.1:$${PORT}/healthz | grep -q '\"status\":\"ok\"' || exit 1 (see deploy/compose.yaml for the exact YAML), interval 30s, timeout 5s, retries 3, start_period 30s. On vm101 use: wget -S -qO- http://127.0.0.1:1234/healthz (no curl there).
Verify after deploy:
  1. docker inspect shows "healthy" within about a minute and the logs are clean (no stack traces).
  2. wget -S -qO- http://127.0.0.1:1234/healthz returns {"status":"ok","version":"0.20.0"} with Content-Type application/json and the security headers.
  3. Open Settings: the groups are collapsed; Expand all and Collapse all work. Open the Change channel menu on a live screen, change the channel with the remote or guide, reopen it: it opens at the new channel.
  4. (Fantasy Manager 4.20.0 deployed) The ticker shows "Proj" numbers under the scores once the team names fade, and under each player; Settings > Ticker size changes the bar height.
  5. In the Android app: download a movie, the bar shows for 3 s, Recordings & Downloads shows "On this phone"; play the saved file; if one runs past 100% or will not play, tap Copy report and send it.
Android: package app.iptvmultiview.tv; versionName 0.20.0, versionCode 200000 (rule unchanged); android job PASSED, signed with the release key; the release has ONLY multiview-iptv-0.20.0.apk. The downloader fixes (P-40) are native, so they need this new APK; the page changes reach the app from the server. After the release, confirm the F-Droid sync (fdroid update) still picks up the single versioned APK.
PWA: unchanged; service worker cache is mv-shell-0.20.0 (changes with the version). Cloudflare Access bypass: none needed.
Docker build: not run locally (no Docker in the authoring session); CI ran npm test (138 passed, 4 skipped), built and pushed the image and compiled and signed the APK (all four jobs succeeded). Browser tests ran in the sandbox: 80 passed, 1 known failure (below). Not tested: the Android downloader on a real phone (no Android SDK here, CI only compiles it), Fantasy Manager 4.20.0 against live data, projections during a real game.
Rollback: previous image tag 0.19.1 (pin 0.19.1 in the compose file and pull); data restore needed? no
Known issues: direct links carry the provider login and are not counted by the server (no connection limit, no keep-one-free); only admins get them. A direct download is a copied link (browsers cannot save a cross-origin file under a name), not a file saved by the page. One UI test ("admin turns logins on, publishes...") fails in the sandbox browser run since 0.9.0 (CI does not run the browser suite).
Backup tier: small/critical (include /data in Tier 1; no SQLite, JSON files, stop during copy to be safe). /recordings and /rewind are bulk (SnapRAID only; the rewind buffer is cleared at start).
