@echo off
setlocal enabledelayedexpansion
rem kai.cmd — Windows terminal client launcher for the Kai desktop app.
rem
rem Runs the CLI inside the app's own Electron binary (via --kai-cli), so no
rem separate Node runtime is needed. Shipped at Kai\resources\bin\kai.cmd and
rem placed on PATH by the NSIS installer.
rem
rem NOTE: Windows Electron binaries are GUI-subsystem, so console attach to the
rem parent terminal can be unreliable for a full TUI. If the Ink UI does not
rem render, this needs a dedicated console-subsystem launcher (tracked).

rem 1. Explicit override.
if defined KAI_APP_BINARY (
  if exist "%KAI_APP_BINARY%" (
    "%KAI_APP_BINARY%" --kai-cli %*
    exit /b %ERRORLEVEL%
  )
)

rem 2. PRIMARY: derive the app exe from this script's own location.
rem    Shipped at <app>\resources\bin\kai.cmd -> <app>\Kai.exe (two dirs up).
set "SELF_DIR=%~dp0"
for %%I in ("%SELF_DIR%..\..") do set "APP_DIR=%%~fI"
if exist "%APP_DIR%\Kai.exe" (
  "%APP_DIR%\Kai.exe" --kai-cli %*
  exit /b %ERRORLEVEL%
)

rem 3. Fixed install locations.
for %%P in (
  "%LOCALAPPDATA%\Programs\Kai\Kai.exe"
  "%ProgramFiles%\Kai\Kai.exe"
) do (
  if exist %%P (
    %%P --kai-cli %*
    exit /b !ERRORLEVEL!
  )
)

echo kai: could not locate the Kai app binary.>&2
echo      Install Kai, or set KAI_APP_BINARY to Kai.exe.>&2
exit /b 127
