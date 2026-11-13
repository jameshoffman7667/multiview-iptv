# Changelog

## 0.14.0 - 2026-11-12
Auto quality: start low, step up as the buffer grows, step down when it drains.
- **Quality > Auto (adaptive)** (P-29), per channel, or Settings > *Auto quality for every channel that has no quality chosen* (off by default). The old choice is now called *Standard* (overlay label `STD`; Auto shows `AUTO SD`, `AUTO FULL` or `AUTO 480p`).
- **Start low:** the channel opens on its SD version (or as chosen when it has none) with a 3 s start cushion instead of the long "Start playing after" wait.
- **Step up** one level when the buffer stays at 10 s or more for 20 s with no stall; while it waits the video plays at 0.95x so the cushion can grow. **Step down** one level when the buffer stays under 5 s and is not growing for 10 s, or on a stall; then no step up for 60 s.
- Steps: 480p server transcode (only with a GPU encoder; used only when the buffer keeps draining), SD version, as chosen. Small tiles never go above SD while *Small tiles prefer SD* is on.
- **No gap:** the new stream opens on a second video and replaces the picture once it has 2 s buffered. It briefly uses a second provider connection; if the provider is full, the stream errors or it is slow (15 s), the switch is skipped and the current stream keeps playing.
- Not used for movies/episodes, while rewound, in the shared screen or in published one-stream views. Diagnostics show each screen's step and its last switches with the reason.
- Server: `GET /api/quality-options` (login; viewers only for channels shared with them). No new settings or environment variables on the server.
- Tests: new `test/autoquality.test.js` (endpoint) and UI tests (start step and cushion, Settings default, step up with no gap, 20 s hold, slow-play cushion build, step down only when not growing, stall, skipped switch, restart closes a half-built switch).

**Upgrading from 0.13.0:** pull the new image; no compose, `.env` or data change. The browser setting `autoQ` is new and defaults to off.

## 0.13.0 - 2026-11-08
Diagnostics to find where buffering comes from.
- **Settings > Diagnostics** (P-28, admins only): a window with live tables. *This browser:* per screen the buffer now and its minimum over the last minute, stalls (count, total and longest), dropped frames, incoming rate and startup time. *On the server:* per channel the rate from the provider, connect and first-data times, the longest silence from the provider in the last minute, reconnects and the last errors, viewers and each viewer's queue peak and how often it backed up. Plus the server's CPU, load, memory, event-loop delay and ffmpeg count.
- **Run 30 s test:** times a 16 MB transfer from the server to this browser, watches for 30 s, then names the likely cause: the provider (or your internet link to it), a busy server, a slow server-to-device link (Wi-Fi), or a device that cannot decode that much; with numbers, and a *Copy results* report to paste into a chat. The report has channel and provider names only, no addresses.
- Server: `GET /api/diag` and `GET /api/diag/speed` (both admin only), new `src/health.js`. Nothing is stored on disk; no new settings or environment variables.
- Tests: new `test/diag.test.js` (admin only, per-channel numbers, no addresses, viewer back-up counting, speed block size and cap) and UI tests (stall counting, the verdict for each cause, the window and a short test).

**Upgrading from 0.12.0:** pull the new image; no compose, `.env` or data change.

