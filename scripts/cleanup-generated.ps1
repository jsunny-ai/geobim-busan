$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$targets = @(
    ".vite-cache",
    ".vite-cache2",
    "backend/.venv",
    "backend/.venv-codex",
    "backend/.vite",
    "backend/backend.err.log",
    "backend/backend.out.log",
    "backend/backend_startup.log",
    "backend/all_extraction_out.txt",
    "backend/dryrun_out.txt",
    "sites/auth/dist",
    "sites/auth/node_modules",
    "sites/map/dist",
    "sites/map/node_modules",
    "sites/projects/dist",
    "sites/projects/node_modules",
    "sites/supplement/dist",
    "sites/supplement/node_modules",
    "sites/upload/dist",
    "sites/upload/node_modules",
    "sites/viewer-3d/dist",
    "sites/viewer-3d/node_modules",
    "test_project",
    "tmp"
)

foreach ($relativePath in $targets) {
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $root $relativePath))
    if (-not $candidate.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar)) {
        throw "Refusing to remove a path outside the repository: $candidate"
    }
    if (Test-Path -LiteralPath $candidate) {
        try {
            Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction Stop
            Write-Host "Removed $relativePath"
        } catch {
            Write-Warning "Could not fully remove $relativePath. Close processes using it and run this script again. $($_.Exception.Message)"
        }
    }
}
