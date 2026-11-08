#!/bin/sh
# P3-4.3: pi-durable pin upgrade runbook (scripted, idempotent, re-runnable).
#
# The upgrade surface is enumerable by construction: src/substrate.ts and
# src/durable-ext/** are the only pi-durable importers (ESLint gate). The
# requestId→submission idempotency table lives INSIDE the same SQLite file
# (no data migration on a pin bump); the snapshot step below exists for
# rollback, and the schema-exact-match rule is enforced by refusing to open
# an incompatible database (pi-durable errors out) — we never migrate
# implicitly.
#
# Usage: scripts/upgrade.sh <new-version> [--dry-run]
set -eu

LABEL="dev.gd32.pi-larkd"
REPO_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
VERSION="${1:?usage: upgrade.sh <new-version> [--dry-run]}"
DRY_RUN="${2:-}"

echo "== pi-durable upgrade: -> ${VERSION}${DRY_RUN:+ (dry run)} =="

step() { echo "-- $1"; }

step "1/7 bootout the daemon"
[ "$DRY_RUN" = "--dry-run" ] || launchctl bootout "gui/$(id -u)" "$LABEL" 2>/dev/null || true

step "2/7 snapshot the database (rollback anchor)"
if [ "$DRY_RUN" != "--dry-run" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$HOME/.pi-larkd/backups"
  cp "$HOME/.pi-larkd/harness.sqlite" "$HOME/.pi-larkd/backups/harness-$STAMP.sqlite" 2>/dev/null || true
  [ -f "$HOME/.pi-larkd/harness.sqlite-wal" ] && cp "$HOME/.pi-larkd/harness.sqlite-wal" "$HOME/.pi-larkd/backups/harness-$STAMP.sqlite-wal" || true
  echo "   snapshot: ~/.pi-larkd/backups/harness-$STAMP.sqlite"
else
  echo "   (would snapshot ~/.pi-larkd/harness.sqlite)"
fi

step "3/7 bump the exact pin"
[ "$DRY_RUN" = "--dry-run" ] || sed -i '' "s/\"@earendil-works\/pi-durable\": \"[^\"]*\"/\"@earendil-works\/pi-durable\": \"$VERSION\"/" "$REPO_DIR/package.json"

step "4/7 install"
[ "$DRY_RUN" = "--dry-run" ] || (cd "$REPO_DIR" && pnpm install)

step "5/7 compile + tests + lint (upgrade blast radius: substrate.ts / durable-ext)"
(cd "$REPO_DIR" && pnpm check)

step "6/7 bootstrap the daemon"
[ "$DRY_RUN" = "--dry-run" ] || launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LABEL.plist"

step "7/7 A/B regression checklist (manual gates — see VERIFICATION-LEDGER)"
echo "   A2 crash-resume · A5 backfill · B4 approval card · B7 static gate"

echo "== done =="