## 0.12.0 - 2026-11-08
Each admin sets their own Fantasy Manager connection in the app instead of server environment variables.
- **Settings > Fantasy Manager** (P-27, admins only): address and read-only token (from Fantasy Manager > Account > Multiview access), with *Save*, *Test connection* (says ok and the Fantasy Manager version, or why not) and *Remove*. The pop-up and ticker options appear once a connection is saved. Other roles get 403 on every Fantasy Manager route.
- **Token handling:** kept on the server only, encrypted at rest (AES-256-GCM) with a random key in `/data/fantasy.key`, stored in `/data/fantasy.json`; never returned to a page (the page sees only "token saved" and the last 4 characters), never in browser storage or logs. Changing the address needs the token typed again, so the saved token is never sent to a new host. If `fantasy.key` is lost the token must be entered again.
- **Per user, only while in use:** pop-ups and ticker use the signed-in admin's own connection. The server connects to Fantasy Manager only while that admin has a page open (closes after 60 s without one; the last summary is kept 60 s). A user with nothing saved causes no requests.
- **Address rules** (SSRF): http or https only, no user name or password, no `?` or `#`; only private LAN (10/8, 172.16/12, 192.168/16) and Tailscale (100.64/10, fc00::/7) addresses. localhost, 127.x, ::1, 0.0.0.0, 169.254.x (link-local, cloud metadata) and public addresses are refused, a host name must resolve only to allowed addresses (checked on save and on every connect), redirects are not followed.
- **Removed:** the two Fantasy Manager environment variables from the compose files, `.env.example` and docs; nothing is read from the environment any more (no fallback, no migration).
- Tests: address rules, admin-only (403 / 401 on all routes), test / save / remove, encryption on disk and file modes, per-user isolation, no connection until a page asks and closing when idle, lost key, wrong token back-off, stream ended on change or removal; UI test for the settings section.

**Upgrading from 0.11.0:** pull the new image. The compose file changes only by two lines being deleted (the Fantasy Manager lines, if present; leaving them is harmless). Then each admin enters their address and token once in Settings > Fantasy Manager. Back up `/data/fantasy.key` together with `/data`.

