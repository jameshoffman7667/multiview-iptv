# Release 0.7.0

Update: later

<!--
Rule for the "Update:" line (fixed field, always present, first line after the title):
  Update: now    only when James said "build, push and update" for this release
  Update: later  in every other case ("build", "build and push", "build P-x", ...)
Rewrite this file for every release.
-->

- Image: `mybadreligon/multiview-iptv:0.7.0` (also `0.7`, `latest`)
- Stack / compose change needed: no. Pull the new image (`stack.yml` and `docker-compose.yml` need no change).
- New environment variables: none
- New volumes: none
- Data: `views.json` entries gain `mode` / `stream`; older entries keep working as layouts.
- Android app: new APK built by CI (`v0.7.0`); install it for the floating mini player (0.6.0).
