#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

paths=$(rg --files -uu . --glob '!node_modules/**' --glob '!.git/**' | rg -i '(^|/)(\.env$|logs?(/|$)|cache(/|$)|deploy(/|$)|run(/|$)|persist(/|$)|node_modules(/|$)|\.omo(/|$)|\.claude(/|$)|.*secrets?[^/]*$|.*handoff[^/]*$|group-rules\.json$|group-prompts\.json$|cron-reminders\.json$|ignored-users\.json$|.*\.lock\.json$)' || true)
if [[ -n "$paths" ]]; then
  printf '%s\n' "$paths" >&2
  exit 1
fi

if rg -n -i '(gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,}|bearer[[:space:]]+[A-Za-z0-9._-]{16,}|-----BEGIN (RSA|OPENSSH|EC|PGP) PRIVATE KEY-----|/mnt/[A-Za-z]/|[A-Za-z]:\\|\breplace_me\b.{0,80}\b(secret|token|key)\b)' . --glob '!node_modules/**' --glob '!.git/**' --glob '!.env.example' --glob '!scripts/check-release.sh'; then
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
