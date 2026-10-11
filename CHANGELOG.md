# Changelog

## 0.4.0 - 2026-10-11
Features.
- **Overlays hide when idle.** After 5 seconds without mouse, keyboard or remote input, the top menu, the channel names and the sound bubble disappear; any input brings them back.
- **Quieter sound marker.** The selected/sound tile outline and the "sound" bubble are now a thin pastel red instead of blue, and are not shown at all when only one screen is being viewed (single layout or a zoomed tile).
- **Small tiles prefer SD.** A tile that is a sixth of the screen or less asks for the SD / low-quality version of the channel when the provider has one (matched by name, any enabled provider), falling back to the chosen channel. New setting *Small tiles prefer the SD version* (on) and a per-tile *Quality* choice in the tile menu. The stats overlay shows `SD`. API: `?q=sd` on `/stream/...` and `/ws/stream/...`.
- **Shared screen.** Settings > Shared screen (480p / 720p / 1080p): the server combines the visible tiles into a single H.264 stream with ffmpeg, so a weak TV box plays one stream instead of decoding up to nine. Runs only while someone watches, shared between viewers of the same picture, with sound from the selected tile. Tiles, names, selection and menus stay on top of it. Falls back to normal tiles with a message if the server declines. New API: `POST /api/compose`, `GET /stream/compose/<id>.ts`, `/ws/compose/<id>`, `GET /api/compose/info`, `POST /api/compose/test`.
- **480p tile transcode.** Tile menu > Quality > *480p transcode*: the server re-encodes that one channel at 480p. GPU encoder only unless `TRANSCODE_ALLOW_CPU=1`; if declined the original stream plays.
- **GPU encoding.** The image now includes the Intel (`intel-media-driver`, x86-64 only) and AMD (`mesa-va-gallium`) VA drivers and `vainfo`. Settings has *Test CPU encoder* / *Test GPU encoder* buttons. New env vars `COMPOSE_ENCODER`, `COMPOSE_MAX`, `TRANSCODE_MAX`, `TRANSCODE_ALLOW_CPU`, `COMPOSE_IDLE_SECONDS`.
- Limits to know: only the encode runs on the GPU (decoding and scaling of the inputs is on the CPU); the GPU path and the VA drivers in the image have not been tested on real hardware by the author.

**Upgrading from 0.3.0:** just pull the new image; no stack change is needed. To use a GPU for the shared screen, add `devices: - /dev/dri:/dev/dri` (see `stack.yml`).

## 0.3.0 - 2026-10-11
Features.
- **Channel picker remembers its place.** Provider, tab, category, search, Favorites toggle, how many rows were expanded, scroll position and the last chosen channel are saved per browser and restored next time (also after a reload). New *Reset filters* button.
- **Programme guide.** New *Guide* tab in the picker: channels by time, now/next highlighted, pick a channel or programme straight from it, search programme titles. Uses the provider's XMLTV file (cached 4 h) or per-channel guide data. Tiles show what is on now. New API: `/api/epg`, `/api/epg-search`.
- **Movies and series (VOD).** New *Movies* and *Series* tabs with categories and search; seasons/episodes for series. Played through a range-capable proxy (`/vod/...`) so seeking works; counts as one provider connection while playing; viewers can play only titles in a multiview shared with them. Movie/episode tiles can be part of published multiviews.
- **Longer buffer.** *Start playing after* now goes up to 5 minutes (was 15 s) and a new *Keep up to* sets the largest cushion kept. Server burst cap raised from 30 s to 300 s; a long burst no longer gets a viewer dropped as "too slow". `RING_MB` default raised from 16 to 32 (memory is used only as the buffer fills); set higher for multi-minute buffers.
- **Local capture card as a channel.** *Providers > Add capture card*: V4L2 video + ALSA audio encoded with ffmpeg to H.264/AAC and fed through the relay (one encode shared by all viewers, no provider connection used). Optional VAAPI/NVENC encoders. The image now contains ffmpeg; pass the devices into the container (see `stack.yml`). New env vars `FFMPEG_PATH`, `VAAPI_DEVICE`.
- **Android TV / Nvidia Shield app.** `iptv-multiview.apk` is built by GitHub Actions for every release and attached to the GitHub release. A full-screen web view with a TV launcher icon, remote support and a first-run server-address prompt. AC-3/E-AC-3/MP2 audio is not decoded by the Android web view.
- Fixed: pressing `C` to open the picker typed a "c" into the search box.

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
