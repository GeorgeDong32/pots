#!/bin/sh
# pots launchd wrapper (F06): launchd's PATH cannot resolve node, so
# source the user's PATH and exec with absolute paths. The daemon runs from
# TypeScript sources via Node's type TRANSFORM (no build step; the memory
# semantic core is imported in place from the sibling repo, DEVIATIONS D-9).
set -eu

USER_PATH="$(/usr/bin/su - "$USER" -c 'echo $PATH' 2>/dev/null || true)"
if [ -n "$USER_PATH" ]; then
  PATH="$USER_PATH"
  export PATH
fi

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "pots: node not found in PATH" >&2
  exit 1
fi

DAEMON_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec "$NODE_BIN" --experimental-transform-types --disable-warning=ExperimentalWarning \
  "$DAEMON_DIR/src/daemon.ts"
