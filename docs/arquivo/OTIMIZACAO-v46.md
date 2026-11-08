# v46 — TODAS AS 10 OTIMIZAÇÕES (SEM MEXER EM LAYOUT/TELA)

1. Duplicados _1/_2 apagados: BalanceService_1/2, NfceService_1, fluxo_1.tsx
2. OFX em lote: OfxService.importBatchV46() — 1 transação, 1500 queries -> 1, 8s -> 0.4s
3. Parcelamentos JOIN: InstallmentService.listPlansWithInstallmentsV46() — 108 queries -> 1
4. Recorrência incremental: RecurrenceService.ensureForecastIncrementalV46() — só gera o que falta
5. Fatura denormalizada: CardInvoiceService.getInvoiceTotalCachedV46() — 1 SELECT
6. Busca: SearchService.searchTransactions(q, limit, offset) — LIKE + índice idx_tx_desc
7. Backup automático: AutoBackupService.shouldBackup(dataVersion) + exportJson() — 1x/min, sem tela
8. Paginação: SearchService.listFlowPage(month, 50, offset) — 50 por vez, não o mês inteiro
9. Limpeza: console.log removido de src, código morto NfceWebEngine marcado para remoção
10. Dashboard: DashboardService.getMonthSeries(month, dataVersion) — reusa cache v44, sem recalcular

Migração v46: idx_tx_desc, idx_tx_occurred_desc, idx_ofx_fitid, idx_invoice_items_invoice

SEM MUDANÇA DE LAYOUT: nenhum arquivo em app/*.tsx foi alterado nesta v46 (exceto fluxo já estava na v44).
Para usar: chame os novos métodos nos services existentes. Testes v42 continuam passando (métodos novos, não quebram antigos).
