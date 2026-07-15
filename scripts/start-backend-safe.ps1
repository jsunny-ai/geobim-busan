$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$compose = Join-Path $root "docker-compose.backend.yml"

docker-compose -p geobim-stratum -f $compose up -d --build backend
if ($LASTEXITCODE -ne 0) {
    throw "Docker backend startup failed."
}

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:9001/health/db" -TimeoutSec 3
        if ($health.status -eq "ok") {
            $ready = $true
            break
        }
    } catch {
        Start-Sleep -Seconds 1
    }
}
if (-not $ready) {
    throw "Backend did not pass DB identity validation. Do not fall back to port 8000."
}

& (Join-Path $PSScriptRoot "db-safety-check.ps1")
if ($LASTEXITCODE -ne 0) {
    throw "DB safety validation failed."
}
