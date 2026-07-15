param(
    [string]$ApiBase = "http://127.0.0.1:9001",
    [string]$Container = "geobim-stratum-postgres-1"
)

$ErrorActionPreference = "Stop"
$sentinelIds = @(9707, 9708, 9718)

function Fail([string]$Message) {
    Write-Host "[DB SAFETY] FAIL: $Message" -ForegroundColor Red
    exit 1
}

try {
    $inspect = (docker inspect $Container 2>$null | ConvertFrom-Json)[0]
} catch {
    Fail "Approved PostgreSQL container '$Container' was not found."
}

if (-not $inspect.State.Running) {
    Fail "Approved PostgreSQL container is not running."
}
if ($inspect.Config.Labels.'com.docker.compose.project' -ne "geobim-stratum") {
    Fail "Container does not belong to the approved geobim-stratum Compose project."
}

$idList = $sentinelIds -join ","
$sql = "SELECT count(*) FROM projects WHERE deleted_at IS NULL AND project_kind = 'user_workspace' AND id IN ($idList);"
$foundCount = docker exec $Container psql -U geobim -d geobim -At -c $sql
if ([int]$foundCount -ne $sentinelIds.Count) {
    Fail "Docker DB is missing sentinel projects: $idList. Do not seed, restore, or recreate volumes."
}

try {
    $health = Invoke-RestMethod "$ApiBase/health/db" -TimeoutSec 10
} catch {
    Fail "Backend DB health endpoint is unavailable at $ApiBase/health/db."
}

if ($health.status -ne "ok" -or $health.missing_sentinel_project_ids.Count -ne 0) {
    Fail "Backend is connected to an unapproved or stale database."
}
if ([int]$health.projects -lt 4525) {
    Fail "Project count regressed below the verified baseline (4525)."
}

Write-Host "[DB SAFETY] OK" -ForegroundColor Green
Write-Host "  API: $ApiBase"
Write-Host "  Projects: $($health.projects)"
Write-Host "  Boreholes: $($health.boreholes)"
Write-Host "  Latest project: $($health.latest_project.id) / $($health.latest_project.name)"
