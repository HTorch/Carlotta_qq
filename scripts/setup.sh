#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 20 or newer is required.' >&2
  exit 1
fi
node_major=$(node -p 'process.versions.node.split(".")[0]')
if (( node_major < 20 )); then
  printf 'Node.js 20 or newer is required; found %s.\n' "$(node --version)" >&2
  exit 1
fi

npm install
mkdir -p config run logs cache
if [[ ! -e config/group-rules.json ]]; then
  cp config/group-rules.example.json config/group-rules.json
fi

if [[ -e .env ]]; then
  printf '%s\n' '.env already exists; keeping it unchanged.'
else
  read -r -p 'OneBot event WebSocket URL [ws://127.0.0.1:3001/]: ' event_url
  event_url=${event_url:-ws://127.0.0.1:3001/}
  read -r -p 'OneBot API WebSocket URL [ws://127.0.0.1:3001/api]: ' api_url
  api_url=${api_url:-ws://127.0.0.1:3001/api}
  read -r -p 'Group rules file [config/group-rules.json]: ' rules_file
  rules_file=${rules_file:-config/group-rules.json}
  read -r -s -p 'SnowLuma/OneBot access token (optional): ' onebot_token
  printf '\n'
  read -r -p 'Chat API base URL (optional): ' chat_base_url
  read -r -s -p 'Chat API key (optional): ' chat_api_key
  printf '\n'
  read -r -p 'Chat model [replace_me]: ' chat_model
  chat_model=${chat_model:-replace_me}
  read -r -s -p 'Image API key (optional): ' image_api_key
  printf '\n'
  umask 077
  cat > .env <<EOF
GROUP_RULES_FILE=$rules_file
NAPCAT_WS_URL=$event_url
NAPCAT_API_WS_URL=$api_url
SNOWLUMA_ACCESS_TOKEN=$onebot_token
CHAT_API_BASE_URL=$chat_base_url
CHAT_API_KEY=$chat_api_key
CHAT_MODEL=$chat_model
LUMIO_IMAGE_API_KEY=$image_api_key
LOG_LEVEL=info
EOF
  printf '%s\n' 'Created local .env with restrictive permissions.'
fi

printf '%s\n' 'Setup complete. Run bash scripts/check-release.sh, then bash scripts/start-all.sh.'
