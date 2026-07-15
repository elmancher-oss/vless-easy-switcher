@echo off
setlocal
set DIR=%~dp0

if exist "%DIR%python-embed\python.exe" (
    "%DIR%python-embed\python.exe" "%DIR%host.py"
) else (
    python "%DIR%host.py"
)
