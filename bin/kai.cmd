@echo off
setlocal DisableDelayedExpansion
rem kai.cmd — Windows terminal client launcher for the Kai desktop app.
rem
rem Runs the CLI inside the app's own Electron binary (via --kai-cli), so no
rem separate Node runtime is needed. Shipped at Kai\resources\bin\kai.cmd and
rem placed on PATH by the NSIS installer.
rem
rem NOTE: Windows Electron binaries are GUI-subsystem, so console attach to the
rem parent terminal can be unreliable for a full TUI. If the Ink UI does not
rem render, this needs a dedicated console-subsystem launcher (tracked).
rem
rem Implementation notes:
rem  - Delayed expansion is DISABLED so args/paths containing "!" (via %*,
rem    KAI_APP_BINARY, or an install path) are not corrupted.
rem  - The app exe is resolved into KAI_EXE, then invoked OUTSIDE any
rem    parenthesized block, so %ERRORLEVEL% reflects the app's real exit code
rem    (inside a block it would expand at parse time to a stale value).

rem 1. Explicit override.
if defined KAI_APP_BINARY (
  if exist "%KAI_APP_BINARY%" set "KAI_EXE=%KAI_APP_BINARY%"
)

rem 2. PRIMARY: derive the app exe from this script's own location.
rem    Shipped at <app>\resources\bin\kai.cmd -> <app>\Kai.exe (two dirs up).
if not defined KAI_EXE (
  set "SELF_DIR=%~dp0"
  for %%I in ("%~dp0..\..") do set "APP_DIR=%%~fI"
)
if not defined KAI_EXE if exist "%APP_DIR%\Kai.exe" set "KAI_EXE=%APP_DIR%\Kai.exe"

rem 3. Fixed install locations.
if not defined KAI_EXE if exist "%LOCALAPPDATA%\Programs\Kai\Kai.exe" set "KAI_EXE=%LOCALAPPDATA%\Programs\Kai\Kai.exe"
if not defined KAI_EXE if exist "%ProgramFiles%\Kai\Kai.exe" set "KAI_EXE=%ProgramFiles%\Kai\Kai.exe"

if not defined KAI_EXE (
  echo kai: could not locate the Kai app binary.>&2
  echo      Install Kai, or set KAI_APP_BINARY to Kai.exe.>&2
  exit /b 127
)

rem Invoke at top level (not inside a block) so %ERRORLEVEL% is the app's.
"%KAI_EXE%" --kai-cli %*
exit /b %ERRORLEVEL%
