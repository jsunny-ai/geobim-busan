@echo off
chcp 65001 > nul
set ROOT=%~dp0

echo.
echo [1/2] Removing node_modules...

for %%S in (auth projects map upload viewer-3d) do (
  if exist "%ROOT%sites\%%S\node_modules" (
    rmdir /s /q "%ROOT%sites\%%S\node_modules"
    echo   Removed: sites\%%S\node_modules
  )
)

echo.
echo [2/2] Running npm install (2-5 min)...
echo.

for %%S in (auth projects map upload viewer-3d) do (
  echo --- %%S ---
  cd /d "%ROOT%sites\%%S"
  npm install
  if errorlevel 1 (
    echo ERROR: %%S install failed.
    pause
    exit /b 1
  )
  echo Done: %%S
  echo.
)

echo ==============================
echo All sites reinstalled OK!
echo Now run start-all.bat
echo ==============================
pause
