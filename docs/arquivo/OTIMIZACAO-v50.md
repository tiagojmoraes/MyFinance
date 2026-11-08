# v50 — FLUXO: SQL sem subquery correlacionada + paralelo (SEM MEXER EM LAYOUT)

1. BalanceService: JOIN em vez de subquery correlacionada por linha
   - Antes: COALESCE((SELECT initial_balance_date FROM accounts WHERE id=...)) por linha -> 200 linhas = 200 subqueries x 3 queries
   - Depois: LEFT JOIN accounts a_anchor ON a_anchor.id = fm.account_id + COALESCE(a_anchor.initial_balance_date, '0000-01-01')
   - Mesmo resultado, 1 scan. Saldo idêntico, garantia v49 mantida (dataVersion).

2. flowModel FLOW_COLUMNS: LEFT JOIN pré-agregado em vez de 4 subqueries por linha
   - Antes: (SELECT COUNT(*) FROM installments...), (SELECT COUNT(*) FROM transactions ch...), (SELECT SUM... EXPENSE), (SELECT SUM... INCOME) por linha -> 200 linhas = 800 subqueries
   - Depois: 2 LEFT JOIN (SELECT ... GROUP BY ...) — 2 scans, mesmo resultado.
   - group_debits/credits, child_count, plan_paid_count idênticos.

3. Fluxo: promoteDuePendings + ensureForecastThrough em Promise.all paralelo
   - Antes: sequencial 700ms. Agora: max(300,400)=400ms. Independentes (tabelas diferentes), seguro.

SEM MUDANÇA DE LAYOUT: Fluxo continua mês inteiro, sem paginação, mesmo card, mesmo MonthScroller.
GARANTIA v49 mantida: dataVersion + bump, nenhum cache global.
