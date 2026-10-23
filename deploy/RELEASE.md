# Release 0.7.2

Update: later

<!--
Rule for the "Update:" line (fixed field, always present, first line after the title):
  Update: now    only when James said "build, push and update" for this release
  Update: later  in every other case ("build", "build and push", "build P-x", ...)
Rewrite this file for every release.
-->

- Image: `mybadreligon/multiview-iptv:0.7.2` (also `0.7`, `latest`)
- What changed: the release process only (a push to `main` that changes the version in `package.json` releases; no tag push). The app is unchanged; `/healthz` reports 0.7.2.
- Stack / compose change needed: only the image tag (`0.7.2`); pulling the new image is enough.
- New environment variables: none
- New volumes: none
- Android app: rebuilt by CI as v0.7.2, no new features.
