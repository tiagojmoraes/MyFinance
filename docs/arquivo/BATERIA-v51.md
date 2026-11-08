# v51 — BATERIA COMPLETA DEFINITIVA
## O que a v50 NÃO tinha (e a v51 tem)
- v50: só INCLUSÃO, 1 exclusão, 0 alteração, 0 Ajustes, 0 todas as classes, 0 crédito/débito explícito, NFC-e só gate.
- v51: ALTERAÇÕES (valor/data/conta/descrição/fixa/parcelamento/cartão/conta), INCLUSÕES (todas as classes), EXCLUSÕES (física, grupo, parcela, fixa, pagamento de fatura), CÁLCULOS (EFETIVO/PREVISTO por dia, CRÉDITO/DEBITO, fatura, conta), AJUSTES (fluxo_saldo_por_dia, incluir no saldo, orçamentos, poupança, NFC-e provider, limpar lançamentos), TODAS AS CLASSES (SIMPLE, CONSOLIDATED, TRANSFER, INCOME, EXPENSE, RECURRENCE, INSTALLMENT cartão/conta, OFX, NFCE, MANUAL), CRÉDITO/DEBITO (moves direction), NFC-e completa (documento, itens, produto, estoque, lançamento NFCE).

## Como rodar
```powershell
npm install
.\scripts\run-bateria.ps1 -Bateria51   # só v51
.\scripts\run-bateria.ps1 -Todos        # todos (v50+v51+antigos)
npm run test:bateria51
```

## Ajustes -> Saldo diário EFETIVO/PREVISTO (o que a bateria prova)
- fluxo_saldo_por_dia: só liga/desliga exibição, cálculo continua existindo.
- Conta com include_in_general_balance=0 NÃO entra no EFETIVO/PREVISTO do Fluxo. Ligar de volta volta a somar.
- EFETIVO = só CONFIRMED até o dia. PREVISTO = CONFIRMED + PENDING até o dia.
- Alterar valor/data -> EFETIVO/PREVISTO recalculam (dataVersion++).
