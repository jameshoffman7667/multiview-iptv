# Release 0.7.1

Update: later

<!--
Rule for the "Update:" line (fixed field, always present, first line after the title):
  Update: now    only when James said "build, push and update" for this release
  Update: later  in every other case ("build", "build and push", "build P-x", ...)
Rewrite this file for every release.
-->

- Image: `mybadreligon/multiview-iptv:0.7.1` (also `0.7`, `latest`)
- Health check: `GET /healthz` on `$PORT` answers `{"status":"ok","version":"0.7.1"}` (no login, nothing private). The image has the HEALTHCHECK (30 s start period); `stack.yml` and `docker-compose.yml` have the same check.
- Stack / compose change needed: yes, to get the health check in the stack: new `healthcheck:` block and image tag `0.7.1` (copy `stack.yml`). Pulling only the new image also works (the image carries its own check).
- New environment variables: none
- New volumes: none
- Android app: no change (the APK is rebuilt by CI as v0.7.1 but has no new features).
