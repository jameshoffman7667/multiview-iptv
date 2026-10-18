#!/bin/sh
# Starts as root only long enough to make the data folder writable for the app's user, then drops privileges.
set -e
DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  # The data folder, the recordings/downloads folder and the rewind buffer folder (each may be a separate disk).
  for d in "$DIR" "${REC_DIR:-}" "${REWIND_DIR:-}"; do
    [ -n "$d" ] || continue
    mkdir -p "$d"
    if ! find "$d" ! -user node -exec chown node:node {} + 2>/dev/null; then
      echo "warning: could not change ownership of $d (read-only or network mount?). Make it writable for user 1000." >&2
    fi
  done
  # Capture cards and sound devices passed in with `devices:` belong to groups like "video" and "audio".
  # Give the unprivileged user those groups so ffmpeg can open them.
  for dev in /dev/video* /dev/snd/* /dev/dri/*; do
    [ -e "$dev" ] || continue
    gid="$(stat -c %g "$dev" 2>/dev/null || echo 0)"
    [ "$gid" = "0" ] && continue
    grp="$(getent group "$gid" | cut -d: -f1)"
    if [ -z "$grp" ]; then
      grp="hostdev$gid"
      addgroup -g "$gid" "$grp" 2>/dev/null || continue
    fi
    addgroup node "$grp" 2>/dev/null || true
  done
  exec su-exec node "$@"
fi
exec "$@"
