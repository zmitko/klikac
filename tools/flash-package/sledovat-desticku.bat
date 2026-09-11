@echo off
setlocal
pushd "%~dp0" 2>nul
echo.
echo  COM do tohoto PC. Vypisuje log desticky (Wi-Fi / MQTT).
echo  Ukonci Ctrl+C.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\sledovat.ps1" %*
popd
pause
