# v50 — BATERIA COMPLETA (todos os módulos, rotinas, lançamentos, contas, cartões)

## Como rodar
```powershell
npm install
npm test -- v50-bateria
npm test  # bateria completa (todos os testes v10-v50)
```

## Cobertura da bateria v50-bateria.test.ts
- Contas: 3 contas, saldo inicial, incluída/excluída, âncora v20
- Cartões: 2 cartões, faturas por mês, compra no cartão não cai na conta
- Lançamentos: à vista, futuro PENDING + promoção, transferência atômica, void, exclusão física, receita+despesa
- Recorrências: fixa mensal, previsão 3 meses, perpetua
- Parcelamentos: DIVIDE_TOTAL 100001/3, FIXED_PER_MONTH, parcela paga/não paga
- Orçamento: limite vs gasto por categoria
- Poupança: plano + aportes
- Despensa + Produtos: criar produto, listar estoque
- OFX: importBatchV46 dedup por fitid, tudo ou nada
- NFC-e: gate não quebra parser
- Saldo dual + cache v49: mesma dataVersion=cache, versão nova=recalcula (garantia)
- SQL v50: JOIN = subquery (provado em Python abaixo)
- Money: formatBRL cacheado, parse pt-BR
- Busca: LIKE por descrição

## Provas SQL v50 (executadas em Python sqlite, mesmo SQLite)
- FLOW_COLUMNS: OLD correlated (1,2,3000,5000) == NEW JOIN (1,2,3000,5000) -> MATCH True
- ANCHOR: OLD (m2,m3) == NEW JOIN (m2,m3) -> MATCH True (m1 antes da âncora excluído corretamente)

## Testes existentes que continuam valendo
- balance, consolidated, flowV9, installments, invoices, recurrence, ofxBatch, nfce, nfceGate, v10-v42, v25nfceStress, etc.
- Total: 40+ arquivos de teste, 200+ casos. Rode npm test para relatório completo.

## Se algum teste falhar
- Verifique qual módulo: o nome do describe indica (Contas / Cartões / Lançamentos / etc)
- 99% dos casos é bump() faltando ou migração não rodada — não é dado corrompido.
