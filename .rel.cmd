@echo off
cd /d E:\repo\EWW
call npm.cmd version 1.1.8 --no-git-tag-version > .rel.log 2>&1
call npm.cmd run package >> .rel.log 2>&1
call code --install-extension "E:\repo\EWW\eww-bridge-1.1.8.vsix" --force >> .rel.log 2>&1
git -c user.name=huangdan -c user.email=huangdan00@whu.edu.cn add -A >> .rel.log 2>&1
git -c user.name=huangdan -c user.email=huangdan00@whu.edu.cn commit -m "1.1.8: 5 visible commands, zero-config feishu pairing" >> .rel.log 2>&1
git -c http.proxy= -c https.proxy= push origin main >> .rel.log 2>&1
echo === end === >> .rel.log
