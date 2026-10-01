#!/usr/bin/env bash
# npm run deploy -- "<course root>" [label]
#
# Ships the built app into <course root>/.player and writes the double-click launcher
# "🟢 Open <label> Course.command" (label defaults to "React") next to the section folders.
#   dist/bin/*  -> .player/bin/     (both single executables; npm run build:sea)
#   dist/web/   -> .player/web/     (npm run build)
#   scripts/seed-config.json -> .player/data/config.json   ONLY if absent
# Never touches anything else in .player/data (progress, outboxes, durations cache) or
# .player/rename-log.json (undo log of the 2026-10-01 file clean-up).
#
# exFAT (Rahul's SSD): every new file costs a 1 MiB cluster + a `._` sidecar, and permissions do
# not exist — hence rsync -rt (no -p/-o/-g) and --exclude '._*' (macOS manages those sidecars; with
# --delete they would otherwise be deleted and recreated on every deploy).
# COURSE_PLAYER_DIST overrides the dist dir (dry runs against a temp copy).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${COURSE_PLAYER_DIST:-$REPO/dist}"
ROOT="${1:-}"
LABEL="${2:-React}"

if [[ -z "$ROOT" ]]; then
  echo 'usage: npm run deploy -- "<course root>" [label]' >&2
  exit 2
fi
[[ -d "$ROOT" ]] || { echo "deploy: course folder not found: $ROOT" >&2; exit 1; }
for f in "$DIST/bin/course-player-arm64" "$DIST/bin/course-player-x64"; do
  [[ -f "$f" ]] || { echo "deploy: missing $f — run npm run build:sea first" >&2; exit 1; }
done
[[ -f "$DIST/web/index.html" ]] || { echo "deploy: missing $DIST/web/index.html — run npm run build first" >&2; exit 1; }

PLAYER="$ROOT/.player"
LAUNCHER="$ROOT/🟢 Open $LABEL Course.command"
mkdir -p "$PLAYER/bin" "$PLAYER/web" "$PLAYER/data"

echo "deploy: binaries -> $PLAYER/bin"
rsync -rt --delete --exclude '._*' "$DIST/bin/" "$PLAYER/bin/"
chmod +x "$PLAYER/bin/course-player-arm64" "$PLAYER/bin/course-player-x64"

echo "deploy: web app -> $PLAYER/web"
rsync -rt --delete --exclude '._*' "$DIST/web/" "$PLAYER/web/"

echo "deploy: launcher -> $LAUNCHER"
# Escape sed replacement metacharacters in the label (& / \).
label_sed="$(printf '%s' "$LABEL" | sed -e 's/[&/\]/\\&/g')"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
sed -e "s/__LABEL__/$label_sed/g" "$REPO/launcher/open-course.command" > "$tmp"
cp "$tmp" "$LAUNCHER"
chmod 755 "$LAUNCHER"

if [[ -f "$PLAYER/data/config.json" ]]; then
  echo "deploy: kept existing $PLAYER/data/config.json"
else
  cp "$REPO/scripts/seed-config.json" "$PLAYER/data/config.json"
  echo "deploy: seeded $PLAYER/data/config.json"
fi

echo "deploy: done — double-click \"$(basename "$LAUNCHER")\" in $ROOT"
