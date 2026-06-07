#!/usr/bin/env bash
# Launch pi with only the pi-single-line-tool-calls extension
# (no outline editor — clean view of the single-line tool rendering).
set -euo pipefail
cd "$(dirname "$0")"
exec pi --no-extensions \
  -e extensions/pi-single-line-tool-calls/pi-single-line-tool-calls.ts \
  "$@"
