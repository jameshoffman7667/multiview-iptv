# Changelog

## 0.5.0 - 2026-10-18
A new player overlay and side menu, rewind, recording, downloads, casting and an installable app.
- **Player overlay (replaces the top menu and the tile menu).** Tap any screen, single channel or multiview, and the controls come up over the whole screen; they act on the selected tile and hide after 5 s idle. Top left: change channel (opens the programme guide); top right: cast (only when a device is available); middle: play/pause with back 10 s / forward 30 s; right: channel up/down in the same category; left edge: pull-out menu arrow; bottom: mute and volume, progress bar, and an arrow that opens the options row: Layout (all layouts live here), Expand (also: tap the same tile twice), Quality, Reload, Favourite, Record, Download. Each option opens its choices in a menu that grows up from its icon. Every control can be reached with the remote (arrows + OK, Back closes sub-menu, row, controls).
- **Pull-out menu.** Watch, Multiviews, Recordings & Downloads, Settings, Providers, Log out. Admin items (users and logins, encoder tests, clear tiles) are under Settings and shown only to admins; Providers is admin only.
- **Rewind.** Every open channel is also written to disk (`REWIND_DIR`, newest `REWIND_MINUTES`, default 60, max 240; emptied at start and when a channel closes). The progress bar, skip buttons and pause on a live channel use it: a tile restarts from the chosen moment and then stays that far behind live. New `?back=<seconds>` on `/stream/...` and `/ws/stream/...`, and `GET /api/rewind/<provider>/<channel>`.
- **Recording.** Record to the end of the current programme (stop time shown, plus 60 min for overtime) or for 30 min - 3 h; schedule a future programme from the guide (starts 5 min early, ends 60 min late). Saved as `.mp4` in `REC_DIR` (video copied, audio AAC), playable while it is being recorded, kept until deleted, no size cap. A full provider at the start time fails the recording with a message on the Recordings & Downloads screen. Works for capture-card channels too. New API: `/api/recordings`, `/api/recordings/event`, `/recordings/<id>.mp4`.
- **Downloads.** Movies and episodes can be downloaded to the server (same folder, listed on Recordings & Downloads) or to the device (browser download).
- **Casting.** Cast icon for Google Cast devices (needs an https page): the selected channel or the whole multiview as one picture, served as fragmented MP4 through a private 6 hour link (`POST /api/cast`, `/cast/<token>.mp4`).
- **Installable app (PWA).** Manifest, icons (incl. maskable and Apple touch icon), wide and narrow screenshots, a service worker that caches only the app shell (cache name follows the version; never streams, API, recordings, casts or login pages), an offline page, an "update ready" prompt, an *Install app* button in Settings and Add-to-Home-Screen help for iOS. Installing needs https; with Cloudflare Access, let `/manifest.webmanifest`, `/sw.js` and `/icons/*` through.
- Changed: the toolbar, the tile menu, double-click zoom and the `...` tile button are gone (their functions are in the overlay); Esc/Back now closes the overlay before leaving an expanded tile; movie/episode tiles use the overlay instead of the browser's own controls.
- New env vars: `REC_DIR`, `REWIND_DIR`, `REWIND_MINUTES`. The stack file maps `/recordings` and `/rewind` to their own volumes (`REC_PATH`, `REWIND_PATH`).
- Tests: rewind (older start, gapless join), recordings (event/programme padding, playable mp4, provider-full failure), downloads, cast links, capture-card recording and rewind, overlay layout/options/remote navigation/viewers, PWA files and service worker.

**Upgrading from 0.4.1:** pulling the new image is enough to run it: recordings and the rewind buffer then live inside the data volume (`/data/recordings`, `/data/rewind`). To put them on their own disks, update the stack from `stack.yml` (new `REC_DIR` / `REWIND_DIR` variables and two volumes).

## 0.4.1 - 2026-10-13
Fixes for the Shared screen (0.4.0). Plain tiles are unchanged.
- **One bad input can no longer fail the composite.** Before ffmpeg is started every channel is checked with ffprobe for decodable video (about 8 s at most). A channel with no video, or one that has not delivered data yet, gets a black tile and the other tiles play. Black channels stay connected (still one provider connection each), are re-checked every few seconds, and the composite restarts by itself (at most every 15 s) when one starts delivering video. Fixes `Stream specifier ':v:0' in filtergraph description ... matches no streams`.
- **A slow input is no longer dropped for good.** The old fixed 6 MiB limit ended an input permanently ("input N too slow"). Each input now has its own queue sized to about 20 s of that channel (at least 12 MiB); when ffmpeg falls further behind, that tile skips ahead to the latest keyframe and goes on, and the log says so.
- **Picture matches the page.** The composite is drawn in the same shape as the tile area on the page (new optional `aspect` and `fit` in `POST /api/compose`; default 16:9 / contain as before) and the page shows it stretched to exactly that area, so tiles sit in their own frames instead of offset. Per-input `setpts`/`asetpts` were removed (they could skew the sound tile's picture against its audio).
- **Page.** A readable message stays on screen while the shared screen retries ("... trying again in 5 s (attempt 2 of 5)") and after it gives up ("Shared screen unavailable: <reason>"), including the server's short reason. Retries back off 2, 5, 10, 20, 30 s and then stop. Layout changes are debounced 1.2 s (and window resizes re-shape the picture) before a request is sent. 400/401/403/404 and "needs a GPU / disabled" are not retried.
- **A new request replaces the old one.** A second shared-screen request from the same account and device closes that viewer's previous composite instead of competing with it for `COMPOSE_MAX` (`COMPOSE_MAX=1` now works while the layout is being built). Refused requests are logged.
- **Logging.** Every composite event names the screen number, provider, channel id and channel name. ffmpeg start (pid, resolution, encoder, inputs, which are black and why), exit code, and the last 2000 characters of ffmpeg's stderr on failure are logged; the browser gets a short reason only. `GET /api/compose/info` lists per-input state (`live`, `black`, why, skip-aheads).
- **Settings.** `COMPOSE_MAX` / `TRANSCODE_MAX` must be whole numbers; text or negative values are reported and replaced by the default (before, text made the limit unlimited). `0` disables the feature (a clear 503 message); documented in the README.
- Tests: input without video, input that delivers late, slow-input recovery, second request replaces the first, page message and backoff, picture geometry (pixel check).

**Upgrading from 0.4.0:** just pull the new image; no stack change is needed.

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
