# IPTV Multiview - functional spec (current state, v0.11.0)

Edited in place on every release; it describes what the app does now, not its history (see `CHANGELOG.md`).

## Purpose
A self-hosted relay and browser UI for Xtream Codes IPTV providers. One shared provider connection per channel feeds any number of screens; the page shows up to 9 live channels at once. Node 22, no npm dependencies; ffmpeg for capture, shared screen, transcodes, recordings. An Android TV / phone app (WebView around the same page) is built by CI.

## Screens and controls
- **Multiview page** - layouts: Single, 2x2, 1+5, 3x3, 1+7 (9 tile slots). One selected tile has the sound (red outline). Keyboard/remote: arrows, OK, 1-9, M, L, F, S, Z, C, R.
- **Tap rules** (the controls live inside each screen) - 1st tap, controls hidden: they come up on the tapped screen, nothing is selected. 2nd tap: a screen that is not selected becomes selected and the controls stay on it; on the selected screen it counts as the 3rd tap. 3rd tap: a playing screen zooms (tap a zoomed screen to go back); an empty screen opens the channel selection (admins). With the controls up, tapping another screen selects it and moves the controls there.
- **Player controls** - cover only the tapped screen (compact buttons on small screens); the menu arrow, cast, mini player and **fullscreen** buttons stay at the page edges (fullscreen is hidden where the browser has none and in the Android app). Change channel (guide), play/pause, skip back 10 s / forward 30 s, channel up/down, progress bar with LIVE button (grey when behind live), mute/volume, options row (layout, expand, make main, record, cast, mini player), left arrow opens the pull-out menu.
- **Pull-out menu** - Watch, Multiviews, Recordings & Downloads, Settings, Providers, Logout.
- **Settings** (per device, in the browser): buffer, keep-behind, stream delivery (WebSocket or HTTP), fit/fill, shared screen quality, failover, small tiles prefer SD, web workers, stats, channel names, programme guide, **Theme (System / Light / Dark)**.
- **Theme** - default System (follows the device); Light and Dark override it. Applies to menus, dialogs and lists; the video area is black in every theme.
- **Channel picker** - search, categories, favourites, programme-guide grid with programme search, movies and series from the provider, capture cards as channels.
- **Mini player** - Picture-in-Picture: Android app PiP, Document PiP, or a single-video PiP.
- **PWA** - installable; service worker caches only the app shell (page, scripts, styles, icons, offline page); never video, API answers, recordings, casts or login pages.

## Accounts and sharing
- No accounts: everyone who can reach the port is an admin. First account (UI or `ADMIN_USER`/`ADMIN_PASSWORD`) becomes admin and logs in.
- Roles: admin (providers, picking, users, publishing) and viewer (sees only multiviews shared with them; Max streams per user, default 9).
- Published multiviews: **Layout only** (viewer devices play each tile) or **Screen as one stream** (server composites; all viewers share one job). Layout details are kept; connections and ffmpeg run only while someone watches.
- Sessions: 30 days, HttpOnly SameSite=Lax cookie (Secure behind https), stored in the data volume.

## Server features
- **Relay** - per-channel ring buffer (`RING_MB`), one provider connection per channel, provider slot accounting, failover to another provider when full, idle release after `IDLE_SECONDS`.
- **Rewind** - disk buffer of the last `REWIND_MINUTES` (default 60, max 240) of each open channel; emptied (not removed) at start.
- **Recordings and downloads** - ffmpeg to `REC_DIR`, kept until deleted.
- **Shared screen / published stream** - ffmpeg composite (`COMPOSE_MAX`, default 2), encoder auto/vaapi/x264/nvenc; 480p tile transcodes (`TRANSCODE_MAX`, default 2).
- **Local mode (Android app, admins)** - Settings > Local mode (per device, off by default). The selected / zoomed screen is played by the app's native player straight from the provider (`GET /api/direct`, admin only, returns the provider stream address); one screen at a time, own provider connection, no rewind / record / cast / shared screen / published streams; automatic fallback to the server on any error.
- **Fantasy score pop-ups (admins only)** - `src/fantasy.js` keeps one read-only SSE connection to Fantasy Manager (`FANTASY_URL`, `FANTASY_TOKEN`; needs its 4.17.0 ticker API) and relays score events to admin pages: `GET /api/fantasy/status`, `GET /api/fantasy/stream` (SSE, `?recent=<s>` catch-up), `GET /api/fantasy/headshot/<id>` (cached in memory 24 h). The page shows one pop-up at a time (5 s, queued, same player merged, slides from the top, before-values and 0 for 0.5 s then a roll-up, no background). Settings (per device, in Settings > *Show a pop-up when a player scores*): on/off, smallest score (default 3), delay 0-180 s, opponents' players, size, drop-if-late (default 60 s), sample pop-up button. Negative changes and corrections never pop up. Off when the two variables are empty.
- **Fantasy ticker (admins only, P-25)** - the same link also polls `GET /api/ticker/summary` (15 s while a game is live, 60 s otherwise, and about 1.5 s after a score event; cleaned to starters, `src/fantasy.js` `cleanSummary`) and serves it at admin-only `GET /api/fantasy/summary`. The page (`public/app.js`, `FT*`) draws an opaque 56 px bar (48 px on phones) along the bottom: per league a pinned block (sticky league name at the left edge, then `my - opp` scores; team names under the scores fade once pinned) followed by both starting lineups in slot order (pre: game time; live: points and bracketed stats; final: light grey). The tape is JS-scrolled with copies for a seamless loop. A player coming on screen with more points than last time on screen for that side (`mine|playerId` / `opp|playerId`, across leagues) glows green/red and rolls up, and the team total rolls with him; first sight is a baseline. Settings: ticker on/off, position (Below the video, default: `.grid` and the shared picture end above the bar; or Overlap), speed. League name is plain white.
- **Cast** - `POST /api/cast` returns a short-lived `/cast/<token>.mp4` link for a Chromecast. Chrome uses the web Cast SDK (https); the Android app (phones and tablets with Google Play services, not TV boxes) uses a native Cast sender with the default media receiver.
- **Capture cards** - local `/dev/video*` devices as channels.

