@echo off
cd /d "%~dp0"
title SYNCLIKA

if exist "%~dp0dist\SYNCLIKA-Runner.exe" (
  start "" "%~dp0dist\SYNCLIKA-Runner.exe"
  exit /b 0
)

where python >nul 2>&1 && (python "%~dp0runner.py" & exit /b 0)
where py >nul 2>&1 && (py "%~dp0runner.py" & exit /b 0)

echo.
echo  Python not found — install it from https://python.org
echo  or run BUILD-RUNNER.bat on a machine that has Python to make SYNCLIKA-Runner.exe
echo.
pause
