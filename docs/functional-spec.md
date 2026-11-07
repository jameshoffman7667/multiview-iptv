# IPTV Multiview - functional spec (current state, v0.8.0)

Edited in place on every release; it describes what the app does now, not its history (see `CHANGELOG.md`).

## Purpose
A self-hosted relay and browser UI for Xtream Codes IPTV providers. One shared provider connection per channel feeds any number of screens; the page shows up to 9 live channels at once. Node 22, no npm dependencies; ffmpeg for capture, shared screen, transcodes, recordings. An Android TV / phone app (WebView around the same page) is built by CI.

## Screens and controls
- **Multiview page** - layouts: Single, 2x2, 1+5, 3x3, 1+7 (9 tile slots). One selected tile has the sound (red outline). Keyboard/remote: arrows, OK, 1-9, M, L, F, S, Z, C, R.
- **Tap rules** - overlay hidden: any tap shows the overlay and selects nothing. Overlay shown: tapping the selected tile zooms it; tapping another tile selects it without zooming; a zoomed tile un-zooms on tap.
- **Player overlay** - change channel (guide), play/pause, skip back 10 s / forward 30 s, channel up/down, progress bar with LIVE button (grey when behind live), mute/volume, options row (layout, expand, make main, record, cast, mini player), left arrow opens the pull-out menu.
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
- **Cast** - `POST /api/cast` returns a short-lived `/cast/<token>.mp4` link for a Chromecast.
- **Capture cards** - local `/dev/video*` devices as channels.

## HTTP API (all JSON unless noted; login required except `/healthz`, `/api/me`, `/api/login`, cast links)
`/healthz` (public: `{"status":"ok","version":"X.Y.Z"}`), `/api/me`, `/api/login`, `/api/logout`, `/api/users[/<name>]`, `/api/views[/<id>]`, `/api/providers[/test]`, `/api/channels`, `/api/epg`, `/api/epg-search`, `/api/vod`, `/api/series`, `/api/state`, `/api/devices`, `/api/compose[/info|/test]`, `/api/recordings[/event]`, `/api/cast`, `/api/stream-error`; streams: `/stream/<provider>/<id>[.ts]` (HTTP) and WebSocket `/ws/...` (incl. `/ws/compose/<id>`), `/stream/compose/<id>`, `/vod/...`, `/recordings/<id>.<ext>`, `/cast/<token>.mp4`.

## Security
- Provider credentials stay on the server; the browser sees channel ids only. Passwords hashed with scrypt, files `0600`.
- Cross-site POST/WS refused (origin check). Optional `BASIC_AUTH` gate.
- Login lockout: 8 wrong passwords lock the address and the account for 5 minutes; `TRUST_PROXY=1` uses `CF-Connecting-IP` / `X-Forwarded-For` as the address.
- Every response: Content-Security-Policy (own scripts + Google's Cast sender, no inline scripts, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`.
- Runs as uid 1000 (entrypoint fixes folder ownership, then drops root). tini is PID 1; SIGTERM stops streams, jobs and connections and exits within about a second.

## Configuration (environment)
`PORT` (1234), `DATA_DIR` (/data), `ADMIN_USER`, `ADMIN_PASSWORD`, `BASIC_AUTH`, `TRUST_PROXY`, `REC_DIR`, `REWIND_DIR`, `REWIND_MINUTES`, `RING_MB`, `FFMPEG_PATH`, `VAAPI_DEVICE`, `COMPOSE_ENCODER`, `COMPOSE_MAX`, `TRANSCODE_MAX`, `TRANSCODE_ALLOW_CPU`, `COMPOSE_IDLE_SECONDS`, `IDLE_SECONDS`, `STALL_SECONDS`, `CLIENT_QUEUE_MB`, `USER_AGENT`, `TZ`. Details in `README.md`.

## Data (`/data`, `REC_DIR`, `REWIND_DIR`)
`providers.json`, `users.json` (hashed), `views.json` (layout/stream specs), sessions, channel cache; recordings in `REC_DIR`; rewind segments in `REWIND_DIR` (cleared at start).

## Health
`GET /healthz` on `$PORT`: 200 JSON `{status, version}`, no login, no private data, no outside checks. Image and compose healthchecks require `"status":"ok"`, use 127.0.0.1 and `$PORT`, 30 s start period.

## Known limits
- Browsers cannot play most provider streams directly (CORS, https page vs http stream, password exposure), so playback goes through the relay.
- Android WebView lacks AC-3/E-AC-3/MP2 audio and Chrome's Cast SDK.
- Many viewers of a published *screen* stream use server CPU/GPU; remote viewing is limited by the home upload speed.
- Pending, not built: player overlay inside each screen (P-16), local (direct) mode in the Android app (P-17), native cast in the Android app (P-18).
