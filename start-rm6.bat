@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ==================================================
echo   RM6 Pink Album - Server + Cloudflare Tunnel
echo ==================================================
echo.

echo [1/2] Starting RM6 Pink Album server on port 3000...
start "RM6 Pink Album Server" cmd /k "cd /d "%~dp0" && npm start"

timeout /t 3 /nobreak >nul

echo [2/2] Starting Cloudflare Quick Tunnel (Free HTTPS)...
echo Copy the https://xxxx.trycloudflare.com URL below to share / open QR!
echo (Keep both windows open while in use)
echo.

where cloudflared >nul 2>&1
if %errorlevel%==0 (
  cloudflared tunnel --url http://localhost:3000
) else (
  "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000
)

pause
