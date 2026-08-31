$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) { throw 'Node.js 20 or newer is required.' }
$major = [int]((& node -p 'process.versions.node.split(".")[0]').Trim())
if ($major -lt 20) { throw "Node.js 20 or newer is required; found $(& node --version)." }

& npm install
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'config'), (Join-Path $Root 'run'), (Join-Path $Root 'logs'), (Join-Path $Root 'cache') | Out-Null
$rulesPath = Join-Path $Root 'config\group-rules.json'
if (-not (Test-Path -LiteralPath $rulesPath)) {
    Copy-Item -LiteralPath (Join-Path $Root 'config\group-rules.example.json') -Destination $rulesPath
}

$envPath = Join-Path $Root '.env'
if (Test-Path -LiteralPath $envPath) {
    Write-Host '.env already exists; keeping it unchanged.'
} else {
    $eventUrl = Read-Host 'OneBot event WebSocket URL [ws://127.0.0.1:3001/]'
    if ([string]::IsNullOrWhiteSpace($eventUrl)) { $eventUrl = 'ws://127.0.0.1:3001/' }
    $apiUrl = Read-Host 'OneBot API WebSocket URL [ws://127.0.0.1:3001/api]'
    if ([string]::IsNullOrWhiteSpace($apiUrl)) { $apiUrl = 'ws://127.0.0.1:3001/api' }
    $rulesFile = Read-Host 'Group rules file [config/group-rules.json]'
    if ([string]::IsNullOrWhiteSpace($rulesFile)) { $rulesFile = 'config/group-rules.json' }
    $onebotToken = Read-Host 'SnowLuma/OneBot access token (optional)' -AsSecureString
    $chatBaseUrl = Read-Host 'Chat API base URL (optional)'
    $chatKey = Read-Host 'Chat API key (optional)' -AsSecureString
    $chatModel = Read-Host 'Chat model [replace_me]'
    if ([string]::IsNullOrWhiteSpace($chatModel)) { $chatModel = 'replace_me' }
    $imageKey = Read-Host 'Image API key (optional)' -AsSecureString
    $toPlain = { param($secure) [System.Net.NetworkCredential]::new('', $secure).Password }
    @"
GROUP_RULES_FILE=$rulesFile
NAPCAT_WS_URL=$eventUrl
NAPCAT_API_WS_URL=$apiUrl
SNOWLUMA_ACCESS_TOKEN=$(& $toPlain $onebotToken)
CHAT_API_BASE_URL=$chatBaseUrl
CHAT_API_KEY=$(& $toPlain $chatKey)
CHAT_MODEL=$chatModel
LUMIO_IMAGE_API_KEY=$(& $toPlain $imageKey)
LOG_LEVEL=info
"@ | Set-Content -LiteralPath $envPath -Encoding utf8NoBOM
    Write-Host 'Created local .env. Keep it private and untracked.'
}

Write-Host 'Setup complete. Run scripts/check-release.sh from WSL or scripts/windows-start.ps1 from PowerShell.'
