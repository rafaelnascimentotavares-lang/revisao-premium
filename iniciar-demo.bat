@echo off
cd /d "%~dp0"
title Revisao Premium - Demonstracao
where node >nul 2>nul
if errorlevel 1 goto semnode
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto semnode
if not exist node_modules\express (
  echo Instalando pela primeira vez, aguarde 1 minuto...
  call npm install
  if errorlevel 1 goto falha
)
if not exist node_modules\express goto falha
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"
call npm run demo
pause
exit /b 0
:semnode
echo.
echo Este computador precisa do Node.js 22.13 ou mais novo (versao LTS).
echo Baixe em https://nodejs.org , instale e abra este arquivo de novo.
echo.
pause
exit /b 1
:falha
echo.
echo A instalacao falhou. Verifique a internet e tente de novo.
echo Se continuar, tire uma foto desta janela e envie para o suporte.
echo.
pause
exit /b 1
