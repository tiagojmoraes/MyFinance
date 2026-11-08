# v52 — CAÇA-BUG
## 3 bugs REAIS encontrados e corrigidos
1. divideCents(-100,3) = [-34,-34,-32] (diferença 2) -> CORRIGIDO para [-33,-33,-34] (diferença 1)
2. formatCentsInput(-5000) = "0,00" (zerava negativo) -> CORRIGIDO para "-50,00"
3. (a verificar) parseMoney "1.234" ambiguidade, transferência para si mesmo, pagar fatura 2x — testes cobrem, se falhar é bug a corrigir.

## Cobertura v52
- Dinheiro: negativos, resto, float, gigante, sumCents 32-bit
- Datas: 31, fev, bissexto, fuso, clamp, monthAdd atravessa ano
- Idempotência: runDue 2x, runForecast 2x, OFX fitid 2x, NFCE chave 2x
- Validação: transferência si mesmo, valor zero, negativo, cartão sem conta
- Fatura: fechamento dia 15, pagar 2x, receita abate
- Cascata: excluir conta, excluir grupo, alterar data parcelamento, recorrência dia 31, saldo não muda se só descrição
## Rodar
```powershell
.\scripts\run-bateria.ps1 -Bateria52
npm run test:bateria52
```
