# Pending changes

Requests logged here are not built yet. Say "build" to fold them into a new version
(version number goes up, CHANGELOG.md is updated, this list is cleared), and "push" to upload to GitHub.
With every push, say whether the compose/stack file must change or whether pulling the new image is enough.

Current released version: 0.4.1

### P-1 - Rebuild the on-screen menu as a traditional video player overlay
Requested: 2026-10-18. Tap any screen (single view or multiview) to show a full-screen overlay over everything:
- top right: cast icon (only when casting is possible); top left: change-channel button (programme-guide icon, opens the channel picker)
- centre: play/pause with skip-back and skip-forward either side; right side: channel up / channel down; left side: arrow that opens the pull-out menu (P-2)
- bottom middle: progress bar; bottom left: mute button and volume bar
- arrow under the progress bar (up; turns down when open) that expands a row of options, left to right: 1 Layout (shows the current layout icon; all layout choices live here), 2 Expand (magnifying glass; replaces "zoom this tile"; tapping the same tile twice also expands), 3 Quality (filled TV icon with the current quality as text), 4 Reload (circular arrow), 5 Favourite (outline / filled star), 6 Record (red dot with REC: "to end of current event" with the stop time shown, or a chosen length; see P-5), 7 Download (down arrow with line: to server or to device; see P-6). Tapping an option opens its sub-options in a menu that grows upward from that icon; the arrow closes the row.
Type: minor-to-major (replaces the current top menu, tile menu and idle-hide behaviour)   Status: Pending
Decided 2026-10-18: controls act on the selected tile (a tap selects it first); skip back 10 s / forward 30 s; the 5 s idle auto-hide stays. Skip and progress bar rely on the live buffer (P-7). Decided 2026-10-18: every overlay control is reachable with the D-pad/remote on the Android TV app.

### P-2 - Left pull-out menu
Requested: 2026-10-18. Options: Watch (closes the menu and the overlays), Multiviews, Recordings & Downloads, Settings, Providers, Logout. Admin options move under Settings and are shown only to admins.
Type: minor   Status: Pending
Notes / questions: Recordings & Downloads is a new screen (list, play, delete, scheduled items) that depends on P-5 and P-6.

### P-3 - Cast to a Google device (Chromecast / Google TV)
Requested: 2026-10-18. Cast icon in the overlay (P-1).
Type: minor   Status: Pending
Notes / questions: Chrome's Cast needs the page on HTTPS (your Cloudflare hostname works, plain LAN http does not) and the Cast receiver must be able to reach the stream URL, so the server needs a cast-friendly H.264/AAC stream (the Shared-screen composite is the natural way to cast a multiview; a single channel can cast its own stream if it is H.264/AAC). Android TV app: needs the Cast SDK. Decided 2026-10-18: both are offered as options when casting (selected channel, or the whole multiview as one picture).

### P-4 - Local video capture source from the server's capture card
Requested: 2026-10-18. Route video from the capture card in the server box as a channel.
Type: minor   Status: Pending
Notes / questions: 0.3.0 already has Providers > Add capture card (V4L2 video + ALSA audio through ffmpeg, device passthrough in stack.yml). This entry: confirm it works with the card you buy, make it behave as a normal channel (favourites, recording, rewind), fix whatever is missing. The server is a Proxmox VM, so a USB card must be passed through to the VM and then into the container. Card recommendation given in chat.

### P-5 - Record live and future events
Requested: 2026-10-18. Record from the overlay (to end of current programme with stop time shown, or a set length) and schedule future programmes from the guide.
Type: minor   Status: Pending
Notes / questions: a recording holds a provider connection (shares the relay connection if the channel is already open); Decided 2026-10-18: files go to a folder set by a new environment variable in the deployment, separate from app data and the rewind buffer, so it can sit on a large slow disk (shared with P-6 downloads). Decided 2026-10-18: kept indefinitely, no size cap (deleted only by the user). Decided 2026-10-18: saved as .mp4; scheduled live-event recordings start 5 minutes early and end 60 minutes late (sports overtime), shown in the schedule screen and removable per recording. Decided 2026-10-18: if the provider is full at the start time the recording fails and shows an error (no interrupting what is being watched).

### P-6 - Download movies and series for offline viewing
Requested: 2026-10-18. Download to the server or to the device.
Type: minor   Status: Pending
Notes / questions: server download = background job into storage, listed in Recordings & Downloads and playable from the server; device download = browser download of the file (fine on phone/PC; the Android TV app has limited storage and no file picker). A download holds a provider connection while it runs. Decided 2026-10-18: server downloads use the same separate recordings/downloads folder as P-5. Decided 2026-10-18: kept indefinitely, no size cap.

### P-7 - Automatic 1-hour rewind buffer for live video
Requested: 2026-10-18. Live video is recorded automatically for up to 1 hour so the viewer can rewind.
Type: minor-to-major   Status: Pending
Notes / questions: buffer only channels being watched, on disk not RAM (about 2 GB per hour for a 4-5 Mbps channel, so a 6-tile multiview is about 12 GB, more at 1080p). Decided 2026-10-18: a new environment variable sets its folder, separate from app data and downloads, so it can sit on a fast disk; cleanup on close; the progress bar and skip buttons in P-1 depend on it; overlaps the existing "Start playing after / Keep up to" cushion setting.

### P-8 - Make the app an installable PWA
Requested: 2026-10-18. Installable on phone and desktop.
Type: minor   Status: Pending
Notes / questions: there is no manifest, service worker or icons yet. Plan: web manifest (standalone, icons 192/512/maskable, wide and narrow screenshots), a service worker that caches only the app shell and never streams, API calls or login pages (cache name tied to the app version), offline page, "update available" prompt, an Install button in Settings (iOS: Add to Home Screen instructions). Installing needs HTTPS, so it works through your Cloudflare hostname but not the plain LAN http address (Cloudflare Access, if used, must let the manifest, service worker and icons through). Also fits P-3 casting, which needs HTTPS too. The new overlay (P-1) must work in installed standalone mode at phone and desktop sizes.
