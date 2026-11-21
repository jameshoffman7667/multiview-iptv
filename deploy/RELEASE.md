# Release v0.22.0
Update: now                    (now | later; now only when James said "build, push and update" for this release)
Image: mybadreligon/multiview-iptv:0.22.0   (also 0.22 and latest; built by the push-to-main release workflow, run https://github.com/jameshoffman7667/multiview-iptv/actions/runs/44947745315, all four jobs succeeded)
Short: Ticker menu, zoom, recordings on screen
Long: Ticker settings tap and drag, switches on top, per-screen menu resume, bar above ticker, recordings play on a screen, pinch zoom, download overrun stop, Fire TV prep. P-49, P-54 to P-60.
Release commit: 0d8dc27 on main        Tag pushed from authoring session: no (the workflow created v0.22.0 with gh release create --target; the release page has only multiview-iptv-0.22.0.apk)
Type: minor
Port: 1234 (host = container; PORT=1234 in the image)   Exception: none. The register's target for iptv-multiview is 8043; not moved by this release.
Public hostname: unchanged by this release (see the homelab reference)        Needs Caddy route: no
New or changed env vars: none. Compose (only the image tag changes), .env.example, data format and API: unchanged. No manual step on the server. The saved tile list may now hold a recording tile (p "rec"); older versions drop it on load.
Data: /data (accounts, providers, views, settings, downloads.json, fantasy.json and fantasy.key; small), /recordings (REC_DIR), /rewind (REWIND_DIR); the entrypoint chowns them to uid 1000 at start. Migration: none.
Resources: unchanged.
Healthcheck: unchanged. GET /healthz on $PORT -> 200 {"status":"ok","version":"0.22.0"} (JSON, no login, nothing private); compose test: wget -qO- http://127.0.0.1:$${PORT}/healthz | grep -q '\"status\":\"ok\"' || exit 1 (see deploy/compose.yaml for the exact YAML), interval 30s, timeout 5s, retries 3, start_period 30s. On vm101 use: wget -S -qO- http://127.0.0.1:1234/healthz (no curl there).
Verify after deploy:
  1. docker inspect shows "healthy" within about a minute and the logs are clean (no stack traces).
  2. wget -S -qO- http://127.0.0.1:1234/healthz returns {"status":"ok","version":"0.22.0"} with Content-Type application/json and the security headers.
  3. Settings: "Score ticker along the bottom" and "Score pop-ups" are at the top; switching one off hides its options. Tap the league name on the ticker: a small Fantasy settings window opens. Drag the scores sideways: the tape follows and resumes by itself.
  4. Change channel menu: use it on screen 1, then on screen 2, then screen 1 again without changing its channel: it opens as it was last left.
  5. Recordings & Downloads > Play on a finished recording: it plays on the selected screen with the normal controls (no pop-up). In a browser, two-finger pinch on a touch device (or the mouse wheel) zooms that screen's video only.
  6. Android app (new APK): a recording plays through the app's player; a download that runs past its size stops and shows "Past estimate" (Copy report has the sizes); Fire TV Stick (Fire OS 6+) installs and opens if one is at hand.
Android: package app.iptvmultiview.tv; versionName 0.22.0, versionCode 220000 (rule unchanged); android job PASSED, signed with the release key; the release has ONLY multiview-iptv-0.22.0.apk. The native recording player, the download overrun stop and the Fire TV checks need this APK; the page changes reach the app from the server. After the release, confirm the F-Droid sync (fdroid update) still picks up the single versioned APK.
PWA: unchanged; service worker cache is mv-shell-0.22.0 (changes with the version). Cloudflare Access bypass: none needed.
Docker build: not run locally (no Docker in the authoring session); CI ran npm test (142 passed, 4 skipped), built and pushed the image and compiled and signed the APK (all four jobs succeeded). Browser tests ran in the sandbox: 88 passed, 1 known failure (below). Not tested: the native recording player, the downloader overrun stop, pinch on a real touch screen and anything on a Fire TV Stick (no Android SDK or devices here, CI only compiles the app).
Rollback: previous deployed image tag 0.21.0 (pin 0.21.0 in the compose file and pull); data restore needed? no
Known issues: in the native recording player the seek bar is not wired (skip buttons work); seeking a fragmented MP4 recording without a duration depends on the player. One UI test ("admin turns logins on, publishes...") fails in the sandbox browser run since 0.9.0 (CI does not run the browser suite). P-37, P-42, P-43 and P-50 are not built.
Backup tier: small/critical (include /data in Tier 1; no SQLite, JSON files, stop during copy to be safe). /recordings and /rewind are bulk (SnapRAID only; the rewind buffer is cleared at start).
