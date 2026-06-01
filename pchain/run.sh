#!/usr/bin/env bash
cd "$(dirname "$0")"
# Usage: run.sh <screen-name>  (e.g. run.sh hello)
npx tsx source/cli.tsx "$@"
