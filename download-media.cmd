@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
if "%~1"=="" (
  echo Drag media-manifest.json onto this file to start.
  echo Or run: download-media.cmd "C:\path\media-manifest.json"
  pause
  exit /b 1
)
where py >nul 2>nul
if not errorlevel 1 goto use_py
where python >nul 2>nul
if not errorlevel 1 goto use_python
echo Python 3.10 or newer is required.
echo Install Python from https://www.python.org/downloads/windows/
pause
exit /b 1
:use_py
py -3 "%~dp0download-media.py" "%~1"
set "download_exit=%errorlevel%"
goto finished
:use_python
python "%~dp0download-media.py" "%~1"
set "download_exit=%errorlevel%"
goto finished
:finished
echo.
pause
exit /b %download_exit%
