@echo off
chcp 65001 >nul
echo ========================================
echo   GeoBIM Stratum - 전체 서버 종료
echo ========================================
echo.

echo [1/5] 포트 5171 종료 중...
for /f "tokens=5" %%A in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":5171 "') do (
    taskkill /PID %%A /F >nul 2>&1 && echo       PID %%A 종료 완료
)

echo [2/5] 포트 5172 종료 중...
for /f "tokens=5" %%A in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":5172 "') do (
    taskkill /PID %%A /F >nul 2>&1 && echo       PID %%A 종료 완료
)

echo [3/5] 포트 5173 종료 중...
for /f "tokens=5" %%A in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":5173 "') do (
    taskkill /PID %%A /F >nul 2>&1 && echo       PID %%A 종료 완료
)

echo [4/5] 포트 5174 종료 중...
for /f "tokens=5" %%A in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":5174 "') do (
    taskkill /PID %%A /F >nul 2>&1 && echo       PID %%A 종료 완료
)

echo [5/5] 포트 8000 종료 중...
for /f "tokens=5" %%A in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":8000 "') do (
    taskkill /PID %%A /F >nul 2>&1 && echo       PID %%A 종료 완료
)

echo.
echo 완료! 이제 start-all.bat 를 실행하세요.
echo.
pause