## 0.11.0 - 2026-11-08
The Fantasy Manager score ticker along the bottom.
- **Fantasy ticker** (P-25, admins only, needs Fantasy Manager 4.17.1 or later and `FANTASY_URL` / `FANTASY_TOKEN` from 0.10.0): an opaque bar along the bottom, one block per league. The league name and both scores scroll in (your team name and score in the league colour, the opponent in white, team names under their scores); then the league name stalls at the left edge, the score stalls right of it, the team names drop away and the lineup slides in behind them until the next league's name pushes the block off. After the header come both starting lineups, yours then the opponent's, in roster-slot order: players who have not played show their game time, live players show name, points and counting stats in brackets, finished players show the score and final stats in light grey. When a player comes on screen with more points than the last time his name was on screen for that side (yours or the opponent's, across all leagues) his score glows green (yours) or red (opponent) and rolls up, and the team total rolls up with it.
- Settings > *Show the score ticker along the bottom*, *Ticker position*: **Below the video** (default; the screens shrink so the bar never covers a score bug) or **Overlap the video** (for streams that carry their own ticker), and speed (slow / normal / fast).
- Server: `src/fantasy.js` also polls Fantasy Manager's `GET /api/ticker/summary` (every 15 s while any game is live, every 60 s otherwise, and soon after a score event); new admin-only `GET /api/fantasy/summary` serves the cleaned starters-only summary.
- Tests: server (summary polling, cleaning, admin-only, refresh after a score event) and UI (bar below / overlap, header colours, slot order, pre / live / final formats, pinning and push-off, glow and roll-up with baseline on first sight, settings, off for viewers).

**Upgrading from 0.10.0:** pull the new image, no compose change if the stack already has the `FANTASY_URL` and `FANTASY_TOKEN` lines from 0.10.0. The league name is plain white (assumed). Like the pop-ups, the ticker was tested against a stand-in for Fantasy Manager, not the real one.

## 0.10.0 - 2026-11-08
A fullscreen button in the controls, and score pop-ups from Fantasy Manager.
- **Fullscreen button** (P-24): in the page-level strip at the top right of the player controls, after cast and the mini player. It enters and leaves fullscreen and changes its icon. It is hidden where the browser has no fullscreen (iPhone Safari) and in the Android app, which is already full screen. Settings > Fullscreen and the F key still work.
- **Score pop-ups** (P-26, admins only, needs Fantasy Manager 4.17.0 or later): when a starter on any of your Sleeper rosters scores, his headshot slides down from the top centre with the points on each side (green for leagues where he is yours, red where he is your opponent's) and the leagues he is in beside them, league name outermost, your total in green and the opponent's in red, the name coloured by Fantasy Manager's performance-vs-projection colour. No background or outline. One player at a time, 5 seconds each, simultaneous scores queue and the same player scoring again before his pop-up starts is merged. It first shows the totals from before the play and 0 for half a second, then the numbers roll up; it slides back off the top. Settings > *Show a pop-up when a player scores*: smallest score (default 3 points), delay 0-180 s to line up with a delayed stream, opponents' players on/off, size (automatic: smaller with more screens), and how late a pop-up may be before it is dropped (default 60 s), plus a *Show a sample pop-up* button. Pop-ups wait while a window is open or the page is hidden or floating. They never take taps.
- **Server link to Fantasy Manager**: `src/fantasy.js` holds one read-only connection (Server-Sent Events, auto-reconnect with back-off, resumes from the last event id) to Fantasy Manager's `GET /api/ticker/stream` with a bearer token; new `GET /api/fantasy/status`, `GET /api/fantasy/stream` and `GET /api/fantasy/headshot/<id>` (all admin only; the address and token never reach a page; headshots are cached in memory for a day). Negative changes and stat corrections never pop up. New environment variables `FANTASY_URL` (Fantasy Manager's LAN address and client port) and `FANTASY_TOKEN` (read-only token from its Account > Multiview access); leave them empty and the feature is off.
- Tests: new `test/fantasy.test.js` (event parsing, token handling, admin-only routes, catch-up, headshot proxy, reconnect with the last event id, wrong token); UI tests for the fullscreen button and the pop-up (one at a time, before-values then roll, slide in and out, no background, delay, merge, queue age, settings, held while a window is open).

**Upgrading from 0.9.0:** pull the new image. To switch the pop-ups on, the stack needs the two new environment lines (`FANTASY_URL=${FANTASY_URL:-}` and `FANTASY_TOKEN=${FANTASY_TOKEN:-}`, see `deploy/compose.yaml`) and the values in the server `.env`; without them everything else works as before and the pop-up settings say it is not set up. The ticker along the bottom (P-25) is not in this release. Phone-width screens show the pop-up very small (it scales to fit); it is meant for a TV or desktop.

## 0.9.0 - 2026-11-07
The player controls now live inside each screen, plus local mode and casting in the Android app.
- **Controls inside each screen** (P-16): tap a screen and the controls come up on *that* screen (they cover only it, with smaller buttons on small screens), nothing is selected yet. Tap it again: a screen that is not selected becomes selected and the controls stay on it. Tap once more on the selected screen: a playing screen zooms, an empty screen opens the channel selection, and tapping a zoomed screen goes back to the grid. Tapping a different screen while the controls are up selects it and moves the controls there. The menu arrow, cast and mini-player buttons stay at the page edges. Changing a playing screen's channel is still the guide / change-channel button in its controls.
- **Local mode** (P-17, Android app, admins only): Settings > *Local mode* (shown only in the app, per device, off by default). The selected screen then plays straight from your provider in the app's own native player, so the picture no longer goes provider -> server -> your connection; useful away from home on a slow upload. The server only hands out the direct address to admins (`GET /api/direct`). It does one screen at a time (the selected or zoomed one), uses its own provider connection (it counts against your provider's connection limit), and has no rewind, recording, cast or shared screen. If the direct stream fails, that screen switches back to the server on its own. It also plays AC-3 / E-AC-3 audio where the device can decode it.
- **Casting from the app** (P-18, phones and tablets with Google Play services): the cast button now works inside the Android app with a native Google Cast sender (default media receiver). It lists the Cast devices on the network, then plays the server's cast link on the one you pick. It is hidden on TV boxes and on devices without Play services. Chrome's own cast is unchanged.
- Server: `GET /api/direct?p=&sid=` (admin only); new tests for it and for the app's bridge / manifest wiring; UI tests updated and extended for the new tap rules and the controls inside each screen.

