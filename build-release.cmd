@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0" || exit /b 1

if not exist "node_modules\.bin\vite.cmd" (
    call npm.cmd ci --include=dev
    if errorlevel 1 goto finish
)
call npm.cmd run build

:finish
set "result=%errorlevel%"
popd
exit /b %result%
