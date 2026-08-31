$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
if (-not (Test-Path '.env')) {
    throw 'Missing .env. Copy .env.example and fill local values.'
}
Start-Process -FilePath 'node' -ArgumentList 'src/index.js' -WorkingDirectory $Root
