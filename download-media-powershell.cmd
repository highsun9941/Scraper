@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
if "%~1"=="" (
  echo Drag media-manifest.json or download-report.json onto this file.
  echo CSV reports and one-URL-per-line text files are also supported.
  pause
  exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0download-media.ps1" -Manifest "%~f1"
set "media_exit=%errorlevel%"
echo.
pause
exit /b %media_exit%
