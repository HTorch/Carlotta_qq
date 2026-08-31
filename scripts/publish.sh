#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
remote=${PUBLIC_REMOTE:?Set PUBLIC_REMOTE to an already reviewed public remote.}
staging=${STAGING_DIR:?Set STAGING_DIR to a separate clean git repository.}
root=$(realpath -e "$root")
staging=$(realpath -m "$staging")
home=$(realpath -e "${HOME:?HOME must be set.}")
if [[ "$staging" == / || "$staging" == "$home" || "$staging" == "$root" ]]; then
  printf 'Refusing unsafe STAGING_DIR: %s\n' "$staging" >&2
  exit 1
fi

bash "$root/scripts/check-release.sh"
rm -rf "$staging"
mkdir -p "$staging"
git -C "$staging" init --initial-branch=main
git -C "$staging" remote add origin "$remote"
git -C "$staging" config user.name Carlotta
git -C "$staging" config user.email "$(git config user.email)"
cp -R "$root/." "$staging/"
rm -rf "$staging/.git" "$staging/node_modules"
git -C "$staging" add --all
git -C "$staging" diff --cached --check
git -C "$staging" diff --cached --name-only
git -C "$staging" commit -m 'release: publish sanitized open-source package'
git -C "$staging" push --force-with-lease origin main
