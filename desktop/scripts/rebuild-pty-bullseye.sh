#!/bin/bash
# Rebuild the staged Linux natives on Debian bullseye (glibc 2.31).
# prepare:deps has already copied the trees into desktop/build-resources.
# The live checkout is not touched. Docker is required.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
stage="$root/desktop/build-resources/orchestrator"
app_sqlite="$root/desktop/build-resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [[ ! -d "$stage/node_modules/node-pty" ]]; then
  echo "node-pty is not staged. Run npm run prepare:deps first." >&2
  exit 1
fi
docker run --rm \
  -v "$stage:/stage" \
  -w /stage \
  node:22-bullseye \
  bash -lc 'set -euo pipefail
    apt-get update
    apt-get install -y --no-install-recommends python3 make g++
    rm -rf node_modules/node-pty/build node_modules/better-sqlite3/build
    npm rebuild better-sqlite3 node-pty --foreground-scripts
  '
if [[ -f "$app_sqlite" ]]; then
  cp -f "$stage/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "$app_sqlite"
fi
node "$root/desktop/scripts/assert-native-glibc.mjs" "$root/desktop/build-resources"
