@echo off
cd /d E:\repo\EWW
del /q .st.cmd .st.log 2>nul
git -c user.name=huangdan -c user.email=huangdan00@whu.edu.cn add -A > .c3.log 2>&1
git -c user.name=huangdan -c user.email=huangdan00@whu.edu.cn commit -m "chore: remove leftover helper script" >> .c3.log 2>&1
git -c http.proxy= -c https.proxy= push origin main >> .c3.log 2>&1
git status --short >> .c3.log 2>&1
echo === end === >> .c3.log
