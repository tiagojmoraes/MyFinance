@echo off
REM BATERIA v50 — roda no terminal do VS Code (CMD)
REM Uso:  scripts\run-bateria.bat
REM       scripts\run-bateria.bat todos   (todos os testes)
echo ==================================================
echo   MyFinance — BATERIA v50
echo ==================================================
echo.
if "%1"=="todos" (
  echo Rodando TODOS os testes...
  call npm run test:all > BATERIA-RESULTADO.txt 2>&1
) else (
  echo Rodando so a bateria v50...
  call npm run test:bateria > BATERIA-RESULTADO.txt 2>&1
)
type BATERIA-RESULTADO.txt
echo.
echo ==================================================
if %ERRORLEVEL%==0 (
  echo   TODOS PASSARAM
) else (
  echo   HOUVE FALHA - veja BATERIA-RESULTADO.txt, procure por FAIL
)
echo   Log em: BATERIA-RESULTADO.txt
echo ==================================================
pause
