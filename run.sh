#!/usr/bin/env bash
# Launch pi with ALL extensions in this repo loaded.
# --no-extensions disables discovery (so the .pi/extensions auto-load shim does
# not double-load pi-prompt-chain); every extension is then loaded explicitly.
set -euo pipefail
cd "$(dirname "$0")"
exec pi --no-extensions \
  -e extensions/pi-prompt-chain/pi-prompt-chain.ts \
  -e extensions/pi-single-line-tool-calls/pi-single-line-tool-calls.ts \
  "$@"
