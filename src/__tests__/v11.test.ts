/**
 * Testes v11 — regras novas do Fluxo:
 *  · Req 1: parcelas em conta têm plano (planId) — base do botão "Excluir";
 *  · Req 2: getDailyBalancesDual — as DUAS visões por dia (Previsto/Efetivado);
 *  · Req 3.1: linhas Fixo/Parcelado do consolidado ficam VINCULADAS ao grupo
 *    (group_transaction_id) e a exclusão do grupo desvincula sem apagar;
 *  · Req 3.2: ensureForecastThrough garante a previsão da fixa até o mês visto
 *    (Fixo não some nos meses seguintes);
 *  · Req 3.3: parcelado no CARTÃO gera itens de fatura nos meses futuros
 *    (fica estritamente na fatura — o cabeçalho tem card_id, filtrado no Fluxo);
 *  · Req 4: plano FIXED_PER_MONTH ("Parcela fixa") via Novo Lançamento.
 */

import { makeCtx, seedAccount, seedCard } from './helpers';
import { todaySP, monthOf, monthAdd } from '../lib/dates';

let ctx: ReturnType<typeof makeCtx> extends Promise<infer T> ? T : never;

beforeEach(async () => {
  ctx = await makeCtx();
});

describe('Req 3.2 — Fixo não some nos meses seguintes', () => {
  test('ensureForecastThrough cria a previsão até o mês alvo (idempotente)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Fixa', 0);
    await services.recurrences.createRule({
      description: 'Aluguel',
      type: 'EXPENSE',
      amountCents: 150_000,
      dayOfMonth: 5,
      startDate: todaySP(),
      accountId: accId,
    });
    const target = monthAdd(monthOf(todaySP()), 6);
    const first = await services.recurrences.ensureForecastThrough(target);
    expect(first.createdForecast).toBeGreaterThanOrEqual(6);

    // Segunda execução NÃO duplica (idempotência ARQ-003)
    const second = await services.recurrences.ensureForecastThrough(target);
    expect(second.createdForecast).toBe(0);

    // A ocorrência do mês alvo existe como PENDING e aparece na lista do mês
    const rows = await services.transactions.listFlow(target);
    const aluguel = rows.find((r) => r.description === 'Aluguel');
    expect(aluguel).toBeTruthy();
    expect(aluguel!.status).toBe('PENDING');
    expect(db).toBeTruthy();
  });
});

describe('Req 2 — Saldos do dia Previsto e Efetivado', () => {
  test('efetivado ignora pendências; previsto inclui pending, parcela e fatura', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Saldo', 100_000); // R$ 1.000,00
    const cardId = await seedCard(db, accId, 'Cartão Saldo', 15, 20);

    // 1. Lançamento PENDING em conta (débito futuro) — 30/06
    await db.runAsync(
      `INSERT INTO transactions (id, kind, type, amount_cents, occurred_on, occurred_at, description, account_id, card_id, source_system, status)
       VALUES ('tx-pend', 'SIMPLE', 'EXPENSE', 10_000, '2026-06-30', '2026-06-30T12:00:00.000Z', 'Pendente', ?, NULL, 'MANUAL', 'PENDING')`,
      [accId]
    );

    // 2. Parcela em conta PENDING vencendo 10/06
    await services.installments.createPlan({
      description: 'Notebook',
      mode: 'DIVIDE_TOTAL',
      totalCents: 12_000,
      totalInstallments: 2,
      firstDueDate: '2026-06-10',
      accountId: accId,
    });

    // 3. Compra no cartão → fatura de junho (fechamento dia 15 → compra dia 10 fica em junho)
    await services.transactions.createCardExpense({
      description: 'Compra cartão',
      amountCents: 5_000,
      date: '2026-06-10',
      cardId,
    });

    const dual = await services.balance.getDailyBalancesDual('2026-06');
    const efet = dual.efetivado;
    const prev = dual.previsto;

    // Antes de qualquer pendência (dia 1): efetivado = saldo inicial
    expect(efet['2026-06-01']).toBe(100_000);
    expect(prev['2026-06-01']).toBe(100_000);

    // Depois da parcela (10/06): efetivado NÃO muda (parcela em aberto é previsão);
    // previsto cai só a parcela (R$ 60) — a fatura do cartão vence dia 20/06
    expect(efet['2026-06-10']).toBe(100_000);
    expect(prev['2026-06-10']).toBe(100_000 - 6_000);

    // No vencimento da fatura (20/06): previsto acumula também os R$ 50
    expect(prev['2026-06-20']).toBe(100_000 - 6_000 - 5_000);

    // Depois do pendente (30/06): previsto acumula também os R$ 100 pendentes
    expect(efet['2026-06-30']).toBe(100_000);
    expect(prev['2026-06-30']).toBe(100_000 - 6_000 - 5_000 - 10_000);

    // Efetivado NÃO contabiliza os futuros: segue no saldo inicial
    expect(efet['2026-06-15']).toBe(100_000);
  });
});

