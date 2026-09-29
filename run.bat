@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 24 or later is required. Install Node.js and try again.
  goto :error
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Install Node.js with npm and try again.
  goto :error
)

for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node" 2^>nul') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
  echo [ERROR] Could not determine the Node.js version.
  goto :error
)
if %NODE_MAJOR% LSS 24 (
  echo [ERROR] Node.js 24 or later is required. Found major version %NODE_MAJOR%.
  goto :error
)

if not exist "node_modules\vite\bin\vite.js" (
  echo Installing project dependencies...
  call npm install
  if errorlevel 1 goto :error
)

echo Starting Ashen Return in your browser...
call npm run dev -- --open
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] The development server exited with code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%

:error
echo.
pause
exit /b 1
