#!/bin/sh
# Starts as root only long enough to make the data folder writable for the app's user, then drops privileges.
set -e
DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DIR"
  if ! find "$DIR" ! -user node -exec chown node:node {} + 2>/dev/null; then
    echo "warning: could not change ownership of $DIR (read-only or network mount?). Make it writable for user 1000." >&2
  fi
  exec su-exec node "$@"
fi
exec "$@"
