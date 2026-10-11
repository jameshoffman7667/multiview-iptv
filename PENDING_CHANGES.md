# Pending changes

Requests logged here are not built yet. Say "build" to fold them into a new version
(version number goes up, CHANGELOG.md is updated, this list is cleared), and "push" to upload to GitHub.

Current released version: 0.2.0

1. Fix: container crash-loops with `EACCES: permission denied, mkdir '/data/cache'` when /data is a host folder (or volume) owned by root. Start the container as root, have an entrypoint fix ownership of /data and then drop to the `node` user; also print a clear message instead of a stack trace if the data folder is not writable.
2. Fix: every channel shows "Stream error (Exception)". Cause (reproduced): with web workers on (the default) the player fetches the relative stream URL inside a worker, where relative URLs can't be parsed ("Failed to parse URL from /stream/..."). Fix: build the stream URL as an absolute address in the page. Add a test that runs the real player with workers on.
3. Fix: with 6 or more streams playing, buttons stop working (Create admin does nothing, Multiviews loads forever) and tiles 7-9 never start. Cause (reproduced): browsers allow only 6 simultaneous plain-HTTP connections to one address, and every stream holds one open. Fix: carry the streams over WebSockets (no such limit; verified 9 at once alongside normal requests), with the same login/permission checks, keeping plain HTTP as an automatic fallback (for proxies that block WebSockets) and a Settings option. Add tests with 9 real-player streams plus API calls.
