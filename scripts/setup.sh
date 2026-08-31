#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
npm install
if [[ ! -e .env ]]; then
  cp .env.example .env
fi
printf '%s\n' 'Dependencies installed. Review .env before starting the bot.'
