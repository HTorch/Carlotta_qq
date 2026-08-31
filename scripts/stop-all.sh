#!/usr/bin/env bash
set -euo pipefail

pkill -f 'node src/index.js' || true
printf '%s\n' 'Bot stop requested.'
