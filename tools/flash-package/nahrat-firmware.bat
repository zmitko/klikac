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
echo   Klikač - nahrani desticky na hernim PC
echo  ============================================
echo  1. Uprav klikac.cfg  (Wi-Fi + IP PC1 s Klikačem)
echo  2. Zapoj COM (CH343) do TOHOTO PC
echo  3. HID muze zustat v hernim PC
echo  4. Klikač musi bezet na PC1
echo.
if not exist "klikac.cfg" (
  echo  Chybi klikac.cfg
  if exist "klikac.cfg.example" copy /Y "klikac.cfg.example" "klikac.cfg" >nul
  echo  Otevri klikac.cfg, dopln PASS a MQTT, spust znovu.
  echo.
  notepad "klikac.cfg"
  popd
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\flash.ps1" %*
set ERR=%ERRORLEVEL%
echo.
if not "%ERR%"=="0" (
  echo  Nahrani selhalo, kod %ERR%.
) else (
  echo  Hotovo. COM muzes odpojit. HID nech v hernim PC.
)
echo.
popd
pause
exit /b %ERR%
