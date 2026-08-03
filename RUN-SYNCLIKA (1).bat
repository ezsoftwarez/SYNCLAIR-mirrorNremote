@echo off
setlocal
cd /d "%~dp0"
title SYNCLIKA

if exist "%~dp0dist\SYNCLIKA-Runner.exe" (
  echo Starting SYNCLIKA-Runner.exe ...
  "%~dp0dist\SYNCLIKA-Runner.exe"
  echo.
  echo  [exe closed, exit code %errorlevel%]
  goto :end
)

set "PYCMD="
where python >nul 2>&1 && set "PYCMD=python"
if not defined PYCMD (
  where py >nul 2>&1 && set "PYCMD=py"
)

if not defined PYCMD (
  echo.
  echo  Python not found on PATH.
  echo  Install it from https://python.org  (tick "Add python.exe to PATH" during setup^)
  echo  ...or run BUILD-RUNNER.bat on a machine with Python to make dist\SYNCLIKA-Runner.exe
  echo   ^(then this file will use the .exe and won't need Python at all^)
  echo.
  goto :end
)

echo Using: %PYCMD%
%PYCMD% --version
if errorlevel 1 (
  echo.
  echo  "%PYCMD%" was found on PATH but won't actually run.
  echo  This usually means it's the Windows Store app-alias stub, not real Python.
  echo  Fix: Settings -^> Apps -^> Advanced app settings -^> App execution aliases
  echo       -^> turn OFF "python.exe" / "python3.exe", then install Python for real
  echo       from https://python.org and try again.
  echo.
  goto :end
)

echo.
%PYCMD% "%~dp0runner.py"
if errorlevel 1 (
  echo.
  echo  runner.py exited with an error ^(see the message above^).
  echo.
)

:end
echo.
pause
