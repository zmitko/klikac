@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\make-flash-package.ps1" %*
if errorlevel 1 (
  echo.
  echo Sestaveni balicku selhalo.
)
echo.
pause
