@echo off
cd /d E:\repo\EWW
git checkout -- .vscode/tasks.json 2>nul
del /q .verify.cmd .verify.txt .finish.log 2>nul
