# Pending changes

Requests logged here are not built yet. Say "build" to fold them into a new version
(version number goes up, CHANGELOG.md is updated, this list is cleared), and "push" to upload to GitHub.
With every push, say whether the compose/stack file must change or whether pulling the new image is enough.
Every build rewrites deploy/RELEASE.md with a fixed `Update:` line: `Update: now` only when the user said "build, push and update" for that release, otherwise `Update: later`.

Current released version: 0.7.0 (being pushed)

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
