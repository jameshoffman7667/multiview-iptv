# Pending changes

Requests logged here are not built yet. Say "build" to fold them into a new version
(version number goes up, CHANGELOG.md is updated, this list is cleared), and "push" to upload to GitHub.
With every push, say whether the compose/stack file must change or whether pulling the new image is enough.
Every build rewrites deploy/RELEASE.md using the FULL template of the app spec (section 8: Update, Image, Short, Long, Release commit, Type, Port, Public hostname, env vars, Data, Resources, Healthcheck, Verify, PWA, Docker build, Rollback naming the exact previous tag, Known issues, Backup tier). Server tests use `wget` (no curl on vm101). The server's real stack file is the homelab repo's stacks/multiview-iptv/compose.yaml (stack.yml here is only a reference); never tell anyone to update the Dockhand stack. Fixed `Update:` line: `Update: now` only when the user said "build, push and update" for that release, otherwise `Update: later`.

Current released version: 0.15.0 (being pushed)

### P-1 - Rebuild the on-screen menu as a traditional video player overlay
Requested: 2026-10-18. Tap any screen (single view or multiview) to show a full-screen overlay over everything:
- top right: cast icon (only when casting is possible); top left: change-channel button (programme-guide icon, opens the channel picker)
- centre: play/pause with skip-back and skip-forward either side; right side: channel up / channel down; left side: arrow that opens the pull-out menu (P-2)
- bottom middle: progress bar; bottom left: mute button and volume bar
- arrow under the progress bar (up; turns down when open) that expands a row of options, left to right: 1 Layout (shows the current layout icon; all layout choices live here), 2 Expand (magnifying glass; replaces "zoom this tile"; tapping the same tile twice also expands), 3 Quality (filled TV icon with the current quality as text), 4 Reload (circular arrow), 5 Favourite (outline / filled star), 6 Record (red dot with REC: "to end of current event" with the stop time shown, or a chosen length; see P-5), 7 Download (down arrow with line: to server or to device; see P-6). Tapping an option opens its sub-options in a menu that grows upward from that icon; the arrow closes the row.
Type: minor-to-major (replaces the current top menu, tile menu and idle-hide behaviour)   Status: Built in 0.5.0
Decided 2026-10-18: controls act on the selected tile (a tap selects it first); skip back 10 s / forward 30 s; the 5 s idle auto-hide stays. Skip and progress bar rely on the live buffer (P-7). Decided 2026-10-18: every overlay control is reachable with the D-pad/remote on the Android TV app.

### P-2 - Left pull-out menu
Requested: 2026-10-18. Options: Watch (closes the menu and the overlays), Multiviews, Recordings & Downloads, Settings, Providers, Logout. Admin options move under Settings and are shown only to admins.
Type: minor   Status: Built in 0.5.0
Notes / questions: Recordings & Downloads is a new screen (list, play, delete, scheduled items) that depends on P-5 and P-6.

### P-3 - Cast to a Google device (Chromecast / Google TV)
Requested: 2026-10-18. Cast icon in the overlay (P-1).
Type: minor   Status: Built in 0.5.0
Notes / questions: Chrome's Cast needs the page on HTTPS (your Cloudflare hostname works, plain LAN http does not) and the Cast receiver must be able to reach the stream URL, so the server needs a cast-friendly H.264/AAC stream (the Shared-screen composite is the natural way to cast a multiview; a single channel can cast its own stream if it is H.264/AAC). Android TV app: needs the Cast SDK. Decided 2026-10-18: both are offered as options when casting (selected channel, or the whole multiview as one picture).

### P-4 - Local video capture source from the server's capture card
Requested: 2026-10-18. Route video from the capture card in the server box as a channel.
Type: minor   Status: Built in 0.5.0
Notes / questions: 0.3.0 already has Providers > Add capture card (V4L2 video + ALSA audio through ffmpeg, device passthrough in stack.yml). This entry: confirm it works with the card you buy, make it behave as a normal channel (favourites, recording, rewind), fix whatever is missing. The server is a Proxmox VM, so a USB card must be passed through to the VM and then into the container. Card recommendation given in chat.

### P-5 - Record live and future events
Requested: 2026-10-18. Record from the overlay (to end of current programme with stop time shown, or a set length) and schedule future programmes from the guide.
Type: minor   Status: Built in 0.5.0
Notes / questions: a recording holds a provider connection (shares the relay connection if the channel is already open); Decided 2026-10-18: files go to a folder set by a new environment variable in the deployment, separate from app data and the rewind buffer, so it can sit on a large slow disk (shared with P-6 downloads). Decided 2026-10-18: kept indefinitely, no size cap (deleted only by the user). Decided 2026-10-18: saved as .mp4; scheduled live-event recordings start 5 minutes early and end 60 minutes late (sports overtime), shown in the schedule screen and removable per recording. Decided 2026-10-18: if the provider is full at the start time the recording fails and shows an error (no interrupting what is being watched).

