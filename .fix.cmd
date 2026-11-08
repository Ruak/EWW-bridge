@echo off
cd /d E:\repo\EWW
echo === cleanup temp === > .fix.log 2>&1
del /q .l10n.cmd .l10n.log .l10n2.cmd .l10n2.log .rel2.cmd .rel2.log 2>nul
git rm --cached -q .l10n.cmd .l10n2.cmd .rel2.cmd >> .fix.log 2>&1
echo === vscodeignore tail === >> .fix.log
echo .* >> .vscodeignore
echo !.vscodeignore >> .vscodeignore
type .vscodeignore >> .fix.log
echo === repackage === >> .fix.log
call npm.cmd run package >> .fix.log 2>&1
call code --install-extension "E:\repo\EWW\eww-bridge-1.1.9.vsix" --force >> .fix.log 2>&1
git -c user.name=huangdan -c user.email=huangdan00@whu.edu.cn add -A >> .fix.log 2>&1
git -c user.name=huangdan -c user.email=huangdan00@whu.edu.cn commit -m "chore: drop temp files from repo and vsix" >> .fix.log 2>&1
git -c http.proxy= -c https.proxy= push origin main >> .fix.log 2>&1
echo === end === >> .fix.log
