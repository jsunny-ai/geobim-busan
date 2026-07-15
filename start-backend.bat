@echo off
set ROOT=%~dp0
echo GeoBIM Backend - FastAPI :9001 (Docker)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\start-backend-safe.ps1"
if errorlevel 1 (
  echo DB safety validation failed. Backend startup aborted.
  pause
  exit /b 1
)
echo Backend starting at http://localhost:9001
echo.
pause
