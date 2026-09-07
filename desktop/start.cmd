@echo off
pushd "%~dp0"
set "ELECTRON_OVERRIDE_DIST_PATH=%LOCALAPPDATA%\ovladac-electron"
if not exist "%ELECTRON_OVERRIDE_DIST_PATH%\electron.exe" (
  echo Chybi Electron runtime v %ELECTRON_OVERRIDE_DIST_PATH%
  pause
  exit /b 1
)
if exist "node_modules\electron\cli.js" (
  node "node_modules\electron\cli.js" .
) else (
  echo Nejdřív: npm install
  pause
)
popd
