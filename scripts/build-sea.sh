#!/usr/bin/env bash
# npm run build:sea -> dist/bin/course-player-arm64 + dist/bin/course-player-x64
#
# Official Node v22.19.0 binaries (vendor/, SHA-256 checked against nodejs.org SHASUMS256 when they
# were fetched) with the bundled server injected as a Node single-executable app (SEA), then ad-hoc
# signed. Traps:
# - The blob must be made by the SAME Node version as the target binaries, so it is generated with a
#   vendor binary, never with whatever `node` is on PATH.
# - No snapshot / code cache in the blob: both are arch-specific, and one blob serves both binaries.
# - The server must stay one CJS file with no import.meta.url / dynamic import (see server/main.ts).
set -euo pipefail

cd "$(dirname "$0")/.."

NODE_VERSION="v22.19.0"
SENTINEL="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
VERSION="$(node -p 'require("./package.json").version')+$(date -u +%Y%m%d%H%M)"

case "$(uname -m)" in
  arm64) HOST_NODE=(vendor/node-darwin-arm64) ;;
  *) HOST_NODE=(vendor/node-darwin-x64) ;;
esac

for arch in arm64 x64; do
  bin="vendor/node-darwin-$arch"
  [[ -x "$bin" ]] || { echo "build-sea: missing $bin (official Node $NODE_VERSION for darwin-$arch)" >&2; exit 1; }
done
got="$("${HOST_NODE[@]}" --version)"
[[ "$got" == "$NODE_VERSION" ]] || { echo "build-sea: ${HOST_NODE[0]} is $got, expected $NODE_VERSION" >&2; exit 1; }

echo "build-sea: bundling server ($VERSION)"
mkdir -p dist/bin
npx esbuild server/main.ts \
  --bundle --platform=node --format=cjs --target=node22 \
  --define:__COURSE_PLAYER_VERSION__="\"$VERSION\"" \
  --outfile=dist/server.cjs --log-level=warning

cat > dist/sea-config.json <<JSON
{
  "main": "dist/server.cjs",
  "output": "dist/sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false
}
JSON
"${HOST_NODE[@]}" --experimental-sea-config dist/sea-config.json

for arch in arm64 x64; do
  out="dist/bin/course-player-$arch"
  echo "build-sea: injecting into $out"
  rm -f "$out"
  cp "vendor/node-darwin-$arch" "$out"
  chmod 755 "$out"
  codesign --remove-signature "$out"
  npx postject "$out" NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse "$SENTINEL" --macho-segment-name NODE_SEA >/dev/null
  codesign --sign - --force "$out"
done

echo "build-sea: smoke-testing --version"
arm="$(dist/bin/course-player-arm64 --version)"
[[ "$arm" == "$VERSION" ]] || { echo "build-sea: arm64 printed '$arm', expected '$VERSION'" >&2; exit 1; }
x64="$(arch -x86_64 dist/bin/course-player-x64 --version)"
[[ "$x64" == "$VERSION" ]] || { echo "build-sea: x64 printed '$x64', expected '$VERSION'" >&2; exit 1; }
echo "build-sea: ok — arm64 $arm, x64 $x64"
ls -lh dist/bin
