# IPTV Multiview

A self-hosted web app for Xtream Codes IPTV providers. It does two things:

1. **Relay with a buffer.** The server pulls each channel from your provider once, keeps a rolling buffer, and serves it to your screens. Two tiles (or two devices) watching the same channel use **one** provider connection. A dropped provider connection is retried without dropping your screens.
2. **Multiview page.** Up to 9 live channels at once, in a 3x3 grid or in a "1 big + 7 small" layout (big tile top-left, 3 on the right, 3 along the bottom, 1 in the bottom-right corner). Works with a mouse, a touch screen, and a TV remote.

Several providers can be added; each one adds its own connections, and the app can fall back to another provider when one is full.

**Logins and shared multiviews.** Create separate logins for other people, arrange a multiview once, and publish it. A viewer logs in, clicks the multiview, and watches. They never see your provider details or channel lists, and they can only play channels that are in a multiview shared with them.

## Quick start

```bash
docker compose up -d --build
```

Open `http://<server-ip>:8080` on the PC, and the same address in the Android TV box's browser (a Chrome-based browser works best).

First run opens the **Providers** window: enter the server URL, username and password from your provider and press **Test**. It reads how many connections your plan allows and fills that in. Add as many providers as you like. Then pick a tile, press Enter (or click it) and choose a channel.

**Dockhand / prebuilt image:** create a stack from `stack.yml` (it uses `mybadreligon/multiview-iptv:0.1.0` from Docker Hub). Add `ADMIN_USER` / `ADMIN_PASSWORD` under environment if the port is reachable beyond your LAN.

Without Docker: `node src/server.js` (Node 20+, no packages to install). Settings are stored in the `/data` volume (`providers.json`, channel list cache).

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
- **Slow starts and short stalls on your side.** Settings > *Buffer before playing* (default 4 s) makes each tile wait for that much video before it starts, and re-fill after a stall. A joining viewer is sent the last few seconds from the relay's buffer starting at a keyframe, so the cushion is there immediately. A bigger buffer = smoother but more delay behind live. *Off* gives the lowest delay.
- **Weak playback hardware.** Nine HD streams are heavy for a TV box. If tiles drop frames (press `I` to see it), use the 1 + 5 or 2 x 2 layout, or choose SD/lower-bitrate channel variants for the small tiles. The relay does not transcode.

Tuning: `RING_MB` (default 16) is the relay buffer per channel, about 10-20 s of an HD channel. `STALL_SECONDS` (15) is how long the provider may send nothing before the relay reconnects.

## Several providers

- Each provider has its own **max connections**. The relay never opens more than that. When a tile needs a connection and the provider is full, the relay first frees a stream nobody is watching, then (if *Use another provider when the chosen one is full* is on) looks for the same channel at your other providers. Channels are matched by name after removing prefixes and quality tags (`US| ESPN HD` matches `ESPN`), using the channel lists the app has already downloaded. Different naming at the other provider means no match, so a tile shows "No free provider connection" and retries.
- The **Providers 3/6** button counts only connections made by this app. If you also watch with the provider's own app on the same account, those count against your plan too.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | listen port |
| `DATA_DIR` | `/data` in Docker | where `providers.json` and the channel cache live |
| `ADMIN_USER`, `ADMIN_PASSWORD` | none | creates the first admin account at start, only if no accounts exist yet |
| `BASIC_AUTH` | none | optional extra `user:password` gate in front of everything (separate from the user logins above) |
| `RING_MB` | 16 | relay buffer per channel |
| `IDLE_SECONDS` | 8 | keep a channel's provider connection this long after the last viewer leaves (quick switching back). It is released at once if another channel needs the slot |
| `STALL_SECONDS` | 15 | reconnect if the provider sends nothing for this long |
| `CLIENT_QUEUE_MB` | 8 | a viewer that falls this far behind is disconnected (the page reconnects it) |
| `USER_AGENT` | `VLC/3.0.20 LibVLC/3.0.20` | sent to the provider; some panels block unknown agents |

## Security

Your provider credentials stay on the server; the browser only sees channel ids. Until you create the first account, anyone who can reach the port is an admin. Create it before sharing the address. Anyone with an admin login can add providers and make the server fetch the URLs they enter, so make only people you trust admins. Putting your provider's account in front of other people can break the provider's terms (some forbid sharing a subscription), so check yours.

## Troubleshooting

- **"No free provider connection"**: every connection your plan allows is in use. Close a tile, add another provider, or raise *Max connections* if your plan really allows more.
- **Black tile / "can't play this channel's format"**: the browser cannot decode that channel. Browsers generally handle H.264 + AAC; HEVC, AC-3/E-AC-3 and MP2 audio depend on the browser and device. Try another variant of the channel.
- **Login rejected on Test**: check URL, username and password; some providers want the URL without a trailing path.
- **Channels with only HLS (.m3u8)**: not supported; the relay expects MPEG-TS (`/live/user/pass/id.ts`), which standard Xtream panels provide.
- **Constant stutter on every tile**: watch `docker logs iptv-multiview` for "stalled" or retry lines (provider side), then the stats overlay (`I`) for dropped frames (device side).

## Tests

`npm test` runs the relay and accounts tests (Node only, a mock Xtream provider, no packages). `test/ui.test.mjs` drives the page in Chromium and needs Playwright (dev only).

Bundled: mpegts.js 1.8.2 (Apache-2.0, `public/vendor/`).