## HTTP API (all JSON unless noted; login required except `/healthz`, `/api/me`, `/api/login`, cast links)
`/healthz` (public: `{"status":"ok","version":"X.Y.Z"}`), `/api/me`, `/api/login`, `/api/logout`, `/api/users[/<name>]`, `/api/views[/<id>]`, `/api/providers[/test]`, `/api/channels`, `/api/epg`, `/api/epg-search`, `/api/vod`, `/api/series`, `/api/state`, `/api/devices`, `/api/compose[/info|/test]`, `/api/recordings[/event]`, `/api/cast`, `/api/direct` (admin), `/api/stream-error`; streams: `/stream/<provider>/<id>[.ts]` (HTTP) and WebSocket `/ws/...` (incl. `/ws/compose/<id>`), `/stream/compose/<id>`, `/vod/...`, `/recordings/<id>.<ext>`, `/cast/<token>.mp4`.

## Security
- Provider credentials stay on the server; the browser sees channel ids only. Passwords hashed with scrypt, files `0600`.
- Cross-site POST/WS refused (origin check). Optional `BASIC_AUTH` gate.
- Login lockout: 8 wrong passwords lock the address and the account for 5 minutes; `TRUST_PROXY=1` uses `CF-Connecting-IP` / `X-Forwarded-For` as the address.
- Every response: Content-Security-Policy (own scripts + Google's Cast sender, no inline scripts, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`.
- Runs as uid 1000 (entrypoint fixes folder ownership, then drops root). tini is PID 1; SIGTERM stops streams, jobs and connections and exits within about a second.

## Configuration (environment)
`PORT` (1234), `DATA_DIR` (/data), `ADMIN_USER`, `ADMIN_PASSWORD`, `BASIC_AUTH`, `TRUST_PROXY`, `FANTASY_URL`, `FANTASY_TOKEN`, `REC_DIR`, `REWIND_DIR`, `REWIND_MINUTES`, `RING_MB`, `FFMPEG_PATH`, `VAAPI_DEVICE`, `COMPOSE_ENCODER`, `COMPOSE_MAX`, `TRANSCODE_MAX`, `TRANSCODE_ALLOW_CPU`, `COMPOSE_IDLE_SECONDS`, `IDLE_SECONDS`, `STALL_SECONDS`, `CLIENT_QUEUE_MB`, `USER_AGENT`, `TZ`. Details in `README.md`.

## Data (`/data`, `REC_DIR`, `REWIND_DIR`)
`providers.json`, `users.json` (hashed), `views.json` (layout/stream specs), sessions, channel cache; recordings in `REC_DIR`; rewind segments in `REWIND_DIR` (cleared at start).

## Health
`GET /healthz` on `$PORT`: 200 JSON `{status, version}`, no login, no private data, no outside checks. Image and compose healthchecks require `"status":"ok"`, use 127.0.0.1 and `$PORT`, 30 s start period.

## Known limits
- Browsers cannot play most provider streams directly (CORS, https page vs http stream, password exposure), so playback goes through the relay.
- Android WebView lacks AC-3/E-AC-3/MP2 audio and Chrome's Cast SDK (the app's local mode and native cast cover both for the screen they apply to).
- Many viewers of a published *screen* stream use server CPU/GPU; remote viewing is limited by the home upload speed.
- Local mode and app casting were built without being run on a device (the build session could not compile or run Android); treat them as new.
- Score pop-ups: they cannot be earlier than Fantasy Manager's own score update (about 15-60 s after Sleeper shows it); the delay setting only adds time. On a phone-width screen the pop-up shrinks to fit and is hard to read. The ticker shows what the last summary said (up to about a minute behind Sleeper); stat lines can lag the points by a minute or two. On a phone-width screen the pinned block takes much of the bar.
- Local mode: phase 1 is one screen; several native screens at once (phase 2) is not built.
