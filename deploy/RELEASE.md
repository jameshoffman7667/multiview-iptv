# Release v0.7.2
Update: later                      (now | later; now only when James said "build, push and update" for this release)
Image: mybadreligon/multiview-iptv:0.7.2   (also 0.7 and latest; built by the push-to-main release workflow, run https://github.com/jameshoffman7667/multiview-iptv/actions/runs/39886927873)
Short: Release from a push to main, no tag push
Long: The release workflow now runs when package.json's version changes on main, checks tag and CHANGELOG, builds X.Y.Z/X.Y/latest and creates the release and tag itself. App unchanged since 0.7.1 (healthz JSON).
Release commit: 055018c on main        Tag pushed from authoring session: no (the workflow created v0.7.2 at 055018c with gh release create --target)
Type: patch
Port: 1234 (host = container; PORT=1234 in the image)   Exception: none. The register's target for iptv-multiview is 8043; not moved by this release.
Public hostname: unchanged by this release (see the homelab reference)        Needs Caddy route: no
New or changed env vars: none
Data: /data (accounts, providers, views, settings; small), /recordings (REC_DIR), /rewind (REWIND_DIR); the entrypoint chowns them to uid 1000 at start. Migration: none (views.json entries gain optional mode/stream fields since 0.7.0; older entries still work).
Resources: idle RAM and CPU not measured for this release. Bursty: ffmpeg for the shared screen / published streams (COMPOSE_MAX, default 2), 480p transcodes (TRANSCODE_MAX, default 2) and recordings; RING_MB (default 32 per open channel) and the rewind buffer on disk (about 2 GB per hour per 4-5 Mbps channel). Compose limits (cpus) are already set on the server.
Healthcheck: GET /healthz on $PORT -> 200 {"status":"ok","version":"0.7.2"} (JSON, no login, nothing private). Compose test: wget -qO- http://127.0.0.1:$${PORT}/healthz || exit 1, interval 30s, timeout 5s, retries 3, start_period 30s (the image has the same HEALTHCHECK). On vm101 use: wget -S -qO- http://127.0.0.1:1234/healthz (no curl there).
Verify after deploy:
  1. docker inspect shows "healthy" within about a minute and the logs are clean (no "[rewind] cannot use ...", no stack traces).
  2. wget -S -qO- http://127.0.0.1:1234/healthz returns {"status":"ok","version":"0.7.2"} with Content-Type application/json, no login.
  3. Log in, open Multiviews: the saved multiviews are listed and a channel plays (reads real data from /data and the provider).
PWA: unchanged since 0.5.0 (manifest, service worker with cache mv-shell-0.7.2, offline page, install button); installable only through the https hostname. Layouts not re-checked this release (no UI change). Cloudflare Access bypass for /manifest.webmanifest, /sw.js and /icons/*: needed (state done/not done is on the server side).
Docker build: not run locally (the authoring session has no Docker); CI built and pushed the image (amd64 + arm64) and ran npm test (71 pass) first.
Rollback: previous image tag 0.7.1 (the server itself runs 0.7.0, so its rollback pin is the 0.7.0 digest); data restore needed? no
Known issues: none new. Server compose is the homelab repo's stacks/multiview-iptv/compose.yaml; this repo's stack.yml and docker-compose.yml are references to compare against, not what Dockhand runs.
Backup tier: small/critical (include /data in Tier 1; no SQLite, JSON files, stop during copy to be safe). /recordings and /rewind are bulk (SnapRAID only; the rewind buffer is cleared at start).
