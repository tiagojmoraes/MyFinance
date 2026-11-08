# BATERIA — Como ver os resultados no terminal do VS Code (v50+v51+v52 dentro do All)

## O All agora inclui TUDO
`npm run test:all` = `jest --verbose` sem filtro = **todos os 46 arquivos**, incluindo:
- v50-bateria (18 casos) — contas, cartões, lançamentos básicos
- v51-bateria-completa (28 casos) — alterações, inclusões, exclusões, cálculos, Ajustes, todas as classes, crédito/débito, NFC-e
- v52-bug-hunt (28 casos) — divideCents negativo, formatCentsInput, datas 31/fev, idempotência, fatura, cascata
- Antigos v10-v42, balance, installments, etc. (445 casos)
**Total: 46 suítes, ~519 testes**

## Opção 1 — PowerShell (recomendada)
```powershell
.\scripts\run-bateria.ps1 -Todos       # ALL — tudo, ~2-3 min
.\scripts\run-bateria.ps1 -Bateria52    # só v52 caça-bug
.\scripts\run-bateria.ps1 -Bateria51    # só v51 completa
.\scripts\run-bateria.ps1               # só v50 (rápido)
```

## Opção 2 — npm direto
```powershell
npm run test:all        # ALL — v50+v51+v52+antigos
npm run test:bateria     # só v50+v51+v52
npm run test:bateria52   # só v52
npm run test:bateria51   # só v51
```

## O que você vai ver no All
```
PASS src/__tests__/v50-bateria.test.ts
PASS src/__tests__/v51-bateria-completa.test.ts
PASS src/__tests__/v52-bug-hunt.test.ts
PASS src/__tests__/balance.test.ts
... (43 outros)
Test Suites: 46 passed, 46 total
Tests:       519 passed, 519 total
  ✅ TODOS PASSARAM
```
Se algum falhar: `FAIL` + `✕` + `Tests: X failed` e log em BATERIA-RESULTADO.txt
Para ver só erros: `Select-String -Path BATERIA-RESULTADO.txt -Pattern "FAIL|✕|Error"`
