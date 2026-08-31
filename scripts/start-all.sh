#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
if [[ ! -e .env ]]; then
  printf '%s\n' 'Missing .env. Copy .env.example and fill local values.' >&2
  exit 1
fi
exec node src/index.js
