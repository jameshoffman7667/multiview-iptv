# Changelog

## 0.2.1 - 2026-10-11
Bug fixes.
- Fixed: every channel showed "Stream error (Exception)". The player runs in a background worker, which cannot resolve a relative stream address; the page now uses a full address.
- Fixed: with 6 or more streams playing, buttons stopped working (Create admin did nothing, Multiviews loaded forever) and tiles 7-9 never started. Browsers allow only about 6 plain-HTTP connections per address, so streams now travel over WebSockets, which have no such limit. Same login and per-viewer checks apply. Plain HTTP stays as an automatic fallback (and a Settings option) for proxies that block WebSockets. If you use a reverse proxy, allow WebSocket upgrades on `/ws/`.
- Fixed: the container crashed with `EACCES: permission denied, mkdir '/data/cache'` when `/data` was a host folder owned by root. The image now starts as root, fixes the ownership of the data folder, then runs as the unprivileged `node` user. If the folder still cannot be written, a clear message is printed instead of a stack trace.
- Fixed: the Category dropdown was greyed out with a single provider. Categories now work with one or several providers (merged by name), and are built from channel-name prefixes (`US| ...`) when a provider sends none.

## 0.2.0 - 2026-10-10
- Default port is now 1234 (app, Dockerfile, docker-compose.yml, stack.yml, README). Existing stacks must change the published port to `1234:1234` or set `PORT=8080`.
- New `DATA_PATH` variable in docker-compose.yml and stack.yml sets what is mounted at `/data` (a host folder or the default `iptv-data` volume). `DATA_DIR` (path inside the container) was already configurable and is now documented in full.

## 0.1.0 - 2026-10-10
First version.
- Buffering relay for Xtream Codes providers: one shared connection per channel, keyframe-aligned catch-up buffer for new viewers, reconnect on drops, stall detection.
- Multiview page: 1, 2x2, 1+5, 3x3 (9 streams) and 1+7 (big top-left, 3 right, 3 bottom, 1 corner) layouts; TV-remote keys, mouse and touch.
- Several providers with per-provider connection limits and failover to another provider by channel name.
- Logins (admin and viewer), published multiviews with per-user access, per-user stream limits.
- Docker image and compose file; data kept in a volume.
- GitHub Actions workflow: runs the tests, then builds a linux/amd64 + arm64 image and pushes it to Docker Hub (`mybadreligon/multiview-iptv`) on every push to main, tagged from the version in `package.json` (`0.1.0`, `0.1`, `latest`), and adds the matching `v0.1.0` git tag.
- `stack.yml` for installing as a stack in Dockhand (uses the Docker Hub image).
