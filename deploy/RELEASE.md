# Release v0.16.0
Update: now                    (now | later; now only when James said "build, push and update" for this release)
Image: mybadreligon/multiview-iptv:0.16.0   (also 0.16 and latest; built by the push-to-main release workflow, run https://github.com/jameshoffman7667/multiview-iptv/actions/runs/43616969125, all four jobs succeeded)
Short: Add download buttons for movies and episodes
Long: Download buttons for movies, episodes and whole seasons, as a queue with a per-device limit (default 3). One provider connection stays free for watching. Admin server cap and per-user switch. P-31.
Release commit: b4124f8 on main        Tag pushed from authoring session: no (the workflow created v0.16.0 with gh release create --target; the release page has multiview-iptv-0.16.0.apk and iptv-multiview.apk)
Type: minor
Port: 1234 (host = container; PORT=1234 in the image)   Exception: none. The register's target for iptv-multiview is 8043; not moved by this release.
Public hostname: unchanged by this release (see the homelab reference)        Needs Caddy route: no
New or changed env vars: none. Compose (only the image tag changes), .env.example unchanged. No manual step on the server. New API: POST /api/dl/ticket, GET /api/dl/state, GET/PUT /api/dl/settings (admin). New data: /data/downloads.json (server-wide cap, created when an admin first saves it); per-user "download:false" inside users.json. Old data loads unchanged.
Data: /data (accounts, providers, views, settings, downloads.json, fantasy.json and fantasy.key; small), /recordings (REC_DIR), /rewind (REWIND_DIR); the entrypoint chowns them to uid 1000 at start. Migration: none.
Resources: unchanged. Downloads stream through the app to the browser (no ffmpeg); each running download holds one provider connection.
Healthcheck: unchanged. GET /healthz on $PORT -> 200 {"status":"ok","version":"0.16.0"} (JSON, no login, nothing private); compose test: wget -qO- http://127.0.0.1:$${PORT}/healthz | grep -q '\"status\":\"ok\"' || exit 1 (see deploy/compose.yaml for the exact YAML), interval 30s, timeout 5s, retries 3, start_period 30s. On vm101 use: wget -S -qO- http://127.0.0.1:1234/healthz (no curl there).
Verify after deploy:
  1. docker inspect shows "healthy" within about a minute and the logs are clean (no stack traces).
  2. wget -S -qO- http://127.0.0.1:1234/healthz returns {"status":"ok","version":"0.16.0"} with Content-Type application/json and the security headers.
  3. In the web app: Change channel > Movies shows a download button on each movie; open a series and each episode has one plus "Download this season".
Android: package app.iptvmultiview.tv; versionName 0.16.0, versionCode 160000; android job PASSED (signed with the release key). The TV app hides the download buttons (P-32 covers native TV downloads later). Installing it on a Shield is not tested.
PWA: unchanged; service worker cache is mv-shell-0.16.0 (changes with the version). Cloudflare Access bypass: none needed.
Docker build: not run locally (no Docker in the authoring session); CI ran npm test (130 passed, 4 skipped), built and pushed the image and compiled the APK (all four jobs succeeded). Browser tests ran in the sandbox: 69 passed; the one known failure is below. Not tested: a real multi-gigabyte download from a real provider, or a 1-connection provider in the browser.
Rollback: previous image tag 0.15.0 (pin 0.15.0 in the compose file and pull); data restore needed? no (downloads.json and the user flag are ignored by 0.15.0)
Known issues: one UI test ("admin turns logins on, publishes...") fails in the sandbox browser run since 0.9.0 (CI does not run the browser suite). A browser cannot report when a file finishes, so a download shows as finished when the server has sent it all; a cancelled browser download is marked failed. Downloads count as one provider connection each and wait if only one is left.
Backup tier: small/critical (include /data in Tier 1; no SQLite, JSON files, stop during copy to be safe). /recordings and /rewind are bulk (SnapRAID only; the rewind buffer is cleared at start).
