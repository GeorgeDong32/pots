#!/bin/sh
# pi-larkd launchd wrapper (F06): launchd's PATH cannot resolve node or the
# pnpm-managed deps, so source the user's PATH and exec with absolute paths.
set -eu

# Resolve the absolute node path from the user's login environment.
USER_PATH="$(/usr/bin/su - "$USER" -c 'echo $PATH' 2>/dev/null || true)"
if [ -n "$USER_PATH" ]; then
  PATH="$USER_PATH"
  export PATH
fi

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "pi-larkd: node not found in PATH" >&2
  exit 1
fi

DAEMON_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec "$NODE_BIN" \
  "$DAEMON_DIR/dist/daemon.js"
