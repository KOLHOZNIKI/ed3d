@echo off
setlocal EnableExtensions DisableDelayedExpansion
if not "%~2"=="" goto usage
set "configuration=release"
set "output=dist"
set "port=4173"
if "%~1"=="" goto launch
if /i "%~1"=="release" goto launch
if /i not "%~1"=="debug" goto usage
set "configuration=debug"
set "output=dist-debug"
set "port=4174"

:launch
pushd "%~dp0" || exit /b 1
if not exist "%output%\index.html" (
    call "build-%configuration%.cmd"
    if errorlevel 1 goto finish
)
if not exist "node_modules\.bin\vite.cmd" (
    call npm.cmd ci --include=dev
    if errorlevel 1 goto finish
)
call npm.cmd run preview -- --host 127.0.0.1 --port %port% --outDir "%output%" --open

:finish
set "result=%errorlevel%"
popd
exit /b %result%

:usage
echo Usage: run.cmd [release^|debug] 1>&2
exit /b 2
