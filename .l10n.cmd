@echo off
cd /d E:\repo\EWW
echo === argv.json === > .l10n.log 2>&1
type "%APPDATA%\Code\User\argv.json" >> .l10n.log 2>&1
echo === extensions (locale packs + eww) === >> .l10n.log
code --list-extensions --show-versions >> .l10n.log 2>&1
echo === installed eww dirs === >> .l10n.log
dir /b "%USERPROFILE%\.vscode\extensions" | findstr /I eww >> .l10n.log 2>&1
echo === eww 1.1.8 files === >> .l10n.log
dir /b "%USERPROFILE%\.vscode\extensions\huangdan.eww-bridge-1.1.8" 2>nul >> .l10n.log 2>&1
echo === version in installed package.json === >> .l10n.log
node -e "const p=require(process.env.USERPROFILE+'/.vscode/extensions/huangdan.eww-bridge-1.1.8/package.json');console.log(p.version, p.contributes.commands.length)" >> .l10n.log 2>&1
echo === end === >> .l10n.log
