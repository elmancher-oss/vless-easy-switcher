@echo off
setlocal

echo ============================================
echo   VLESS Switch - uninstall
echo ============================================
echo.

echo [1/3] Stopping xray.exe (if running)...
taskkill /IM xray.exe /F >nul 2>&1
if %errorlevel%==0 (
    echo   xray.exe stopped.
) else (
    echo   xray.exe was not running - skipping.
)

echo.
echo [2/3] Removing native messaging host registration from registry...
reg delete "HKCU\Software\Mozilla\NativeMessagingHosts\vless_switch_host" /f >nul 2>&1
if %errorlevel%==0 (
    echo   Registry key removed.
) else (
    echo   Registry key not found - skipping.
)

echo.
echo [3/3] Done.
echo.
echo Remaining manual steps:
echo   1. Open about:addons in Firefox
echo   2. Find "VLESS Switch" -^> "..." -^> Remove
echo   3. Optionally delete this package folder
echo      (native-host, xray.exe, config.json, etc.)
echo.
pause
