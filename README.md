# IPTV Multiview

A self-hosted web app for Xtream Codes IPTV providers. It does two things:

1. **Relay with a buffer.** The server pulls each channel from your provider once, keeps a rolling buffer, and serves it to your screens. Two tiles (or two devices) watching the same channel use **one** provider connection. A dropped provider connection is retried without dropping your screens.
2. **Multiview page.** Up to 9 live channels at once, in a 3x3 grid or in a "1 big + 7 small" layout (big tile top-left, 3 on the right, 3 along the bottom, 1 in the bottom-right corner). Works with a mouse, a touch screen, and a TV remote.

Also: a **programme guide** (grid of what is on, pick a channel from it, search programmes), **movies and series** from your provider, **local capture cards** as channels, a **remembering channel picker**, buffers of up to **5 minutes**, and an **Android TV / Nvidia Shield app**.

Several providers can be added; each one adds its own connections, and the app can fall back to another provider when one is full.

**Logins and shared multiviews.** Create separate logins for other people, arrange a multiview once, and publish it. A viewer logs in, clicks the multiview, and watches. They never see your provider details or channel lists, and they can only play channels that are in a multiview shared with them.

## Quick start

```bash
docker compose up -d --build
```

Open `http://<server-ip>:1234` on the PC, and the same address in the Android TV box's browser (a Chrome-based browser works best).

First run opens the **Providers** window: enter the server URL, username and password from your provider and press **Test**. It reads how many connections your plan allows and fills that in. Add as many providers as you like. Then pick a tile, press Enter (or click it) and choose a channel.

**Dockhand / prebuilt image:** create a stack from `stack.yml` (it uses `mybadreligon/multiview-iptv:0.4.0` from Docker Hub). Add `ADMIN_USER` / `ADMIN_PASSWORD` under environment if the port is reachable beyond your LAN.

Without Docker: `node src/server.js` (Node 20+, no packages to install). Settings are stored in the `/data` volume (`providers.json`, channel list cache).

## Android TV / Nvidia Shield app

Each release has an APK on the GitHub releases page (`iptv-multiview.apk`): a full-screen web view around this same page, with a TV launcher icon. Install it on the Shield by sideloading:

1. On the Shield: Settings > Device Preferences > Security & restrictions > *Unknown sources* > allow **Downloader** (install the free *Downloader* app from the Play Store first).
2. Open Downloader and enter `https://github.com/jameshoffman7667/multiview-iptv/releases/latest/download/iptv-multiview.apk`, then Install.
3. Start *IPTV Multiview*. The first time it asks for the address of your server (for example `192.168.1.20:1234`, the machine running the container). It is remembered. To change it later: Settings in the app > *Server address (TV app)*, or press Menu on a remote that has one.

The remote works like a keyboard: arrows move between tiles, OK opens the tile menu, Back closes windows (and exits at the top level). You log in on the TV once and it stays logged in.

Things to know: the app uses the Shield's Chromium web view for decoding, which handles H.264 video and AAC audio but **not AC-3/E-AC-3 or MP2 audio** (those channels would play without sound); a native-player version would be the fix and is not built yet. Updates install over the old app only if the release was signed with the same key; the build uses a stable key when the repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` exist (see *Building the app* below), otherwise uninstall the old app first. If you use the app on a phone or tablet it also works; there is no touch-specific layout beyond the web page itself.

### Building the app
GitHub Actions builds it after the Docker image is published (job `android`). To get a stable signing key, create one once and store it as repository secrets:

```bash
keytool -genkeypair -v -keystore release.keystore -alias iptv -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 release.keystore      # paste into the secret ANDROID_KEYSTORE_BASE64
```
Then add `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`iptv`) and `ANDROID_KEY_PASSWORD`. Keep a copy of the keystore: losing it means users must uninstall to update.

## Programme guide, movies and series

Open the channel picker (click an empty tile, or press C). It has four tabs:

- **Live** - the channel list as before.
- **Guide** - channels down the left, time across (3 hours; *Earlier / Now / Later* move the window). The programme airing now is highlighted. Click a channel or a programme to put that channel on the tile. Arrow keys move along a row and between rows. Typing in the search box searches **programme titles** for the next 24 hours (needs the provider's guide file; without it the search falls back to channel names). The guide comes from the provider's XMLTV file (downloaded once, cached for 4 hours) or, if there is none, from the provider's per-channel guide. Tiles show *Now: ...* under the channel name (Settings > *Show what's on now*).
- **Movies** and **Series** - the provider's on-demand library with categories and search. A series opens a list of seasons and episodes. A movie or episode plays in the tile through the server, so seeking works (use the tile's own controls, or the tile menu: *Back/Forward 30 seconds*). It counts as one connection at your provider while it plays; a finished movie releases its slot after a few seconds. The browser plays what it can decode: H.264/AAC in MP4 works; MKV, HEVC or AC-3 files often do not (the tile says so). Watching a movie does not use the live relay's buffer.

The picker **remembers where you were**: provider, tab, category, search words, the Favorites toggle, how many rows you had expanded, the scroll position and the channel you picked last. Reopen it and it is back on that spot, with the last channel highlighted (also after a reload; kept per browser). **Reset filters** clears all of it.

## Local capture card as a channel

A capture card (HDMI-to-USB dongle, TV tuner card with a V4L2 driver) plugged into the machine that runs the container can be a channel. Linux hosts only.

1. Pass the devices into the container (see `stack.yml`): `devices: [/dev/video0:/dev/video0, /dev/snd:/dev/snd]`, then restart the stack.
2. *Providers > Add capture card*. Pick the video device (the app lists what the container can see), the audio device (e.g. `hw:1,0`), resolution, frame rate and bitrate. You can add several sources. Typing `test` as the video device gives a built-in test pattern, handy for checking the setup without hardware.
3. Save. The sources appear in the channel picker under the capture card's name and work in multiviews and shared multiviews like any channel.

The server runs `ffmpeg` and encodes the card to H.264 + AAC MPEG-TS, once per source, however many people watch. It uses no provider connection but does use CPU (the *Encoder* option can use an Intel/AMD GPU through VAAPI or an NVIDIA GPU through NVENC when the container has access to them; software x264 works everywhere). HDMI sources with HDCP copy protection cannot be captured. The container user is added to the groups that own the devices at start-up.

## Lower quality for small tiles, shared screen, 480p transcode

- **Small tiles prefer SD** (Settings, on by default): a tile that is a sixth of the screen or less asks for the provider's SD / low-quality version of the channel (matched by name, `ESPN SD` for `ESPN FHD`) when one exists, at any enabled provider; otherwise it plays the channel you chose. Tile menu > *Quality* overrides it per tile (Auto / SD / As chosen / 480p transcode). The stats overlay (`I`) shows `SD`.
- **Shared screen** (Settings > Shared screen: 480p / 720p / 1080p): the server combines the visible tiles into ONE H.264 stream and the page just plays it, for boxes that struggle with many streams (Fire TV Stick, Google TV). The server encodes only while someone watches. Selecting another tile moves the sound to it (the picture restarts for a moment). Zooming a tile sends only that channel. Movies and series are not part of the picture and keep playing on their own. Decoding and scaling of the inputs happens on the server CPU; the encode can use the GPU.
- **480p tile transcode** (tile menu > Quality): the server re-encodes that one channel at 480p. It needs a GPU encoder (or `TRANSCODE_ALLOW_CPU=1`); if it is declined the original plays.
- **GPU encoding.** Pass `/dev/dri` into the container (`devices:` in `stack.yml`; with Proxmox the GPU must first be passed through to the VM/LXC that runs Docker). Settings > Shared screen has *Test CPU encoder* and *Test GPU encoder* buttons. Intel Quick Sync (UHD 630) is usually the better choice than an older AMD card (Polaris encodes H.264 only, which is all that is needed). Limits are set with `COMPOSE_MAX` and `TRANSCODE_MAX`.

## Logins and sharing a multiview

Out of the box there are no logins: anyone who can open the page is an admin. To turn logins on, open **Logins** (top right) > *Users and logins*, create your admin account, and you are logged in. From then on everyone must log in. (Or set `ADMIN_USER` and `ADMIN_PASSWORD` before the first start to create the admin account that way.)

- **Admin** - everything: providers, channel picking, users, publishing.
- **Viewer** - sees only the multiviews published for them. They can mute, zoom, change the buffer and go fullscreen, but cannot change channels or layout.

To publish: set up a layout and channels on your own screen, then **Multiviews > Publish my current screen**. Name it. Under **Who can see it** choose everyone with a viewer login or specific people. A viewer who has just one multiview lands straight in it after logging in; with several they get a list. If you change a published multiview (**Update from my screen**), people who are watching switch over within about 15 seconds. Clicking a multiview's name as admin loads it onto your screen for editing.

Each user has **Max streams**, the number of tiles they can play at once (default 9 for viewers). Remember that every distinct channel uses one connection at your provider; several people watching the *same* channel share one. All viewers draw from the same provider connections, so the total is still capped by your plans. Disabling or deleting a user, or changing their password, signs them out and cuts off their streams immediately.

Passwords are stored hashed (scrypt). Sessions last 30 days and are kept in the data volume, so a container update does not log everyone out. After 8 wrong passwords from one address, logins from it are blocked for 5 minutes. Browsers send the login cookie only to this site. If you open the app to the internet, put it behind HTTPS (a reverse proxy) so passwords are not sent in clear text.

## Controls

| Key | Action |
|---|---|
| Arrow keys | move between tiles (the selected tile has the sound). Up from the top row goes to the toolbar |
| OK / Enter | tile menu: change channel, mute, make main, zoom, reload, favorite, remove |
| 1 - 9 | jump to a tile |
| M / L / F | mute, next layout, fullscreen |
| S / Z / C / R | make main (swap with tile 1), zoom, change channel, reload |
| I | show stats on tiles (resolution, buffer seconds, dropped frames) |
| Back / Esc | close a window |

Mouse: click selects (and moves the sound), double-click zooms, right-click or the `...` button opens the tile menu. Touch: tap selects, tap again opens the menu. The layout, channels and favorites are remembered per browser.

## How the buffering works (and what to tune)

Lag and stutter come from three places; this app addresses the first two.

- **Provider hiccups.** The relay keeps reading from the provider, retries on drops and keeps your screens connected. Several viewers of one channel cost one connection.
- **Slow starts and short stalls on your side.** Settings > *Start playing after* (default 4 s, up to 5 minutes) makes each tile wait for that much video before it starts, and re-fill after a stall; *Keep up to* is the largest cushion kept while playing (it jumps forward to live only beyond it). A joining viewer is sent up to that much from the relay's buffer starting at a keyframe, so a tile on a channel that is already running starts at once with the cushion in place. A tile on a channel nobody is watching has to collect the cushion in real time, so with 2 minutes it shows *Buffering 40 / 96 s* and the picture starts about 96 seconds behind live. A bigger buffer = smoother but more delay behind live, and it costs memory: roughly 0.5 MB per second per tile in the browser (4 Mbps channel), and on the server up to `RING_MB` per channel. *Off* gives the lowest delay.
- **Weak playback hardware.** Nine HD streams are heavy for a TV box. If tiles drop frames (press `I` to see it), use the 1 + 5 or 2 x 2 layout, or choose SD/lower-bitrate channel variants for the small tiles. The relay does not transcode.

Tuning: `RING_MB` (default 32) is the relay buffer per channel, about a minute of an HD channel at 4 Mbps (memory is only used as the buffer fills). For buffers of several minutes raise it, e.g. `RING_MB=256`, and check the host has the RAM for the channels you watch at once. `STALL_SECONDS` (15) is how long the provider may send nothing before the relay reconnects.

## Several providers

- Each provider has its own **max connections**. The relay never opens more than that. When a tile needs a connection and the provider is full, the relay first frees a stream nobody is watching, then (if *Use another provider when the chosen one is full* is on) looks for the same channel at your other providers. Channels are matched by name after removing prefixes and quality tags (`US| ESPN HD` matches `ESPN`), using the channel lists the app has already downloaded. Different naming at the other provider means no match, so a tile shows "No free provider connection" and retries.
- The **Providers 3/6** button counts only connections made by this app. If you also watch with the provider's own app on the same account, those count against your plan too.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 1234 | listen port |
| `DATA_DIR` | `/data` in Docker | where the app keeps its files inside the container (`providers.json`, `users.json`, `views.json`, sessions, channel cache) |
| `DATA_PATH` | `iptv-data` volume | compose/stack only: what is mounted at `/data`. Set it to a host folder such as `/srv/iptv` (owned by uid 1000) to keep the data there, or leave it for the named volume |
| `ADMIN_USER`, `ADMIN_PASSWORD` | none | creates the first admin account at start, only if no accounts exist yet |
| `BASIC_AUTH` | none | optional extra `user:password` gate in front of everything (separate from the user logins above) |
| `RING_MB` | 32 | relay buffer per channel in MB (about 1 minute of an HD channel). Needs raising for buffers longer than that |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary used for capture cards |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | render device used when a capture source selects the VAAPI encoder |
| `COMPOSE_ENCODER` | `auto` | encoder for the shared screen and 480p transcodes: `auto` (GPU when `/dev/dri` is present, else CPU), `vaapi`, `x264`, `nvenc` |
| `COMPOSE_MAX`, `TRANSCODE_MAX` | 2, 2 | shared screens / 480p channel transcodes allowed at once |
| `TRANSCODE_ALLOW_CPU` | off | set to `1` to let 480p tile transcoding use the CPU (otherwise it needs a GPU encoder) |
| `COMPOSE_IDLE_SECONDS` | 8 | stop a shared screen / transcode this long after its last viewer leaves |
| `IDLE_SECONDS` | 8 | keep a channel's provider connection this long after the last viewer leaves (quick switching back). It is released at once if another channel needs the slot |
| `STALL_SECONDS` | 15 | reconnect if the provider sends nothing for this long |
| `CLIENT_QUEUE_MB` | 8 | a viewer that falls this far behind is disconnected (the page reconnects it) |
| `USER_AGENT` | `VLC/3.0.20 LibVLC/3.0.20` | sent to the provider; some panels block unknown agents |

## Security

Your provider credentials stay on the server; the browser only sees channel ids. Until you create the first account, anyone who can reach the port is an admin. Create it before sharing the address. Anyone with an admin login can add providers and make the server fetch the URLs they enter, so make only people you trust admins. Putting your provider's account in front of other people can break the provider's terms (some forbid sharing a subscription), so check yours.

## Troubleshooting

- **Many streams / buttons stop responding:** browsers allow only about 6 plain-HTTP connections to one address, so the page streams over WebSockets (up to 9 at once). Behind a reverse proxy, allow WebSocket upgrades on `/ws/` (nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` and a long `proxy_read_timeout`). If WebSockets are blocked, the page falls back to plain HTTP automatically (Settings > Stream delivery), limited to about 6 streams.
- **Container restarts with "permission denied" on /data:** the image fixes ownership at start-up; if the folder is on a network share that refuses `chown`, make it writable for user 1000.
- **"No free provider connection"**: every connection your plan allows is in use. Close a tile, add another provider, or raise *Max connections* if your plan really allows more.
- **Black tile / "can't play this channel's format"**: the browser cannot decode that channel. Browsers generally handle H.264 + AAC; HEVC, AC-3/E-AC-3 and MP2 audio depend on the browser and device. Try another variant of the channel.
- **Login rejected on Test**: check URL, username and password; some providers want the URL without a trailing path.
- **Channels with only HLS (.m3u8)**: not supported; the relay expects MPEG-TS (`/live/user/pass/id.ts`), which standard Xtream panels provide.
- **Constant stutter on every tile**: watch `docker logs iptv-multiview` for "stalled" or retry lines (provider side), then the stats overlay (`I`) for dropped frames (device side).

## Tests

`npm test` runs the relay, accounts, guide, movies, capture, SD-variant and shared-screen tests (Node only, a mock Xtream provider, and ffmpeg for the capture test; no packages). `test/ui.test.mjs` drives the page in Chromium and needs Playwright (dev only).

Bundled: mpegts.js 1.8.2 (Apache-2.0, `public/vendor/`).