**Upgrading from 0.8.0:** pulling the new image is enough (no compose change). Local mode and app casting need the new APK from the release page (`iptv-multiview.apk`); they were compiled by the release workflow but could not be run on a device before release, so try local mode on the Shield / phone and switch it off in Settings if the picture is wrong.

## 0.8.0 - 2026-11-07
Light theme that follows the device, harder logins, clean shutdown and the repo docs the app spec asks for.
- **Theme** (P-22): Settings > Theme with System (the default, follows the device's light or dark setting), Light and Dark. It changes menus, dialogs, lists and the pull-out menu; the video area stays black. The setting is per device.
- **Login protection** (P-19): the app already blocked an address after 8 wrong passwords. It now also locks the *account* (so guesses from many addresses count together) and can use the real client address behind Caddy or Cloudflare: set `TRUST_PROXY=1`, otherwise everyone shares the proxy's address. Every response now carries a Content-Security-Policy (own scripts plus Google's Cast sender, no inline scripts, nobody can frame the page), `X-Frame-Options: DENY`, `nosniff` and `no-referrer`. The offline page's script moved to `/offline.js` for the policy.
- **Clean shutdown** (P-20): the image runs under tini (PID 1), so `docker stop` passes SIGTERM on and ffmpeg children are cleaned up; the app logs "Received SIGTERM", stops streams, recordings and shared screens, and exits within a second (a hard stop after 8 s as a safety net). A test starts the real server and checks the exit.
- **Healthcheck and tests** (P-21): the image, `docker-compose.yml`, `stack.yml` and the new `deploy/compose.yaml` healthchecks now require `"status":"ok"` in the answer, not just any HTTP 200. New `test/hardening.test.js`: security headers on every response, no inline scripts, `/healthz` sets no cookie, login lockout per account and per proxied address, SIGTERM exit, healthcheck/tini/`$PORT`, manifest and icon sizes, the release workflow trigger, version files in step.
- **Repo docs** (P-23): `docs/functional-spec.md` (what the app does now), the pending log moved to `docs/pending-changes.md`, `deploy/compose.yaml` and `deploy/.env.example` (image-based stack, `PORT` in `.env`). Release flow unchanged (push to `main`).

**Upgrading from 0.7.2:** pulling the new image is enough. Optional: set `TRUST_PROXY=1` on the container when it sits behind Caddy / Cloudflare (so a lockout hits the offender, not everybody), and update the healthcheck in your compose to the stricter one in `deploy/compose.yaml`. The Android app is rebuilt with the same page; nothing to change on the TV.

## 0.7.2 - 2026-10-22
Releases no longer need a tag push. No change to the app itself.
- The release workflow now runs on a push to `main` that changes the version in `package.json`: it fails if the tag `vX.Y.Z` already exists or the CHANGELOG entry is missing or empty, builds and pushes `X.Y.Z`, `X.Y` and `latest`, then `gh release create vX.Y.Z --target $GITHUB_SHA` creates the release and the tag. The Android app is attached to that release afterwards. Pushes to `main` that do not change the version build nothing.
- A tag pushed by hand still works as a fallback (refused when the release already exists); runs are queued so the two cannot both release a version.
- README: new *Releasing* section.

**Upgrading from 0.7.1:** pulling the new image is enough; no stack or compose change other than the image tag.

## 0.7.1 - 2026-10-22
Health check: `/healthz` now reports the version.
- `GET /healthz` answers `{"status":"ok","version":"<version>"}` (JSON, `Cache-Control: no-store`) on the app's port, with no login, no private data and no checks of outside services. The version is the one in `package.json`, which equals the image tag.
- The image's HEALTHCHECK has a 30 s start period (was 10 s), and `stack.yml` / `docker-compose.yml` now carry the same check (`wget` to `127.0.0.1:$PORT/healthz`, every 30 s, 5 s timeout, 3 retries, 30 s start period).
- Tests: JSON body with exactly `status` and `version`, equal to `package.json`; reachable without a login when accounts or basic auth are on.

