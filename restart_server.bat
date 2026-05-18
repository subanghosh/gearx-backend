@echo off
:: Switch to the directory of this batch file
cd /d "%~dp0"

echo ===================================================
echo   GearX Backend Server Restarter
echo ===================================================
echo.

echo 1. Finding process running on port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do (
    echo Found process ID %%a listening on port 3000.
    echo Killing process %%a...
    taskkill /F /PID %%a
)

echo.
echo 2. Launching GearX Backend Server...
echo.
node index.js

pause
