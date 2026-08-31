#!/usr/bin/env bash
set -euo pipefail

if pgrep -f 'node src/index.js' >/dev/null; then
  printf '%s\n' 'Bot process is running.'
else
  printf '%s\n' 'Bot process is not running.'
fi
