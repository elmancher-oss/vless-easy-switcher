@echo off
setlocal
set DIR=%~dp0

echo ============================================
echo   VLESS Switch - one-click setup
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%native-host\windows\install.ps1" %*
