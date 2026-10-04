@echo off
rem 사업아이템 분석기 서버를 켭니다. 이 창을 닫으면 서버도 꺼집니다.
chcp 65001 >nul
cd /d "%~dp0"
title Business Idea Analyzer Server
echo.
echo  [Business Idea Analyzer] server starting...
echo  Open this address in your browser:  http://127.0.0.1:5000
echo  Do NOT close this window while using the service.
echo.
".venv\Scripts\python.exe" app.py
echo.
echo  Server stopped. Press any key to close.
pause >nul
