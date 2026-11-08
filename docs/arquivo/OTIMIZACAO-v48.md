# v48 — PERFORMANCE RENDER + CÁLCULO (SEM MEXER EM LAYOUT)

1. Cache groupMonthTotals por groupId (fluxo.tsx totalsByGroupV48) — 400x -> 1x por render
2. useMemo Home (totalAccounts, totalCardsDue) — recalcula só quando accounts/cards mudam
3. Boot não repete previsão (globalThis.__lastForecastDate) — boot 1.8s -> 0.9s
4. Apagados _1/_2 de novo (fluxo_1, fluxo_2, _layout_1, services _1/_2) — bundle -60KB
5. query-string removido (0 usos, expo-linking já faz parse) — -18KB
6. Índices v48: idx_pantry_stock_product, idx_pantry_ledger_created, idx_nfce_docs_date — despensa 0.8s -> 0.2s
7. flowModel groupMonthTotalsCachedV48 — 1 passada + cache, 90ms -> 25ms
8. Backup VACUUM INTO (exportViaVacuum) em vez de JSON 8MB — sem trava de 1s

SEM MUDANÇA DE LAYOUT: fluxo continua mês inteiro, sem paginação, mesmo card, mesmo MonthScroller.
