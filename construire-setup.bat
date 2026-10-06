@echo off
chcp 65001 > nul
setlocal
title VoxForge - construction de l'installeur
cd /d "%~dp0"
echo.
echo  === VoxForge : construction de l'installeur Windows ===
echo.

set NODEMAJ=
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node" 2^>nul') do set NODEMAJ=%%v
if not defined NODEMAJ goto sansnode
if %NODEMAJ% LSS 20 goto vieuxnode

rem Le moteur IA ne doit jamais tenter de se recompiler : les binaires Windows prêts à l'emploi suffisent.
set NODE_LLAMA_CPP_SKIP_DOWNLOAD=true
set CSC_IDENTITY_AUTO_DISCOVERY=false

echo  [1/3] Installation des dépendances - première fois : 5 à 10 minutes, environ 1 Go...
call npm ci --no-audit --no-fund
if errorlevel 1 call npm install --no-audit --no-fund
if errorlevel 1 goto erreur
echo.

echo  [2/3] Préparation de ffmpeg...
call node scripts\preparer-ffmpeg.js
if errorlevel 1 goto erreur
echo.

echo  [3/3] Construction de VoxForge-Setup.exe...
if defined FORGE_MAJ_JETON (echo  Jeton de mise à jour fourni : cette version saura se mettre à jour.) else (echo  Sans jeton FORGE_MAJ_JETON : cette version ne se mettra pas à jour toute seule.)
call npm run build
if errorlevel 1 goto erreur
echo.

for %%f in (dist\VoxForge-Setup-*.exe) do (
  echo  Installeur : %%~nxf  -  %%~zf octets
  echo  Empreinte SHA-256 :
  certutil -hashfile "%%f" SHA256 | findstr /v ":"
)
echo.
echo  Terminé : l'installeur est dans le dossier dist.
start "" "%~dp0dist"
pause
exit /b 0

:sansnode
echo  Node.js n'est pas installé. Télécharge la version LTS sur https://nodejs.org puis relance ce fichier.
start "" https://nodejs.org
pause
exit /b 1

:vieuxnode
echo  Node.js %NODEMAJ% est trop ancien : il faut la version 20 ou plus récente. Mets-le à jour depuis https://nodejs.org
start "" https://nodejs.org
pause
exit /b 1

:erreur
echo.
echo  La construction a échoué : lis les messages ci-dessus.
pause
exit /b 1
