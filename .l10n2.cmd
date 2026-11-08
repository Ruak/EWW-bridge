@echo off
cd /d E:\repo\EWW
echo === E:\VSCodeData === > .l10n2.log 2>&1
dir /b E:\VSCodeData >> .l10n2.log 2>&1
echo === argv candidates === >> .l10n2.log
for %%P in ("E:\VSCodeData\data\user-data\argv.json" "E:\VSCodeData\User\argv.json" "E:\VSCodeData\argv.json" "%APPDATA%\Code\User\argv.json") do (
  if exist %%P (echo FOUND %%P >> .l10n2.log & type %%P >> .l10n2.log) else (echo missing %%P >> .l10n2.log)
)
echo === extension dirs === >> .l10n2.log
for %%D in ("E:\VSCodeData\extensions" "E:\VSCodeData\data\extensions" "%USERPROFILE%\.vscode\extensions") do (
  if exist %%D (echo -- %%D >> .l10n2.log & dir /b %%D | findstr /I "eww language-pack-zh" >> .l10n2.log)
)
echo === eww installed package.nls? === >> .l10n2.log
for %%E in ("E:\VSCodeData\extensions" "E:\VSCodeData\data\extensions" "%USERPROFILE%\.vscode\extensions") do (
  dir /b %%E\huangdan.eww-bridge-1.1.8 2>nul >> .l10n2.log
)
echo === zh pack info === >> .l10n2.log
for %%E in ("E:\VSCodeData\extensions" "E:\VSCodeData\data\extensions" "%USERPROFILE%\.vscode\extensions") do (
  if exist %%E\ms-ceintl.vscode-language-pack-zh-hans (node -e "const p=require(process.argv[1]+'/package.json');console.log(p.version, JSON.stringify(p.engines), p.contributes&&p.contributes.localizations?p.contributes.localizations[0].languageId:'-')" %%E\ms-ceintl.vscode-language-pack-zh-hans >> .l10n2.log 2>&1)
)
echo === end === >> .l10n2.log
