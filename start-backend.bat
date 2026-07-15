@echo off
set ROOT=%~dp0
echo GeoBIM Backend - FastAPI :8002 (Docker)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\start-backend-safe.ps1"
if errorlevel 1 (
  echo DB safety validation failed. Backend startup aborted.
  pause
  exit /b 1
)
echo Backend starting at http://localhost:8002
echo.
pause
