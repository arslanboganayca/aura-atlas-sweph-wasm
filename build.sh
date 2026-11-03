#!/usr/bin/env bash
# Builds Swiss Ephemeris 2.10.03 (official C sources, unchanged) + glue.c into one ES module with the .se1 files embedded.
# Needs Emscripten on PATH (source emsdk_env.sh first). Output: dist/sweph.mjs + dist/sweph.wasm (+ data inside).
# SWEPH_ENVIRONMENT selects the Emscripten target environments. The published dist/ was built with the default
# (web,worker,node); `SWEPH_ENVIRONMENT=web,worker ./build.sh` drops the Node branch of the glue, so handler.js would no
# longer need to hide `process` — a different dist/ that must pass the native parity test before it is deployed.
set -euo pipefail
SWEPH_ENVIRONMENT="${SWEPH_ENVIRONMENT:-web,worker,node}"
cd "$(dirname "$0")"
mkdir -p dist
SOURCES="src/swecl.c src/swedate.c src/swehel.c src/swehouse.c src/swejpl.c src/swemmoon.c src/swemplan.c src/sweph.c src/swephlib.c"
emcc -O2 glue.c $SOURCES -Isrc \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createSweph \
  -s ENVIRONMENT="$SWEPH_ENVIRONMENT" -s ALLOW_MEMORY_GROWTH=1 -s FILESYSTEM=1 \
  -s EXPORTED_FUNCTIONS='["_aa_calc_ut","_aa_solcross_ut","_aa_version","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF64","UTF8ToString"]' \
  --embed-file ephe@/ephe \
  -o dist/sweph.mjs
ls -la dist
