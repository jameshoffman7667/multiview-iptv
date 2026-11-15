# Release v0.17.0
Update: now                    (now | later; now only when James said "build, push and update" for this release)
Image: mybadreligon/multiview-iptv:0.17.0   (also 0.17 and latest; built by the push-to-main release workflow, run https://github.com/jameshoffman7667/multiview-iptv/actions/runs/43723762163, all four jobs succeeded)
Short: Add direct provider playback for admins
Long: Admins can play movies and episodes straight from the provider, with automatic fallback to the server, and make the download buttons copy direct links. Per-device settings, off by default. P-34.
Release commit: 70f7c39 on main        Tag pushed from authoring session: no (the workflow created v0.17.0 with gh release create --target; the release page has only multiview-iptv-0.17.0.apk)
Type: minor
Port: 1234 (host = container; PORT=1234 in the image)   Exception: none. The register's target for iptv-multiview is 8043; not moved by this release.
Public hostname: unchanged by this release (see the homelab reference)        Needs Caddy route: no
New or changed env vars: none. Compose (only the image tag changes), .env.example and data format: unchanged. No manual step on the server. API: GET /api/direct (admin only, existed for Local mode) now also answers movie:ID and series:ID with &ext=. No new data files.
Data: /data (accounts, providers, views, settings, downloads.json, fantasy.json and fantasy.key; small), /recordings (REC_DIR), /rewind (REWIND_DIR); the entrypoint chowns them to uid 1000 at start. Migration: none.
Resources: unchanged. Direct playback uses no server bandwidth or provider slot on the server.
Healthcheck: unchanged. GET /healthz on $PORT -> 200 {"status":"ok","version":"0.17.0"} (JSON, no login, nothing private); compose test: wget -qO- http://127.0.0.1:$${PORT}/healthz | grep -q '\"status\":\"ok\"' || exit 1 (see deploy/compose.yaml for the exact YAML), interval 30s, timeout 5s, retries 3, start_period 30s. On vm101 use: wget -S -qO- http://127.0.0.1:1234/healthz (no curl there).
Verify after deploy:
  1. docker inspect shows "healthy" within about a minute and the logs are clean (no stack traces).
  2. wget -S -qO- http://127.0.0.1:1234/healthz returns {"status":"ok","version":"0.17.0"} with Content-Type application/json and the security headers.
  3. As an admin: Settings > "Play movies and episodes straight from the provider" on, open a movie; it should play, and if the provider refuses it the banner says "Direct connection failed - using the server" and it plays through the server.
Android: package app.iptvmultiview.tv; versionName 0.17.0, versionCode 170000 (rule unchanged); android job PASSED, signed with the release key; the release has ONLY multiview-iptv-0.17.0.apk. In the TV app admins can use direct movie playback (its web view allows http providers); download buttons stay hidden there. Installing it on a Shield is not tested.
PWA: unchanged; service worker cache is mv-shell-0.17.0 (changes with the version). Cloudflare Access bypass: none needed.
Docker build: not run locally (no Docker in the authoring session); CI ran npm test (131 passed, 4 skipped), built and pushed the image and compiled and signed the APK (all four jobs succeeded). Browser tests ran in the sandbox: 73 passed, 1 known failure (below). Not tested: direct playback against a real provider, an IP-locked provider, or an https page with an http provider (the https check is code only).
Rollback: previous image tag 0.16.1 (pin 0.16.1 in the compose file and pull); data restore needed? no
Known issues: direct links carry the provider login and are not counted by the server (no connection limit, no keep-one-free); only admins get them. A direct download is a copied link (browsers cannot save a cross-origin file under a name), not a file saved by the page. One UI test ("admin turns logins on, publishes...") fails in the sandbox browser run since 0.9.0 (CI does not run the browser suite).
Backup tier: small/critical (include /data in Tier 1; no SQLite, JSON files, stop during copy to be safe). /recordings and /rewind are bulk (SnapRAID only; the rewind buffer is cleared at start).