**Upgrading from 0.7.0:** pulling the new image is enough to run it (the image carries its own health check). To get the check in your stack too, update the stack from `stack.yml` (new `healthcheck:` block, new image tag).

## 0.7.0 - 2026-10-19
Publish a multiview as one stream, and a fix for taps on the screens.
- **Publish as layout or as one stream (P-12).** *Publish my current screen...* now asks how: *Layout only* (as before: viewers get the channels and arrangement and their own device plays each tile) or *Screen as one stream* (with a picture quality of 480p / 720p / 1080p): the server combines the screen into one picture, with the sound of the tile that was selected when you published, and viewers simply play that. The picture is fixed as published; it follows the multiview only when you update it (*Edit and update from my screen...*, which also lets you change the type). The published layout is kept indefinitely; the server connects to the channels and encodes only while someone is watching, and everyone watching the same published screen shares one encode and one provider connection per channel (5 viewers of a 4-tile stream use 4 connections and 1 shared-screen slot). Visible to everyone with a login, or only the people you pick (as before). The list shows *one picture* on such entries; admins get a *Watch* button to see it as viewers do. When no shared-screen slot is free (`COMPOSE_MAX`), the viewer is told and gets the published layout with their own tiles instead. API: `GET /api/views` entries now have `mode` (`layout` | `stream`) and, for streams, `stream` (the picture description that clients post to `/api/compose`); `POST`/`PUT /api/views` accept `mode` and `stream`. Multiviews published before this are layouts.
- **Tap behaviour (P-13).** With the controls hidden, a tap on any screen only brings the controls up (it no longer selects that screen). With the controls up, a tap on the active screen (red box, has the sound) zooms it, and a tap on an inactive screen makes it active without zooming. To pick another screen: tap once to bring the controls up, then tap the screen. Also: Arrow Up from the options arrow goes to the first option.
- Tests: published stream description and validation, the viewer playing the fixed picture, the no-free-slot fallback, the publish dialog and the tap rules.

**Upgrading from 0.6.1:** pulling the new image is enough; no stack or compose change (`views.json` gains two fields for new entries and older entries keep working).

## 0.6.1 - 2026-10-19
Fix: the rewind folder can now be a bind or volume mount.
- The rewind folder was removed and recreated at start; on a mount point that fails (EBUSY/EACCES) and rewind was silently switched off. It is now emptied but kept, in the server start-up and in the per-channel buffer.

**Upgrading from 0.6.0:** pulling the new image is enough; no stack or compose change.

## 0.6.0 - 2026-10-18
Mini player and a LIVE indicator.
- **LIVE indicator (next to the progress bar).** A red LIVE box while watching live; light grey and partly transparent when you are 3 s or more behind live or paused. Tap it to jump back to live. The time behind shows beside it (`-1:30`, or `Paused`). Not shown for movies and episodes.
- **Mini player.** New button at the top right of the overlay (the cast icon moved left of it). In the Android app it turns the whole screen arrangement into a floating window (system picture-in-picture) and starts by itself when you press Home or switch apps while something is playing; the page hides its controls while floating and sound stays on. In desktop Chrome / Edge the button moves the whole arrangement into a small always-on-top window (closing it puts it back). In other browsers it floats the selected channel (or the shared screen) as one video; browsers that allow it also start it when you leave the tab.
- Android app: needs the new APK (`supportsPictureInPicture`, native bridge `enterPip` / `setAutoPip`); the page part works without it.
- Tests: LIVE states and tap-to-live, mini player button placement, browser and app paths.

**Upgrading from 0.5.0:** pulling the new image is enough; no stack or compose change. Install the new APK on the TV/phone for the automatic floating player.

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
