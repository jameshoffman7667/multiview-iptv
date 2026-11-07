# Release v0.8.0
Update: later                      (now | later; now only when James said "build, push and update" for this release)
Image: mybadreligon/multiview-iptv:0.8.0   (also 0.8 and latest; built by the push-to-main release workflow, run https://github.com/jameshoffman7667/multiview-iptv/actions/runs/42384587189)
Short: Light theme, login lockout, tini, docs
Long: Theme setting (System/Light/Dark), account lockout and security headers, TRUST_PROXY, tini shutdown, stricter healthcheck, functional spec and deploy/ files. Same data, same port.
Release commit: 706a33d on main        Tag pushed from authoring session: no (the workflow creates v0.8.0 with gh release create --target)
Type: minor
Port: 1234 (host = container; PORT=1234 in the image)   Exception: none. The register's target for iptv-multiview is 8043; not moved by this release.
Public hostname: unchanged by this release (see the homelab reference)        Needs Caddy route: no
New or changed env vars: TRUST_PROXY (optional, new): set 1 when the container sits behind Caddy / Cloudflare so login lockouts use the real client address (CF-Connecting-IP / X-Forwarded-For). No other change.
Data: /data (accounts, providers, views, settings; small), /recordings (REC_DIR), /rewind (REWIND_DIR); the entrypoint chowns them to uid 1000 at start. Migration: none (views.json entries gain optional mode/stream fields since 0.7.0; older entries still work).
Resources: idle RAM and CPU not measured for this release. Bursty: ffmpeg for the shared screen / published streams (COMPOSE_MAX, default 2), 480p transcodes (TRANSCODE_MAX, default 2) and recordings; RING_MB (default 32 per open channel) and the rewind buffer on disk (about 2 GB per hour per 4-5 Mbps channel). Compose limits (cpus) are already set on the server.
Healthcheck: GET /healthz on $PORT -> 200 {"status":"ok","version":"0.8.0"} (JSON, no login, nothing private). The image HEALTHCHECK and the compose test now also require "status":"ok": wget -qO- http://127.0.0.1:$${PORT}/healthz | grep -q '\"status\":\"ok\"' || exit 1 (see deploy/compose.yaml for the exact YAML), interval 30s, timeout 5s, retries 3, start_period 30s. The old test (wget ... || exit 1) still works with this image. On vm101 use: wget -S -qO- http://127.0.0.1:1234/healthz (no curl there).
Verify after deploy:
  1. docker inspect shows "healthy" within about a minute and the logs are clean (no "[rewind] cannot use ...", no stack traces); the process list shows tini as PID 1.
  2. wget -S -qO- http://127.0.0.1:1234/healthz returns {"status":"ok","version":"0.8.0"} with Content-Type application/json, no login, and the response headers include Content-Security-Policy and X-Frame-Options: DENY.
  3. Log in, open Multiviews: the saved multiviews are listed and a channel plays; Settings > Theme switches the dialog between light and dark. Then `docker stop iptv-multiview` finishes in a few seconds with "Received SIGTERM" in the log (not exit 137).
PWA: manifest, icons and install unchanged; service worker cache is mv-shell-0.8.0 and now also caches /offline.js. Layout/theme: Settings > Theme (System/Light/Dark) checked in the UI test suite at 1280x720 for light and dark devices; phone width (390 x 844) not re-checked by eye this release. Cloudflare Access bypass for /manifest.webmanifest, /sw.js and /icons/*: needed (state done/not done is on the server side).
Docker build: not run locally (no Docker in the authoring session); CI ran npm test (80 pass), built and pushed the image (amd64 + arm64) and the Android APK; run succeeded. Confirm the container reports healthy after deploy (tini line and healthcheck pipe are only exercised there).
Rollback: previous image tag 0.7.2 (the server itself runs 0.7.0 unless Claude Code already moved it; pin whatever tag was running before this update); data restore needed? no
Known issues: none new. Server compose is the homelab repo's stacks/multiview-iptv/compose.yaml; this repo's stack.yml, docker-compose.yml and deploy/compose.yaml are references to compare against, not what Dockhand runs. A compose change is optional (TRUST_PROXY=1, stricter healthcheck); pulling the image is enough.
Backup tier: small/critical (include /data in Tier 1; no SQLite, JSON files, stop during copy to be safe). /recordings and /rewind are bulk (SnapRAID only; the rewind buffer is cleared at start).
