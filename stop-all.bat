@echo off
chcp 65001 >nul
echo ========================================
echo   GeoBIM Stratum - 전체 서버 종료
echo ========================================
echo.

echo [1/5] 포트 5181 종료 중...
for /f "tokens=5" %%A in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":5181 "') do (
    taskkill /PID %%A /F >nul 2>&1 && echo       PID %%A 종료 완료
)

echo [2/5] 포트 5182 종료 중...
for /f "tokens=5" %%A in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":5182 "') do (
    taskkill /PID %%A /F >nul 2>&1 && echo       PID %%A 종료 완료
)

echo [3/5] 포트 5183 종료 중...
for /f "tokens=5" %%A in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":5183 "') do (
    taskkill /PID %%A /F >nul 2>&1 && echo       PID %%A 종료 완료
)

echo [4/5] 포트 5184 종료 중...
for /f "tokens=5" %%A in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":5184 "') do (
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
