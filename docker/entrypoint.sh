#!/bin/sh
# Runs Kago as PUID:PGID with UMASK, so files it writes match the host's ownership (linuxserver.io convention).
set -e

umask "${UMASK:-022}"

# Started with `--user`: the identity is already chosen and cannot be changed from here.
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
case "$PUID$PGID" in
  *[!0-9]*) echo "PUID and PGID must be numeric (got PUID=$PUID PGID=$PGID)" >&2; exit 1 ;;
esac

# App state has to be writable by the chosen user. /data is the user's own files and is left untouched.
mkdir -p "$APP_DATA_DIR"
find "$APP_DATA_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} +

export HOME=/app
exec setpriv --reuid "$PUID" --regid "$PGID" --clear-groups "$@"
