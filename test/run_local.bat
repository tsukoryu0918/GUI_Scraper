
rem If you are running it for the first time, please run the following two lines:
rem pip install playwright
rem python -m playwright install chromium

@echo off
setlocal enabledelayedexpansion

pushd "%~dp0"

set "PC_ID=02"
set "LIST_NAME=jobchan_detail_urls_2"

set "INPUT_CSV=jobchan_detail_urls_2.csv"
set "OUTPUT_CSV=datalist.csv"

if not exist "%INPUT_CSV%" (
  echo ERROR: INPUT_CSV not found: "%INPUT_CSV%"
  goto :ERR
)

set "PY_EXE="
set "PY_ARGS="

where python >nul 2>&1 && set "PY_EXE=python"
if not defined PY_EXE (
  where py >nul 2>&1 && ( set "PY_EXE=py" & set "PY_ARGS=-3" )
)
if not defined PY_EXE (
  echo ERROR: Python not found.
  goto :ERR
)

echo PY: %PY_EXE% %PY_ARGS%

if exist "%OUTPUT_CSV%" del /f /q "%OUTPUT_CSV%"

echo --- run scraper ---
"%PY_EXE%" %PY_ARGS% gui_scraper_runner.py "%INPUT_CSV%" "%OUTPUT_CSV%"
if errorlevel 1 goto :ERR

echo --- rename ---
"%PY_EXE%" %PY_ARGS% rename.py "%PC_ID%" "%LIST_NAME%" "%OUTPUT_CSV%"
if errorlevel 1 goto :ERR

echo rename finished. pausing 5s...
timeout /t 5 /nobreak >nul

set "RENAMED="
for /f "delims=" %%F in ('dir /b /a:-d /o:-d *.csv 2^>nul') do (
  if /i not "%%~nxF"=="%OUTPUT_CSV%" (
    set "RENAMED=%cd%%%F"
    goto :FOUND_RENAMED
  )
)
:FOUND_RENAMED

if not defined RENAMED (
  echo ERROR: renamed CSV not found
  goto :ERR
)

echo RENAMED: %RENAMED%

echo --- send ---
"%PY_EXE%" %PY_ARGS% send.py "%PC_ID%" "%LIST_NAME%" "%RENAMED%"
if errorlevel 1 goto :ERR

echo send finished. pausing 5s...
timeout /t 5 /nobreak >nul

echo DONE
popd
exit /b 0

:ERR
echo FAILED
popd
exit /b 1
