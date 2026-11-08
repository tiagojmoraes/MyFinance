# BATERIA v50 — roda no terminal do VS Code (PowerShell)
# Uso:  .\scripts\run-bateria.ps1
#       .\scripts\run-bateria.ps1 -SomenteBateria   (só v50-bateria, mais rápido)
#       .\scripts\run-bateria.ps1 -Todos              (todos os testes)
# Mostra TUDO no terminal (passou + falhou + erro) e salva em BATERIA-RESULTADO.txt
param(
  [switch]$SomenteBateria,
  [switch]$Todos,
  [switch]$Bateria51,
  [switch]$Bateria52
)
$ErrorActionPreference = "Continue"
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$log = "BATERIA-RESULTADO.txt"
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  MyFinance — BATERIA v50  [$stamp]" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""
if ($Bateria52) {
  Write-Host "Rodando caça-bug v52 (npm run test:bateria52)..." -ForegroundColor Yellow
  $cmd = "npm run test:bateria52"
} elseif ($Bateria51) {
  Write-Host "Rodando bateria v51 completa (alterações/inclusões/exclusões/cálculos/cards/contas/Ajustes/NFC-e)..." -ForegroundColor Yellow
  $cmd = "npm run test:bateria51"
} elseif ($Todos) {
  Write-Host "Rodando TODOS os testes (npm run test:all) — inclui v50 + v51 + v52 + antigos..."  -ForegroundColor Yellow
  $cmd = "npm run test:all"
} else {
  Write-Host "Rodando só a bateria v50 (npm run test:bateria)..." -ForegroundColor Yellow
  $cmd = "npm run test:bateria"
}
Write-Host "Comando: $cmd" -ForegroundColor DarkGray
Write-Host "Log: $log" -ForegroundColor DarkGray
Write-Host ""
# Roda e mostra no terminal E salva no arquivo ao mesmo tempo (Tee-Object)
# Se der erro de jest, o erro aparece aqui também — não é escondido.
try {
  Invoke-Expression $cmd | Tee-Object -FilePath $log
  $code = $LASTEXITCODE
} catch {
  $_ | Tee-Object -FilePath $log -Append
  $code = 1
}
Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
if ($code -eq 0) {
  Write-Host "  ✅ TODOS PASSARAM  (exit code 0)" -ForegroundColor Green
} else {
  Write-Host "  ❌ HOUVE FALHA  (exit code $code)" -ForegroundColor Red
  Write-Host "  Abra BATERIA-RESULTADO.txt e procure por 'FAIL' ou '✕'" -ForegroundColor Red
  Write-Host "  Ou rode: Select-String -Path BATERIA-RESULTADO.txt -Pattern 'FAIL|✕|Error'" -ForegroundColor DarkGray
}
Write-Host "  Log completo em: $log" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
