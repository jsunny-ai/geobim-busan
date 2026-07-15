@echo off
set ROOT=%~dp0
echo GeoBIM - Reinstalling sites\map (three.js included)
echo.

echo Removing node_modules...
if exist "%ROOT%sites\map\node_modules" (
  rmdir /s /q "%ROOT%sites\map\node_modules"
  echo node_modules removed.
) else (
  echo node_modules not found, skipping.
)

echo.
echo Running npm install...
cd /d "%ROOT%sites\map"
npm install

echo.
echo Done. You can now run start-all.bat
pause
