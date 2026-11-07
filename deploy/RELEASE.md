# Release v0.9.0
Update: later                      (now | later; now only when James said "build, push and update" for this release)
Image: mybadreligon/multiview-iptv:0.9.0   (also 0.9 and latest; built by the push-to-main release workflow, run https://github.com/jameshoffman7667/multiview-iptv/actions/runs/42386989931)
Short: Per-screen controls, local mode, app cast
Long: Player controls sit inside each screen with new tap rules; Android app gets local mode (direct provider play, admins, GET /api/direct) and native Google Cast. Same data, same port.
Release commit: 932554a on main        Tag pushed from authoring session: no (the workflow created v0.9.0 with gh release create --target)
Type: minor
Port: 1234 (host = container; PORT=1234 in the image)   Exception: none. The register's target for iptv-multiview is 8043; not moved by this release.
Public hostname: unchanged by this release (see the homelab reference)        Needs Caddy route: no
New or changed env vars: none (TRUST_PROXY from 0.8.0 still optional). New API: GET /api/direct (admin only).
Data: /data (accounts, providers, views, settings; small), /recordings (REC_DIR), /rewind (REWIND_DIR); the entrypoint chowns them to uid 1000 at start. Migration: none (views.json entries gain optional mode/stream fields since 0.7.0; older entries still work).
Resources: idle RAM and CPU not measured for this release. Bursty: ffmpeg for the shared screen / published streams (COMPOSE_MAX, default 2), 480p transcodes (TRANSCODE_MAX, default 2) and recordings; RING_MB (default 32 per open channel) and the rewind buffer on disk (about 2 GB per hour per 4-5 Mbps channel). Compose limits (cpus) are already set on the server.
Healthcheck: GET /healthz on $PORT -> 200 {"status":"ok","version":"0.9.0"} (JSON, no login, nothing private). The image HEALTHCHECK and the compose test now also require "status":"ok": wget -qO- http://127.0.0.1:$${PORT}/healthz | grep -q '\"status\":\"ok\"' || exit 1 (see deploy/compose.yaml for the exact YAML), interval 30s, timeout 5s, retries 3, start_period 30s. The old test (wget ... || exit 1) still works with this image. On vm101 use: wget -S -qO- http://127.0.0.1:1234/healthz (no curl there).
Verify after deploy:
  1. docker inspect shows "healthy" within about a minute and the logs are clean (no "[rewind] cannot use ...", no stack traces); the process list shows tini as PID 1.
  2. wget -S -qO- http://127.0.0.1:1234/healthz returns {"status":"ok","version":"0.9.0"} with Content-Type application/json, no login, and the response headers include Content-Security-Policy and X-Frame-Options: DENY.
  3. Log in, open Multiviews, tap a screen: the controls appear on that screen only; tap again to select, again to zoom. Optional on the Android app (admin): Settings > Local mode, and the cast button on a phone.
PWA: manifest, icons and install unchanged; service worker cache is mv-shell-0.9.0. Layout: controls now sit inside each screen (checked by the UI test suite at 1600x900 and 1280x720, compact buttons on small screens); phone width (390 x 844) not checked by eye. Cloudflare Access bypass for /manifest.webmanifest, /sw.js and /icons/*: needed (state done/not done is on the server side).
Docker build: not run locally (no Docker in the authoring session); CI ran npm test (84 pass, 4 skipped), built and pushed the image (amd64 + arm64) and compiled the Android APK (run succeeded). The Android local mode and cast code was never run on a device.
Rollback: previous image tag 0.8.0 (pin whatever tag was running before this update); data restore needed? no
Known issues: local mode and app casting are untested on a real TV/phone (first compile was CI); if the picture is wrong turn off Settings > Local mode. UI test "admin turns logins on, publishes..." fails in the full browser run on 0.7.2 and 0.9.0 alike (passes alone; CI does not run the browser suite). Server compose is the homelab repo's stacks/multiview-iptv/compose.yaml; no compose change needed for this release.
Backup tier: small/critical (include /data in Tier 1; no SQLite, JSON files, stop during copy to be safe). /recordings and /rewind are bulk (SnapRAID only; the rewind buffer is cleared at start).
