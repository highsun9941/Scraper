@echo off
if "%~1"=="" (
  echo Drag media-manifest.json or download-report.json / CSV onto this file.
  echo HLS / DASH to MP4 requires ffmpeg.exe and ffprobe.exe in this folder or on PATH.
  pause
  exit /b 1
)
where py >nul 2>nul
if not errorlevel 1 goto use_py
where python >nul 2>nul
if not errorlevel 1 goto use_python
echo Python 3.10 or newer is required: https://www.python.org/downloads/windows/
pause
exit /b 1
:use_py
py -3 "%~dp0download-videos.py" "%~1"
set "download_exit=%errorlevel%"
goto finished
:use_python
python "%~dp0download-videos.py" "%~1"
set "download_exit=%errorlevel%"
goto finished
:finished
echo.
pause
exit /b %download_exit%
