# Changelog

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
