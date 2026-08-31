$ErrorActionPreference = 'Stop'
$processes = Get-Process -Name 'node' -ErrorAction SilentlyContinue
if ($null -eq $processes) {
    Write-Output 'No Node.js process is running.'
    exit 0
}
$processes | Select-Object Id, ProcessName, Path