describe('Req 3.1 — Consolidado agrupa TODAS as linhas vinculadas', () => {
  test('fixa e parcelamento criados no grupo ficam com group_transaction_id; excluir grupo desvincula', async () => {
    const { services, db } = ctx;
    const accId = await seedAccount(db, 'Conta Grupo', 0);

    // 1. Grupo com linha à vista
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Operação do mês',
      date: todaySP(),
      accountId: accId,
      lines: [{ direction: 'DEBIT', description: 'Mercado', amountCents: 20_000, categoryId: null }],
    });
    expect(grupo).not.toBeNull();

    // 2. Linha FIXA do consolidado → vinculada
    const regra = await services.recurrences.createRule({
      description: 'Luz (fixa do grupo)',
      type: 'EXPENSE',
      amountCents: 8_000,
      dayOfMonth: 10,
      startDate: todaySP(),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    expect(regra.group_transaction_id).toBe(grupo!.id);

    // 3. Linha PARCELADA do consolidado → vinculada
    const { planId } = await services.installments.createPlan({
      description: 'Celular (parcelado do grupo)',
      mode: 'DIVIDE_TOTAL',
      totalCents: 30_000,
      totalInstallments: 3,
      firstDueDate: todaySP(),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    const planRow = await ctx.db.getFirstAsync<{ group_transaction_id: string | null }>(
      'SELECT group_transaction_id FROM installment_plans WHERE id = ?',
      [planId]
    );
    expect(planRow?.group_transaction_id).toBe(grupo!.id);

    // 4. Excluir o GRUPO: linhas à vista somem; fixa/parcelado SOBREVIVEM desvinculadas
    await services.transactions.deleteTransaction(grupo!.id);
    const regraAfter = await ctx.db.getFirstAsync<{ group_transaction_id: string | null }>(
      'SELECT group_transaction_id FROM recurrence_rules WHERE id = ?',
      [regra.id]
    );
    expect(regraAfter?.group_transaction_id).toBeNull();
    const planAfter = await ctx.db.getFirstAsync<{ group_transaction_id: string | null }>(
      'SELECT group_transaction_id FROM installment_plans WHERE id = ?',
      [planId]
    );
    expect(planAfter?.group_transaction_id).toBeNull();
    const planStill = await ctx.db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM installments WHERE plan_id = ? AND status = 'PENDING'",
      [planId]
    );
    // parcelas pendentes do plano vinculado NÃO são tocadas pela exclusão do grupo
    expect(planStill?.n).toBe(3);
  });
});

describe('Req 3.3 — Parcelado no CARTÃO fica estritamente na fatura', () => {
  test('parcelas geram itens de fatura nos meses futuros e o cabeçalho tem card_id', async () => {
    const { services } = ctx;
    const accId = await seedAccount(ctx.db, 'Conta Cartão', 0);
    const cardId = await seedCard(ctx.db, accId, 'Cartão Parcelado', 15, 10);

    const { planId } = await services.installments.createPlan({
      description: 'Notebook cartão',
      mode: 'DIVIDE_TOTAL',
      totalCents: 24_000,
      totalInstallments: 4,
      firstDueDate: '2026-06-05',
      cardId,
    });

    // Cabeçalho do plano nasceu com card_id (o Fluxo filtra — não vira despesa comum)
    const header = await ctx.db.getFirstAsync<{ card_id: string | null }>(
      "SELECT card_id FROM transactions WHERE source_system = 'INSTALLMENT' AND description = 'Notebook cartão'"
    );
    expect(header?.card_id).toBe(cardId);

    // Parcelas 1..4 estão NAS FATURAS do cartão — o VENCIMENTO da fatura fica
    // no mês seguinte ao da parcela (venc dia 10 < fechamento dia 15):
    // parcela de junho → fatura vence 10/07; parcela de agosto → vence 10/09.
    const month1 = await services.invoices.listInvoicesDueInMonth('2026-07');
    const month3 = await services.invoices.listInvoicesDueInMonth('2026-09');
    const due1 = month1.find((m) => m.cardId === cardId);
    const due3 = month3.find((m) => m.cardId === cardId);
    expect(due1?.dueCents ?? 0).toBeGreaterThan(0);
    expect(due3?.dueCents ?? 0).toBeGreaterThan(0);

    // Nenhuma move em CONTA para o plano do cartão
    const moves = await ctx.db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM financial_moves fm JOIN installment_plans p ON p.id = fm.installment_id WHERE p.id = ?',
      [planId]
    );
    expect(moves?.n).toBe(0);
  });
});

describe('Req 4 — "Parcela fixa" (FIXED_PER_MONTH) pelo Novo Lançamento', () => {
  test('cria parcelas de valor fixo com total calculado', async () => {
    const { services } = ctx;
    const accId = await seedAccount(ctx.db, 'Conta Fixa Plano', 0);
    const { planId } = await services.installments.createPlan({
      description: 'Academia',
      mode: 'FIXED_PER_MONTH',
      fixedAmountCents: 9_000,
      totalInstallments: 12,
      firstDueDate: '2026-06-05',
      accountId: accId,
    });
    const dual = await services.installments.getDualView(planId);
    expect(dual!.cashFlow).toHaveLength(12);
    expect(dual!.cashFlow.every((c) => c.amountCents === 9_000)).toBe(true);
    expect(dual!.costReport.totalCents).toBe(108_000);
  });
});
