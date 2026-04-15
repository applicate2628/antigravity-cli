@echo off
REM Start the antigravity-cli API server. Keep this window open while using claude-ag / Cursor / etc.
cd /d "%~dp0"
title Antigravity CLI Server :6012
node index.js serve
pause
