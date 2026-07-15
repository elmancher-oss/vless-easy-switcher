@echo off
setlocal
set DIR=%~dp0

echo Starting automatic setup via PowerShell...
powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%install.ps1" %*
