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
Notes / questions: (a) which tile do the controls act on in a multiview - the selected one, and does tapping a tile select it first? (b) skip back/forward and the progress bar need the live buffer (P-7); skip amounts (10 s back / 30 s forward?) (c) keep the 5 s idle auto-hide for the overlay? (d) mouse/remote on the Android TV app still needs focus navigation.

### P-2 - Left pull-out menu
Requested: 2026-10-18. Options: Watch (closes the menu and the overlays), Multiviews, Recordings & Downloads, Settings, Providers, Logout. Admin options move under Settings and are shown only to admins.
Type: minor   Status: Pending
Notes / questions: Recordings & Downloads is a new screen (list, play, delete, scheduled items) that depends on P-5 and P-6.

### P-3 - Cast to a Google device (Chromecast / Google TV)
Requested: 2026-10-18. Cast icon in the overlay (P-1).
Type: minor   Status: Pending
Notes / questions: Chrome's Cast needs the page on HTTPS (your Cloudflare hostname works, plain LAN http does not) and the Cast receiver must be able to reach the stream URL, so the server needs a cast-friendly H.264/AAC stream (the Shared-screen composite is the natural way to cast a multiview; a single channel can cast its own stream if it is H.264/AAC). Android TV app: needs the Cast SDK. Which should cast: the selected channel, or the whole multiview as one picture?

### P-4 - Local video capture source from the server's capture card
Requested: 2026-10-18. Route video from the capture card in the server box as a channel.
Type: minor   Status: Pending
Notes / questions: 0.3.0 already has Providers > Add capture card (V4L2 video + ALSA audio through ffmpeg, device passthrough in stack.yml). This entry: confirm it works with the card you buy, make it behave as a normal channel (favourites, recording, rewind), fix whatever is missing. The server is a Proxmox VM, so a USB card must be passed through to the VM and then into the container. Card recommendation given in chat.

### P-5 - Record live and future events
Requested: 2026-10-18. Record from the overlay (to end of current programme with stop time shown, or a set length) and schedule future programmes from the guide.
Type: minor   Status: Pending
Notes / questions: a recording holds a provider connection (shares the relay connection if the channel is already open); where files go (/files? size limit, retention), format (.ts as received or remux to .mp4/.mkv), padding before/after, what happens if the provider is full at the start time.

### P-6 - Download movies and series for offline viewing
Requested: 2026-10-18. Download to the server or to the device.
Type: minor   Status: Pending
Notes / questions: server download = background job into storage, listed in Recordings & Downloads and playable from the server; device download = browser download of the file (fine on phone/PC; the Android TV app has limited storage and no file picker). A download holds a provider connection while it runs. Same storage questions as P-5.

### P-7 - Automatic 1-hour rewind buffer for live video
Requested: 2026-10-18. Live video is recorded automatically for up to 1 hour so the viewer can rewind.
Type: minor-to-major   Status: Pending
Notes / questions: buffer only channels being watched, on disk not RAM (about 2 GB per hour for a 4-5 Mbps channel, so a 6-tile multiview is about 12 GB, more at 1080p); needs a /data or /files location and cleanup on close; the progress bar and skip buttons in P-1 depend on it; overlaps the existing "Start playing after / Keep up to" cushion setting.
