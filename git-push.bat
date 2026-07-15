@echo off
set ROOT=%~dp0
cd /d "%ROOT%"

echo GeoBIM - Git setup and push to GitHub
echo.

git rev-parse --git-dir >nul 2>&1
if errorlevel 1 (
  echo Initializing git repository...
  git init
  git branch -M main
)

echo Adding remote origin...
git remote remove origin >nul 2>&1
git remote add origin https://github.com/jsunny-ai/GeoBIM.git

echo.
echo Staging all files...
git add .

echo.
echo Commit message:
set /p MSG="Enter commit message (or press Enter for default): "
if "%MSG%"=="" set MSG=Update GeoBIM Stratum

git commit -m "%MSG%"

echo.
echo Pushing to GitHub...
git pull origin main --allow-unrelated-histories
git push -u origin main

echo.
echo Done! Check https://github.com/jsunny-ai/GeoBIM
pause
