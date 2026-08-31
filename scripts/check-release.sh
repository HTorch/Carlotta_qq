#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

paths=$(rg --files -uu . --glob '!node_modules/**' --glob '!.git/**' | rg -i '(^|/)(\.env$|logs?(/|$)|cache(/|$)|deploy(/|$)|run(/|$)|persist(/|$)|node_modules(/|$)|\.omo(/|$)|\.claude(/|$)|windows-secrets(\.bat)?$|group-rules\.json$|group-prompts\.json$|cron-reminders\.json$|ignored-users\.json$|.*\.lock\.json$)' || true)
if [[ -n "$paths" ]]; then
  printf '%s\n' "$paths" >&2
  exit 1
fi

patterns=$(mktemp)
trap 'rm -f "$patterns"' EXIT
printf '%s' 'MTE4Nzc3MjU0MHw3MDgyOTQyNjB8MTE0MzU2NTU3MHwzMTA2MjQxMzM5fEM6XFxWTlJ8L2hvbWUvcHlyZXwvbW50L2MvVXNlcnMvTGVub3ZvfGFwaVwubHVtaW9cLmdhbWVzfHl1bnd1XC5haXxvcGVuY2xhdw==' | base64 -d > "$patterns"
if rg -n -i -f "$patterns" . --glob '!node_modules/**' --glob '!.git/**'; then
  exit 1
fi

while IFS= read -r file; do
  relative=${file#./}
  rg -F -q -- "$relative" MANIFEST.md
done < <(rg --files -uu . --glob '!node_modules/**' --glob '!.git/**' | sort)

while IFS= read -r file; do
  node --check "$file"
done < <(rg --files src -g '*.js' | sort)
node --test src/*.test.js
git diff --check
printf '%s\n' 'Release checks passed.'
