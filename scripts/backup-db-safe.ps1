param(
    [string]$Reason = "manual"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$workspace = Split-Path -Parent $root
$output = Join-Path $workspace "output"
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$safeReason = $Reason -replace "[^A-Za-z0-9_-]", "_"
$filename = "geobim_${timestamp}_${safeReason}.dump"
$containerPath = "/tmp/$filename"
$hostPath = Join-Path $output $filename

& (Join-Path $PSScriptRoot "db-safety-check.ps1")
if ($LASTEXITCODE -ne 0) {
    throw "Backup cancelled because DB identity validation failed."
}

New-Item -ItemType Directory -Force -Path $output | Out-Null
docker exec geobim-stratum-postgres-1 pg_dump -U geobim -d geobim -Fc -f $containerPath
if ($LASTEXITCODE -ne 0) {
    throw "pg_dump failed."
}
docker cp "geobim-stratum-postgres-1:$containerPath" $hostPath
if ($LASTEXITCODE -ne 0) {
    throw "docker cp failed."
}

$file = Get-Item $hostPath
if ($file.Length -lt 1MB) {
    throw "Backup is unexpectedly small: $($file.Length) bytes"
}
Write-Host "Backup complete: $hostPath ($($file.Length) bytes)" -ForegroundColor Green

