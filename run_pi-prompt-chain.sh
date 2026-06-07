#!/usr/bin/env bash
# Launch pi with only the pi-prompt-chain outline editor.
set -euo pipefail
cd "$(dirname "$0")"
exec pi --no-extensions \
  -e extensions/pi-prompt-chain/pi-prompt-chain.ts \
  "$@"