### P-6 - Download movies and series for offline viewing
Requested: 2026-10-18. Download to the server or to the device.
Type: minor   Status: Built in 0.5.0
Notes / questions: server download = background job into storage, listed in Recordings & Downloads and playable from the server; device download = browser download of the file (fine on phone/PC; the Android TV app has limited storage and no file picker). A download holds a provider connection while it runs. Decided 2026-10-18: server downloads use the same separate recordings/downloads folder as P-5. Decided 2026-10-18: kept indefinitely, no size cap.

### P-7 - Automatic 1-hour rewind buffer for live video
Requested: 2026-10-18. Live video is recorded automatically for up to 1 hour so the viewer can rewind.
Type: minor-to-major   Status: Built in 0.5.0
Notes / questions: buffer only channels being watched, on disk not RAM (about 2 GB per hour for a 4-5 Mbps channel, so a 6-tile multiview is about 12 GB, more at 1080p). Decided 2026-10-18: a new environment variable sets its folder, separate from app data and downloads, so it can sit on a fast disk; cleanup on close; the progress bar and skip buttons in P-1 depend on it; overlaps the existing "Start playing after / Keep up to" cushion setting.

### P-8 - Make the app an installable PWA
Requested: 2026-10-18. Installable on phone and desktop.
Type: minor   Status: Built in 0.5.0
Notes / questions: there is no manifest, service worker or icons yet. Plan: web manifest (standalone, icons 192/512/maskable, wide and narrow screenshots), a service worker that caches only the app shell and never streams, API calls or login pages (cache name tied to the app version), offline page, "update available" prompt, an Install button in Settings (iOS: Add to Home Screen instructions). Installing needs HTTPS, so it works through your Cloudflare hostname but not the plain LAN http address (Cloudflare Access, if used, must let the manifest, service worker and icons through). Also fits P-3 casting, which needs HTTPS too. The new overlay (P-1) must work in installed standalone mode at phone and desktop sizes.

### P-9 - Mini player that floats over other apps
Requested: 2026-10-18. A button at the top right of the overlay turns the current screen arrangement (single channel or the whole multiview) into a small floating player over other apps; it also starts by itself when the user closes or leaves the app.
Type: minor   Status: Built in 0.6.0
Notes / questions: what is possible differs by where it runs. Android TV / Android app: real system picture-in-picture of the whole page, so the arrangement is kept; it can start automatically on Home (needs a native change and a new APK). Desktop Chrome/Edge: Document Picture-in-Picture can float the whole arrangement, but only when the user presses the button (browsers do not allow it to start by itself on closing), and phone browsers and iOS only float one video. Proposed: button everywhere it works; automatic start in the Android app; in browsers, automatic only where the browser allows it, otherwise only the button. With the Shared screen on, the single combined picture can be floated as one video in any browser that supports picture-in-picture. The icon sits next to the cast icon (cast moves left of it). Decided 2026-10-18: plan confirmed as proposed; sound stays on in the mini player.

### P-10 - LIVE indicator in the overlay
Requested: 2026-10-18 (first asked for top left). Red box with the word LIVE while the stream is live; light grey and partly transparent while behind live. Tapping it jumps to live.
Type: minor   Status: Built in 0.6.0
Notes / questions: Decided 2026-10-18: it stays next to the progress bar, where the plain "LIVE" / "-0:10" text is now (that text becomes this indicator; while behind live the time behind can show beside it). "Behind live" means 3 seconds or more behind (rewound or paused). Hidden for movies and episodes.

