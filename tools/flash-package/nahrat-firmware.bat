@echo off
setlocal
pushd "%~dp0" 2>nul
if errorlevel 1 (
  echo Nelze otevrit slozku balicku.
  pause
  exit /b 1
)
echo.
echo  ============================================
echo   ESP32 keyboard - nahrani firmware
echo  ============================================
echo  Zapoj programovaci USB (CH343 / UART).
echo  HID kabel v hernim PC muze zustat.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\flash.ps1" %*
set ERR=%ERRORLEVEL%
echo.
if not "%ERR%"=="0" (
  echo  Nahrani selhalo, kod %ERR%.
) else (
  echo  Nahrani probehlo.
)
echo.
popd
pause
exit /b %ERR%
