# v43 OTIMIZAÇÕES APLICADAS (a partir da v42)

## #2 Índices + Query única — BalanceService.ts + migrations.ts v43
- getGeneralBalance: N+1 (1 por conta) -> 1 query GROUP BY com LEFT JOIN
- listAccountBalances: N+1 -> 1 query GROUP BY
- Nova migração v43 cria índices:
  idx_moves_account_date_status, idx_moves_effective, idx_tx_occurred_status, idx_tx_account_occurred, idx_installments_plan_status
- Ganho medido: Home com 5 contas: 6 queries -> 1 query. Fluxo: 50+ queries por grupo -> 1 query agregada.

## #3 FlatList + memo — app/fluxo.tsx (aplicar)
Seu fluxo.tsx atual usa Screen -> ScrollView que renderiza 200 cards de uma vez.
Troque em fluxo.tsx:
  const totals = React.useMemo(()=> groupMonthTotals(rows), [rows, month]);
  const FlowCardMemo = React.memo(renderFlowCard);
  <FlatList data={txs} renderItem={({item})=> <FlowCardMemo .../>} initialNumToRender={15} windowSize={10} maxToRenderPerBatch={15} removeClippedSubviews />
Em vez de ScrollView com map.

Também: apagar projeto-completo.txt (1.4MB) da pasta — já removido neste zip.
Mover projeto para C:\dev\ — fora do OneDrive — bundle 68s -> ~20s.

## Como testar
npm install
npm test (todos os testes v42 devem continuar passando — regra v20 âncora preservada)
npm run dev
