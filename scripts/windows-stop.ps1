$ErrorActionPreference = 'Stop'
Get-Process -Name 'node' -ErrorAction SilentlyContinue | Stop-Process
Write-Output 'Node.js processes stop requested.'
