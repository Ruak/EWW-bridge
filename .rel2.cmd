@echo off
cd /d E:\repo\EWW
call npm.cmd version 1.1.9 --no-git-tag-version > .rel2.log 2>&1
call npm.cmd run package >> .rel2.log 2>&1
echo === uninstall old === >> .rel2.log
call code --uninstall-extension huangdan.eww-bridge >> .rel2.log 2>&1
echo === remove stale dirs === >> .rel2.log
for %%V in (1.1.6 1.1.7 1.1.8) do (
  if exist "%USERPROFILE%\.vscode\extensions\huangdan.eww-bridge-%%V" rd /s /q "%USERPROFILE%\.vscode\extensions\huangdan.eww-bridge-%%V" >> .rel2.log 2>&1
)
echo === install 1.1.9 === >> .rel2.log
call code --install-extension "E:\repo\EWW\eww-bridge-1.1.9.vsix" --force >> .rel2.log 2>&1
echo === dirs now === >> .rel2.log
dir /b "%USERPROFILE%\.vscode\extensions" | findstr /I eww >> .rel2.log 2>&1
echo === nls in installed === >> .rel2.log
dir /b "%USERPROFILE%\.vscode\extensions\huangdan.eww-bridge-1.1.9" | findstr /I nls >> .rel2.log 2>&1
git -c user.name=huangdan -c user.email=huangdan00@whu.edu.cn add -A >> .rel2.log 2>&1
git -c user.name=huangdan -c user.email=huangdan00@whu.edu.cn commit -m "1.1.9: i18n diagnostics + switch display language action" >> .rel2.log 2>&1
git -c http.proxy= -c https.proxy= push origin main >> .rel2.log 2>&1
echo === end === >> .rel2.log
