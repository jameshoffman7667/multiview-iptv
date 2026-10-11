# Pending changes

Requests logged here are not built yet. Say "build" to fold them into a new version
(version number goes up, CHANGELOG.md is updated, this list is cleared), and "push" to upload to GitHub.

Current released version: 0.2.0

1. Fix: container crash-loops with `EACCES: permission denied, mkdir '/data/cache'` when /data is a host folder (or volume) owned by root. Start the container as root, have an entrypoint fix ownership of /data and then drop to the `node` user; also print a clear message instead of a stack trace if the data folder is not writable.
