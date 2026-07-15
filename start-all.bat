@echo off
set ROOT=%~dp0

echo GeoBIM Stratum - starting backend + 5 sites...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\start-backend-safe.ps1"
if errorlevel 1 (
  echo DB safety validation failed. Site startup aborted.
  pause
  exit /b 1
)

start "GeoBIM auth :5170"        cmd /k "cd /d "%ROOT%sites\auth"        && npm run dev"
start "GeoBIM projects :5171"    cmd /k "cd /d "%ROOT%sites\projects"    && npm run dev"
start "GeoBIM map :5172"         cmd /k "cd /d "%ROOT%sites\map"         && npm run dev"
start "GeoBIM 3D viewer :5173"   cmd /k "cd /d "%ROOT%sites\viewer-3d"  && npm run dev"
start "GeoBIM upload :5174"      cmd /k "cd /d "%ROOT%sites\upload"      && npm run dev"
start "GeoBIM supplement :5175"  cmd /k "cd /d "%ROOT%sites\supplement"  && npm run dev"

echo Waiting 8 seconds for servers to start...
timeout /t 8 /nobreak > nul

start "" "http://localhost:6170"
start "" "http://localhost:6171"
start "" "http://localhost:6172"
start "" "http://localhost:6173"
start "" "http://localhost:6174"
start "" "http://localhost:6175"

echo Done.
pause
