#!/usr/bin/env bash
# npm run deploy -- "<course root>" [label] [--course-id <id>]
#
# Ships the built app into <course root>/.player and writes the double-click launcher
# "🟢 Open <label> Course.command" (label defaults to "React") next to the section folders.
#   dist/bin/*  -> .player/bin/     (both single executables; npm run build:sea)
#   dist/web/   -> .player/web/     (npm run build)
#   --course-id -> .player/course.json `{ "id": "<id>" }` — ALWAYS written. The React label defaults to
#                  react-2023; any other label must name its id. The server reads it first
#                  (server/course-id.ts): the id must never again be guessed from the folder name — her
#                  copy's folder was not "React 2023", JS Journey 404'd "unknown course" and her sign-off
#                  was lost (2026-10-05). It sits outside data/ so "update Mansi's copy" carries it (README).
#   scripts/seed-config.json -> .player/data/config.json   ONLY if absent
# Never touches anything else in .player/data (progress, outboxes, durations cache) or
# .player/rename-log.json (undo log of the 2026-10-01 file clean-up).
#
# exFAT (Rahul's SSD): every new file costs a 1 MiB cluster + a `._` sidecar, and permissions do
# not exist — hence rsync -rt (no -p/-o/-g) and --exclude '._*' (macOS manages those sidecars; with
# --delete they would otherwise be deleted and recreated on every deploy).
# COURSE_PLAYER_DIST overrides the dist dir (dry runs against a temp copy; scripts/deploy.test.ts).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${COURSE_PLAYER_DIST:-$REPO/dist}"
USAGE='usage: npm run deploy -- "<course root>" [label] [--course-id <id>]'

COURSE_ID=""
positional=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --course-id) [[ $# -ge 2 ]] || { echo "deploy: --course-id needs a value" >&2; exit 2; }; COURSE_ID="$2"; shift 2 ;;
    --course-id=*) COURSE_ID="${1#--course-id=}"; shift ;;
    --*) echo "deploy: unknown option $1" >&2; echo "$USAGE" >&2; exit 2 ;;
    *) positional+=("$1"); shift ;;
  esac
done
ROOT="${positional[0]:-}"
LABEL="${positional[1]:-React}"

if [[ -z "$ROOT" ]]; then
  echo "$USAGE" >&2
  exit 2
fi
if [[ -z "$COURSE_ID" ]]; then
  if [[ "$LABEL" == "React" ]]; then
    COURSE_ID="react-2023"
  else
    echo "deploy: --course-id is required for the \"$LABEL\" course (the id JS Journey files her updates under, e.g. react-2023)" >&2
    exit 2
  fi
fi
# same rule as server/course-id.ts COURSE_ID_RE (the server refuses to start on anything else)
if ! [[ "$COURSE_ID" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || (( ${#COURSE_ID} > 64 )); then
  echo "deploy: course id \"$COURSE_ID\" is not valid — lowercase words joined by \"-\", e.g. react-2023" >&2
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

COURSE_JSON="$PLAYER/course.json"
previous=""
if [[ -f "$COURSE_JSON" ]]; then
  previous="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$COURSE_JSON" | head -n 1)"
fi
printf '{ "id": "%s" }\n' "$COURSE_ID" > "$COURSE_JSON"
if [[ -n "$previous" && "$previous" != "$COURSE_ID" ]]; then
  # Browser data (localStorage) is keyed by the course id: the app re-reads progress from .player/data,
  # but say it loudly — this changes which JS Journey course her updates go to.
  echo "deploy: WARNING course id changed: $previous -> $COURSE_ID ($COURSE_JSON)"
fi
echo "deploy: course id $COURSE_ID -> $COURSE_JSON"

if [[ -f "$PLAYER/data/config.json" ]]; then
  echo "deploy: kept existing $PLAYER/data/config.json"
else
  cp "$REPO/scripts/seed-config.json" "$PLAYER/data/config.json"
  echo "deploy: seeded $PLAYER/data/config.json"
fi

echo "deploy: done — double-click \"$(basename "$LAUNCHER")\" in $ROOT"
