@echo off
rem Double-click to run the stall planner and open its report in your browser.
rem Takes a minute or two: it reads every active member's tasks and inventories.
title Stall Planner
cd /d "%~dp0.."
set PYTHONIOENCODING=utf-8
python tools\stall_planner.py --html %*
if errorlevel 1 (
    echo.
    echo The stall planner failed - see the message above.
    pause
    exit /b 1
)
echo.
echo Done. The report opened in your browser: tools\stall_plan.html
pause