### P-11 - Rewind folder cannot be a mount point (bug)
Requested: 2026-10-19. `src/server.js` (startup) and `src/rewind.js` (per-channel folder) remove the rewind directory itself with `fs.rmSync(dir, {recursive:true})` and recreate it. When `REWIND_DIR` is the root of a bind or volume mount (as in stack.yml's `/rewind`), removing the mount point fails with EBUSY/EACCES and rewind is silently disabled.
Type: patch (bug fix)   Status: Built in 0.6.1
Notes / questions: fix = empty the directory's contents (keep the directory), create it if missing, in both places; add a test that uses a pre-existing directory which cannot be removed; log a visible error instead of failing silently if emptying fails. Confirmed in the code on 2026-10-19. Same check to do for `REC_DIR`.

### P-12 - Publish a multiview for other clients to watch
Requested: 2026-10-19 (James: "a proper watch someone else's screen ... an option when publishing the multiview, whether just to publish the layout or the screen as one stream").
Type: minor (new feature)   Status: Built in 0.7.0
Notes / questions: when publishing a multiview, choose (1) Layout only: other clients see it in their Multiviews list and open it, each decoding its own tiles; or (2) Screen as one stream: the server keeps one composite (shared screen) encode running and other clients just play that single picture. Questions before building: (a) who can see published multiviews: all logged-in users, or chosen users? (b) does a viewer of the one-stream version get sound, and from which tile (the publisher's selected tile follows the publisher, or a fixed one)? (c) does the stream follow the publisher live (layout and channel changes) or is it a fixed snapshot? (d) does it keep running when the publisher leaves, and who can stop it (publisher, admin)? (e) each stream holds provider connections and one of the COMPOSE_MAX slots (default 2): what should viewers see when none is free? (f) a stop/unpublish button and a "Published" list with viewer counts. Related: the cast link already serves a private composite picture for 6 h without login; this would be the logged-in, in-app version.
Decided 2026-10-19: visible to all logged-in users. Sound is the publisher's (the tile that had the sound when published, fixed). Fixed as published (a snapshot, not following later changes). The published layout is kept indefinitely; connections and encoding run only while someone is watching. Provider connections: one per distinct channel in use, shared by everyone watching it (so 5 viewers of one 4-tile published stream use 4). Open: what viewers see when no shared-screen slot is free (see chat).
Decided 2026-10-19: when no shared-screen slot is free, viewers get a message and are offered the published layout instead (opens with their own tiles, no slot used).

### P-13 - Tap behaviour with the overlay up (bug)
Requested: 2026-10-19. (1) Overlay hidden: a tap on any screen only brings up the overlay; it does NOT select that screen (changed 2026-10-19: to pick another screen, tap once anywhere to bring up the overlay, then tap the screen). (2) Overlay shown: a tap on the active screen (red box, has the sound) zooms it; a tap on an inactive screen makes it active but does not zoom. Currently a tap on any tile zooms it while the overlay is up.
Type: patch (bug fix)   Status: Built in 0.7.0
Notes / questions: likely cause (to confirm when building): a tile takes focus on mouse/touch down and that already selects it, so by the time the click is handled the page thinks the tile was already active and zooms. Fix: remember which tile was active at the moment of the press and decide on that. The same rule applies to the remote's OK button and to taps while the overlay is shown on a multiview.

### P-14 - /healthz returns JSON with the version; matching healthchecks
Requested: 2026-10-22. GET /healthz on $PORT must answer `{"status":"ok","version":"<same as the image tag>"}`: no login, no private data, no checks of outside services. Add a matching HEALTHCHECK to the image and the compose file, 30 s start period.
Type: patch (small change)   Status: Built in 0.7.1
Notes / questions: today /healthz already exists, is public and answers plain text `ok`; the Dockerfile already has a HEALTHCHECK (start period 10 s) and stack.yml / docker-compose.yml have none. Plan: return JSON with the version from package.json (equals the image tag; tests already tie package.json, the service worker and the tag together), `Content-Type: application/json`, `Cache-Control: no-store`; image HEALTHCHECK start period 30 s; add the same check to stack.yml and docker-compose.yml (wget to 127.0.0.1:${PORT}, interval 30 s, timeout 5 s, retries 3, start_period 30 s); test that it needs no login even with logins on, contains nothing but status and version, and that its version equals package.json. Nothing else (providers, ffmpeg, disk) is checked.

### P-15 - Releases without a tag push
Requested: 2026-10-22. Release workflow triggers on a push to main that changes the version, checks tag/CHANGELOG, builds and pushes X.Y.Z, X.Y and latest, creates the release (and tag) with `gh release create vX.Y.Z --target $GITHUB_SHA`; tag trigger only as a fallback; docs say a release is commit and push main only.
Type: patch (build process, no app change)   Status: Built in 0.7.2
Notes: version file used: package.json (there is no VERSION file). First release under this workflow is 0.7.2.

### P-16 - Player overlay inside each screen, new tap sequence
Requested: 2026-10-26. Move the overlay from a full-screen layer into each individual screen (tile). Tap sequence: 1st tap on a screen opens its overlay; 2nd tap selects the screen if it is not already selected, otherwise it acts as the 3rd tap; 3rd tap opens the channel screen (change channel / guide).
Type: major-ish minor (reworks P-1 overlay layout and P-13 tap rules)   Status: Built in 0.9.0
Notes / questions: (a) with the overlay shown on screen A, a tap on screen B: select B and move the overlay to B, or only select? (b) does the zoom-on-tap of the active screen go away (zoom stays in the options row as Expand)? (c) screens are small in a 3x3 / 4x4 layout: show the full control set only when the screen is large enough, otherwise a reduced set (play/pause, mute, LIVE, options arrow) - acceptable? (d) the pull-out menu arrow, cast and mini player buttons are page-level, not per screen: keep them as a thin page overlay when any screen's overlay is up? (e) viewers (no change-channel rights): the 3rd tap does nothing; (f) the remote/keyboard flow (Enter shows controls, arrows move between them) should follow the selected screen. Not built.
Decided 2026-10-30 (P-16): (1) with the overlay up on screen A, a tap on screen B selects B and moves the overlay to B. (2) The third tap: if the screen already has a channel playing it zooms it; if the screen is empty it opens the channel selection; a tap on a zoomed screen un-zooms it. (Changing the channel of a playing screen stays on the change-channel button in its overlay.) So the sequence is: tap 1 opens the overlay, tap 2 selects (or goes straight to tap 3 when already selected), tap 3 zooms / opens channel selection, tap again un-zooms. (3) Try the full set of controls inside every screen first, whatever the layout. (4) Menu arrow, cast and mini player stay as a thin page-level strip while any screen's overlay is up. (5) Viewers: no special case needed.
Status: Built in 0.9.0.

### P-17 - Local mode: play streams directly from the provider, not through the server (idea)
Requested: 2026-10-30 (James: "a local mode ... to avoid routing the stream through my server to improve speed").
Type: minor-to-major   Status: Built in 0.9.0
Notes / questions: see the chat reply of 2026-10-30. Main findings: browsers cannot read most providers' streams directly (no CORS headers; an https page cannot load http streams; the provider password would be exposed to the device); rewind, recording, cast, shared screen and published streams all need the relay; the relay also enforces the provider's connection limit. Feasible parts: (a) native Android TV app player (ExoPlayer) playing the provider URL directly, which also fixes AC-3/E-AC-3 audio; (b) "try direct, fall back to the relay" in browsers for providers that do send CORS headers. First find out where the slowness is: channel start time, buffer cushion, the server's CPU/network, or remote viewing through the Cloudflare tunnel.
Scoped 2026-11-01 (James: "can we deploy this as an android app instead of a web app to allow for local mode?"): the Android app already exists (WebView around the page, built by CI as iptv-multiview.apk, runs on TV and phones). Local mode = add a native player (Media3/ExoPlayer) to that app that plays the provider's stream URL directly. Plan: phase 1, local mode for the selected / zoomed screen (and single-screen layout), page tells the app where to draw it; phase 2, several native players under a transparent web view for a whole multiview (limited by the device's hardware decoders). New server endpoint gives the direct URL only to users allowed to use local mode (admin by default, a per-user switch for viewers, default off). Per device setting "Local mode" with automatic fallback to the relay when the direct stream fails. Not available for direct screens: rewind, recording, cast, shared screen, published streams, relay connection sharing (each device uses its own provider connection, so the provider's max connections can be exceeded). Side benefit: AC-3/E-AC-3 audio and HEVC play where the device decodes them. Needs a new APK.
Decided 2026-11-01 (P-17): phase 1 only (one screen: the selected / zoomed screen), and local mode for admin only. Reason given: the slowness is when away from home, where the stream goes provider -> home server -> Starlink upload -> device; direct play skips the Starlink upload. Existing workaround meanwhile: Shared screen at 480p (one small combined stream) and SD for small tiles.
Status: Built in 0.9.0.

### P-18 - Cast from the Android app (phones and tablets)
Requested: 2026-11-01 (James: "why can't casting work in the app like other Android apps?").
Type: minor   Status: Built in 0.9.0
Notes / questions: the web page's cast uses Chrome's Cast SDK, which does not exist inside an Android WebView, so the app hides the cast icon. Plan: add the native Google Cast sender (Cast framework + a cast button in the app's top strip) using the default media receiver, and have the page ask the app to cast the link that POST /api/cast returns (/cast/<token>.mp4). Needs Google Play services, so phones and tablets; Android TV / Shield boxes are not cast senders. A native sender does not need an https page, so a LAN address works as long as the Chromecast can reach the server. Later idea: with local mode, send the provider URL to the Chromecast directly. Needs a new APK.
Decided 2026-11-01 (P-18): one APK for TV and phones (no separate builds). The app checks at run time whether casting is possible (Google Play services present and the device is not a TV box) and hides the cast button otherwise; separate TV / phone build flavours only if that ever causes trouble.

### P-19 - Login hardening (spec v1.9 gap)
Requested: 2026-11-05 (James: "gap analysis against the app development spec").
Type: patch   Status: Built in 0.8.0
Notes / questions: no rate limiting or lockout on POST /api/login; no Content-Security-Policy, X-Frame-Options / frame-ancestors headers on the page (only nosniff and no-referrer). Plan: per-IP and per-user failed-login delay/lockout, security headers that still allow the app's own scripts, blob: video, websockets and the cast/PiP features.

### P-20 - Clean shutdown proof (spec v1.9 gap)
Requested: 2026-11-05 (gap analysis).
Type: patch   Status: Built in 0.8.0
Notes / questions: a SIGTERM handler exists, but there is no init process (tini or compose `init: true`) and no test that the app exits cleanly and fast (under 10 s) with ffmpeg children running. Plan: add tini to the image, make shutdown stop ffmpeg children and the rewind/compose jobs, and add a test.

### P-21 - Healthcheck body check and tests (spec v1.9 gap)
Requested: 2026-11-05 (gap analysis).
Type: patch   Status: Built in 0.8.0
Notes / questions: the image healthcheck only needs an HTTP 200; make it also require `"status":"ok"`. Add tests: /healthz sets no cookie and needs no login, the healthcheck follows $PORT, the manifest and icon sizes are valid, and the release workflow trigger/version checks.

### P-22 - Light theme that follows the system setting (spec v1.9 gap)
Requested: 2026-11-05 (James: "include a light mode, default to system setting").
Type: minor (new setting)   Status: Built in 0.8.0
Notes / questions: add a light theme; the default follows the device's light/dark setting (prefers-color-scheme), with a Theme setting (System / Light / Dark) stored per device. Also covers the PWA theme-color, the Android app's bars, and the video/overlay controls staying readable on both.

### P-23 - Repo docs layout (spec v1.9 gap)
Requested: 2026-11-05 (gap analysis).
Type: docs   Status: Built in 0.8.0
Notes / questions: no docs/functional-spec.md; the pending log is PENDING_CHANGES.md in the repo root, not docs/pending-changes.md; deploy/ holds only RELEASE.md (compose files are in the repo root as docker-compose.yml and stack.yml, no deploy/compose.yaml or deploy/.env.example); CHANGELOG headings have no `v` prefix and no Short/Long lines. Question: which of these should move to the spec's layout, given the push-to-main flow already in use?
Decided 2026-11-05 (James: "go with your recommendations"): (1) write docs/functional-spec.md; (2) move the pending log to docs/pending-changes.md and update references; (3) add deploy/compose.yaml and deploy/.env.example (README paths updated; root docker-compose.yml / stack.yml kept as references or pointed at deploy/); (4) keep push-to-main releases (no switch back to tag pushes); (5) keep amd64 + arm64; (6) CHANGELOG: leave the format as is (no Short/Long lines) unless James asks later.
Status: Built in 0.8.0.

### P-24 - Fullscreen button in the player controls
Requested: 2026-11-08 (James: "The app seems to be missing the full screen button").
Type: minor (new button)
Notes / questions: fullscreen today is only in Settings > Fullscreen and the F key; the controls have no button for it (the old one is gone since the controls moved inside each screen). Proposal: a fullscreen / exit-fullscreen button in the page-level strip at the top right, next to cast and the mini player, so it is always at the page edge whichever screen the controls are on. It is hidden where the browser has no fullscreen (iPhone Safari) and in the Android app, which is already full screen. Decided 2026-11-08 (James: "Top right"): the page-level strip at the top right, next to cast and the mini player.
Status: Built in 0.10.0.

### P-25 - Fantasy ticker along the bottom (Fantasy Manager data)
Requested: 2026-11-08 (James: scrolling ticker of matchup scores and player scoring for every league, from Fantasy Manager).
Type: minor (new feature, new endpoints, new env FANTASY_URL / FANTASY_TOKEN)   Status: Built in 0.11.0 (needs FANTASY_URL and FANTASY_TOKEN on the server, Fantasy Manager 4.17.1 or later)
Decisions 2026-11-08: ticker is admins only; starters only for both teams.
Ticker design (James, 2026-11-08), repeated per league, in this order:
1. Header block scrolls in: league name, then my team name + my score (both coloured vs projection), then opponent score + opponent team name (white). Team names sit under the corresponding score (my name left, opponent name right).
2. As it scrolls, the league name stalls at the left edge and the ticker's left edge becomes the fall-off. Then "my score - opponent score" stalls just right of the league name and the right edge of the opponent score becomes the fall-off. Team names fall off; only league name and the two scores stay pinned. Player stats slide in behind the pinned block and disappear behind it, until the next league's name arrives and pushes the pinned block off the left, and the cycle repeats.
3. After the header comes the whole starting lineup of each team (mine, then the opponent's), in roster-slot order.
   - Not played yet: name plus game time.
   - Game in progress: name, total points, counting stats in brackets.
   - Game finished: score and final stats in light grey.
4. Score-up effect: when a player comes on screen and has scored since the last time his name was on screen for that side of the matchup (mine vs opponent, across all leagues), his total turns green (mine) or red (opponent) with a glow and rolls up to the new score, and the team total rolls up with it.
Fantasy Manager 4.17.0 gives: summary, SSE score events, headshots, health, colour rule (green #3FAE58, amber #D9A521, red #D6533B; league colour is green/amber/red by expected final vs opponent, 5% of remaining). Missing for this design: roster slot + order, kickoff time, counting-stat line. Address is the Fantasy Manager client port on the LAN; token created in its Account > Multiview access (given to Claude Code, never in the repo).
Ticker bar is opaque (decided 2026-11-08). Setting "Ticker position": Below the video (default; the video area shrinks so the ticker never covers a score bug) or Overlap the video (for streams that carry their own ticker; the opaque bar covers the bottom of the picture). Pop-ups stay without background; the look in docs/img mock-ups is approved.
4.17.1 notes: `stats` is a raw object (null until the game is live or final; QB passCmp/passAtt/passYds/passTd/int/rushAtt/rushYds/rushTd, RB/WR/TE rushAtt/rushYds/rushTd/rec/recYds/recTd, K fgm/xpm, DEF sacks/int), so Multiview formats the bracketed stat line itself; stats can lag the score by a minute or two. The league `colour` is used for the team name and score (no `mine.colour`). `players` come in a stable order (mine by slotOrder, then opponent). DEF playerId is the team abbreviation and its headshot is the team logo. Summary is polled every 15 s during games.
Built as specified. Assumed, not confirmed by James: league name is plain white (the team name and score carry the colour). Not yet run against the real Fantasy Manager (mock only).

### P-26 - Fantasy score pop-ups (headshot, one at a time)
Requested: 2026-11-08 (pop-up when players score: headshot top centre, green points left, red points right, league rows with my total green / opponent red, league name coloured vs projection, one at a time for 5 s, queue, rolling numbers, slide down/up, delay and minimum-points options).
Type: minor   Status: Built in 0.10.0 (needs FANTASY_URL and FANTASY_TOKEN on the server)
Decisions 2026-11-08: pop-ups are admins only; default minimum is 3 points so only big plays show (option stays adjustable, default delay 0); starters only; negative changes never pop up (the totals still update).
Notes: spec in docs/fantasy-ticker-scope.md section 5; provider stat lag means pop-ups cannot beat the real play, the Delay option only adds time.

### P-27 - Fantasy Manager connection per user, set in the app (replaces FANTASY_URL / FANTASY_TOKEN)
Requested: 2026-11-08 (James: each user, admin or not, enters their own Fantasy Manager address and read-only token in a Settings section "Fantasy Manager" with Test connection and Remove; token stored server-side per user, never in the browser or logs, never returned (only "token saved" + last 4), encrypted at rest if a secret exists; pop-ups and polling per user using that user's connection, no requests for users without one; remove the two env variables from compose and docs (ignore, or admin-only fallback); validate the address (http/https only, allow-list or non-LAN warning, SSRF); update CHANGELOG, RELEASE.md, PWA files if affected, tests, version).
Type: minor (new endpoints and settings, stored data, removes two env variables)   Status: Built in 0.12.0
Proposals (answer or say "go with your proposals"):
1. Encryption: the app has no server secret today (passwords are scrypt-hashed only). Proposal: on first use create a random 32-byte key file /data/fantasy.key (mode 0600) and store tokens AES-256-GCM encrypted in /data (users' fantasy file), so a copy of the data file alone does not reveal tokens. Limit: anyone who copies all of /data (key included) can decrypt; alternative or addition is an optional env SECRET_KEY that replaces the file key (then the key is not in /data). Back up fantasy.key with /data or users must re-enter tokens.
2. Old env variables: proposal is to ignore them (log one line at start saying they are no longer used). Reason: a single shared token means every user, viewers included, would see the admin's leagues; the fallback would only be for admins, which keeps old setups working but leaves two ways to configure the same thing. Say if you prefer "admin-only fallback default".
3. Existing users of the env variables: with "ignore", the pop-ups and ticker stop until each admin enters address and token in Settings (a one-time manual step; the compose lines can be deleted).
4. Address check: http or https only, no credentials in the URL, no query or fragment, port 1-65535; by default only private LAN addresses (10/8, 172.16/12, 192.168/16, 127/8, link-local, .local and single-label hostnames) are accepted; a public address needs an optional env FANTASY_ALLOW_HOSTS (comma list) or is refused with a clear message. Redirects from Fantasy Manager are not followed. Proposal: refuse (not just warn) so the server cannot be pointed at arbitrary hosts by non-admin users. Hostnames are resolved at connect time and the resolved address is checked again.
5. Limits: one connection per user, opened only while that user has a page open? (proposal: keep the server link per user only while at least one of their pages is connected, plus the last summary cached 60 s, so idle users cost nothing; say if you want it always on). Pop-up and ticker features for non-admins: yes, with their own data only.
Notes: all settings (size, delay, minimum, ticker position) stay per device as now; only the connection moves to the server.
Decisions 2026-11-08 (James): key file /data/fantasy.key, no SECRET_KEY variable; the env variables were never set on this server, so they are simply deleted (no fallback, no log line, no migration); address check refuses (not warns), only admins can set, test, remove or use a connection (403 for others), Tailscale 100.64.0.0/10 allowed, localhost and 127.x refused, no FANTASY_ALLOW_HOSTS; connection per user opened only while that user has a page open, last summary cached 60 s.
Built with one addition: 169.254.0.0/16 (link-local, includes the cloud metadata address) is also refused.

### P-28 - Diagnostics: find where buffering comes from
Requested: 2026-11-08 (James: the app buffers more than commercial apps even on the LAN; add diagnostics to pinpoint provider, internet, relay/server, LAN or browser).
Type: minor (new endpoint and diagnostics panel)   Status: Built in 0.13.0 (decisions 2026-11-08: admins only; channel and provider names only, no addresses)
Proposed scope (to confirm):
1. Per screen (page side, from the player and video element): buffer seconds over time, stall count and total stall time, longest stall, dropped frames, incoming bitrate (bytes received per second by the page), decoded resolution, player phase, last 10 minutes kept in memory.
2. Per channel (server side, relay.js): upstream bitrate (bytes per second from the provider), time to first byte, upstream reconnects and errors with the reason, viewers on it, bytes sent to each viewer and how often a viewer's socket backed up (slow reader), failover or SD or transcode in use.
3. Server health: CPU load and memory of the process, ffmpeg children running, event-loop lag, so a busy server shows up.
4. Settings > Diagnostics (admins): live table plus a "Run test" that measures provider-to-server speed for the selected channel for 30 s and server-to-browser speed over the same time, then states a verdict (provider slow / relay slow / browser or LAN slow / all fine) with the numbers; a button to copy or download the results as text to paste into chat.
5. No new settings on the server, no new env variables; nothing stored on disk beyond memory (kept 10 minutes).
Questions: admins only (proposal: yes, since it shows provider URLs' behaviour); include the provider address in results? (proposal: no, channel and provider names only).

### P-29 - Auto quality: start low, step up as the buffer grows, step down when it drains
Requested: 2026-11-12 (James: if the buffer is being consumed below a threshold, reduce quality until it is back above another threshold; instead of a long load buffer, start streams on low quality and gradually increase as the buffer grows).
Type: minor (new Quality option and playback logic)   Status: Built in 0.14.0
Proposed scope (to confirm):
1. New Quality choice "Auto (adaptive)" in the overlay Quality menu and as a Settings default. Ladder per channel, best first: As chosen (full) > SD variant (when the provider list has one, `lists.lowerVariant`) > 480p server transcode (GPU). Rungs a channel does not have are skipped.
2. Start low: begin on the lowest rung with a short cushion (about 2-3 s instead of the "Start playing after" value), so video appears fast.
3. Step up: when the buffer holds above the up-threshold (proposal 10 s) for 20 s with no stall in that time, switch one rung up. Switch down: when the buffer stays below 5 s for 10 s (changed 2026-11-12 from "below 2 s"), or a stall happens, switch one rung down. After a down-switch, do not go back up for 60 s (stops flip-flopping). Never go above "As chosen" and never above what the tile size needs (small tiles stay on SD as today).
4. Switch cleanly: the new stream is opened behind the playing one and the picture swaps when it has about 2 s buffered, so there is no black gap (needs a second provider connection for a few seconds; if the provider is full, the switch is skipped and logged). Without that, a switch costs a short rebuffer like Reload does today.
5. Overlay shows the current rung ("AUTO - SD"); the diagnostics panel (P-28) records each switch and the reason.
6. Decisions kept per device in the browser settings like the other playback settings; no new env variables; no server setting. Shared screen (server composite) and published one-stream views are unchanged.
Limits to know: these are separate streams, not one adaptive HLS ladder, so a switch restarts the stream (no seamless bitrate change inside one stream) and only helps when the provider has an SD/lower version or the server GPU transcodes. If the slowness is provider-to-server, a lower rung of the same provider may not help much; the P-28 diagnostics test says which it is.
Questions: (a) OK to use the 480p GPU transcode as the bottom rung (it costs server GPU per tile; proposal: yes, but only for the tile that needs it)? (b) Thresholds above (up 10 s held 20 s / down below 5 s held 10 s / 60 s lock-out) and short start cushion 2-3 s OK, or want them as settings? (c) Make Auto the new default for all tiles, or opt-in? (d) Allow the brief second connection for clean switches, or accept a short rebuffer instead?
Decided 2026-11-12: defaults accepted. (a) 480p GPU transcode is the bottom rung, only for the tile that needs it; (b) fixed thresholds, not settings; (c) Auto is opt-in at first; (d) clean switch with a brief second connection, skipped if the provider is full. Built 2026-11-12 (James: build, push).

### P-30 - Publish the Android TV app to the F-Droid repo (spec v1.11 section 15)
Requested: 2026-11-13 (James: make the existing Android TV app work with my F-Droid repo; no phone TWA)
Type: minor (release pipeline)   Status: Built in 0.15.0
Notes: asset multiview-iptv-<version>.apk (+ old iptv-multiview.apk kept for the README); versionCode MAJOR*100000000+MINOR*10000+PATCH; release key only (four ANDROID_* secrets, B64 name), skip when missing; androguard check; android_only run gets tag and overwrite inputs with the overwrite guard; tests; spec and RELEASE.md updated. The Shield needs one uninstall and reinstall (old APK was debug-signed).

### P-31 - Download buttons in the Change channel popup (movies, episodes, whole season)
Requested: 2026-11-14 (James: "In the change channel popup add a download button on each item, as well as a download button at the top for series that downloads the whole season currently being viewed.")
Type: minor (new feature)   Status: Pending
Proposed scope (to confirm): (1) Movies tab: a Download button on each movie; Series tab, open series: a Download button on each episode and one at the top of the episode list for the season currently shown. Live and Guide items have no download (a live stream has no file). (2) Uses the existing download route (`/vod/...?dl=1&name=`, same access rules as playing), so no new server API. File names like "Show S01E03 - Title.mkv". (3) Season download = a queue that runs up to N episodes at the same time (N = the new setting below, default 3), with "Downloading 3 of 10", a Cancel button and a note for episodes that fail (provider full, 404); a failed episode is skipped and listed at the end.
Questions: (a) Who may download: every user who can open the title, or admins only (the files leave the server and use provider bandwidth)? (b) Season download as a one-at-a-time queue of normal browser downloads (browsers may ask once to allow multiple downloads), or one ZIP streamed by the server (one file, but no resume and a very long single connection)? Recommendation: the queue. (c) In the Android TV app: hide the buttons (a TV web view cannot save files without more native code)? Recommendation: hide them there. (d) While a download runs it holds a provider connection like watching does; if the provider is full the download is refused (503) like a stream. OK?
Added 2026-11-14 (James: "Add a max concurrent downloads setting and default to 3"): Settings > "Max concurrent downloads", default 3 (proposed range 1 to 6), kept per device like the other settings. It limits how many downloads this browser runs at once, for a season queue and for single downloads started meanwhile (extra ones wait in the queue). Each running download holds one provider connection, so 3 downloads can use 3 of the provider's connections and block live viewing; a download that finds the provider full is refused (503) and retried once the others finish. This replaces question (b)'s one-at-a-time recommendation: the queue stays, but with N at a time.
Extra questions: (e) Per device only, or also a server-wide cap so several users cannot take every provider connection? (f) Should downloads stop short of the last free connection (keep 1 free for watching), or may they take all of them?
Decided 2026-11-14 (James): (1) everyone who can open a title may download by default; an admin can switch downloads off or on per user (Settings > Users, a new per-user toggle, stored with the user; admins always can). (2) the queue, no ZIP. (3) buttons hidden in the Android TV app; native TV downloads logged as P-32. (4) the concurrent-downloads limit is per device (default 3); an admin can also set a server-wide cap in Settings (default 0 = off, no cap) that counts running downloads of all users. (5) downloads always leave one provider connection free for watching: a download that would take the last free connection waits in the queue. Status stays Pending until James says build.

### P-32 - Future: downloads in the Android TV app
Requested: 2026-11-14 (James: hide the buttons in the TV app for now, "note as a future enhancement")
Type: minor (native Android work)   Status: Pending (future)
Notes: the TV app's web view cannot save files without native code (a DownloadListener and a storage location, or the Android DownloadManager). Decide where files go (Shield storage is small) and whether it is wanted at all. Not before P-31 is built and used.
