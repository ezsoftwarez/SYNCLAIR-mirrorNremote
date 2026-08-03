@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Build SYNCLIKA-Runner.exe
echo.
echo  Building a standalone runner.exe (no Python needed to run it)
echo  Requires: Python 3 on THIS machine (build-time only)
echo.
python -m pip install pyinstaller --quiet --disable-pip-version-check
if errorlevel 1 (
  echo pip install pyinstaller failed
  pause
  exit /b 1
)
python -m PyInstaller --onefile --name SYNCLIKA-Runner runner.py
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
echo.
echo  Done: dist\SYNCLIKA-Runner.exe
echo  Copy it next to desklink-server.js, package.json, and synclika-launcher.html
echo  Double-click it any time you want to run SYNCLIKA — no console commands.
echo.
pause
