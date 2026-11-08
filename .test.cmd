@echo off
cd /d E:\repo\EWW
call npm.cmd test > .test.log 2>&1
echo === exit %ERRORLEVEL% === >> .test.log
