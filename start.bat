@echo off
echo ============================================
echo   Voice Live HAR Visualizer
echo   http://localhost:8066
echo ============================================
echo.
echo Starting local server...
echo Press Ctrl+C to stop.
echo.
start http://localhost:8066
python -m http.server 8066
