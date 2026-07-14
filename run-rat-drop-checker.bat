@echo off
chcp 65001 >nul
cd /d "%~dp0"
node rat-drop-checker.js
pause
