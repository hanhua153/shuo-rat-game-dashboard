@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Cleaning up old dashboard processes...
powershell -NoProfile -Command "Get-WmiObject Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'rat-drop-dashboard' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host \"Killed PID: $($_.ProcessId)\" }"
echo Starting Rat Game Dashboard...
node rat-drop-dashboard.js
