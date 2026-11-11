@echo off
REM Run gateway desktop tests
cd /d "%~dp0apps\desktop"
node_modules\.bin\tsx --test src\main\gateway.test.ts
exit /b %errorlevel%