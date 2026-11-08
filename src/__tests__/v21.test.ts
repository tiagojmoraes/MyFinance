/**
 * Testes v21 — lote de bugs/melhorias do usuário:
 *  · BUG 1: edição ESPECÍFICA do parcelamento (updatePlanFields) — descrição,
 *    valores, número de parcelas, data e destino; pagas nunca tocadas.
 *  · BUG 2: à vista com data futura nasce PENDING (previsão) e é promovido
 *    automaticamente quando a data chega (promoteDuePendings).
 *  · BUG 3: alteração de DESCRIÇÃO de conta fixa propaga para a regra e para
 *    as ocorrências seguintes (RecurrenceService.updateRule).
 *  · BUGS 5 e 7: itens de fatura de PARCELAS trazem a descrição do usuário
 *    (âncora do plano) e o vencimento como data.
 */

import { makeCtx, seedAccount, seedCard, getAccountBalance } from './helpers';
import { monthAdd, monthOf, todaySP } from '../lib/dates';

let ctx: ReturnType<typeof makeCtx> extends Promise<infer T> ? T : never;

beforeEach(async () => {
  ctx = await makeCtx();
});

/* ================================================================
 * BUG 2 — À VISTA FUTURO: pendente/previsto até a data
 * ================================================================ */
describe('v21 bug 2 — à vista futuro não efetiva sozinho', () => {
  test('despesa futura nasce PENDING: sai do efetivado e entra no previsto', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 1_000_00);
    await services.transactions.createAccountExpense({
      description: 'Conta do mês que vem',
      amountCents: 250_00,
      date: '2099-01-20',
      accountId: acc,
    });
    const row = await db.getFirstAsync<{ status: string }>('SELECT status FROM transactions WHERE description = ?', ['Conta do mês que vem']);
    expect(row?.status).toBe('PENDING');
    // movimento existe, mas VOIDED (não conta no efetivado)
    const move = await db.getFirstAsync<{ status: string }>(
      'SELECT status FROM financial_moves WHERE transaction_id = (SELECT id FROM transactions WHERE description = ?)',
      ['Conta do mês que vem']
    );
    expect(move?.status).toBe('VOIDED');
    expect(await getAccountBalance(db, acc)).toBe(1_000_00);
  });

  test('promoção automática: vencida vira CONFIRMED e entra no saldo', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 1_000_00);
    await services.transactions.createAccountExpense({
      description: 'Agendada',
      amountCents: 250_00,
      date: '2026-11-10',
      accountId: acc,
    });
    const promoted = await services.transactions.promoteDuePendings('2026-11-10');
    expect(promoted).toBeGreaterThanOrEqual(1);
    const row = await db.getFirstAsync<{ status: string }>('SELECT status FROM transactions WHERE description = ?', ['Agendada']);
    expect(row?.status).toBe('CONFIRMED');
    const move = await db.getFirstAsync<{ status: string }>(
      'SELECT status FROM financial_moves WHERE transaction_id = (SELECT id FROM transactions WHERE description = ?)',
      ['Agendada']
    );
    expect(move?.status).toBe('CONFIRMED');
    expect(await services.balance.getAccountBalance(acc, '2026-11-10')).toBe(750_00);
  });

  test('receita e transferência futuras também nascem como previsão', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta A', 0);
    const acc2 = await seedAccount(db, 'Conta B', 0);
    await services.transactions.createAccountIncome({ description: 'Saldo futuro', amountCents: 500_00, date: '2099-02-01', accountId: acc });
    await services.transactions.createTransfer({ description: 'Reserva', amountCents: 100_00, date: '2099-02-02', fromAccountId: acc, toAccountId: acc2 });
    const pend = await db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM transactions WHERE status = 'PENDING' AND kind = 'SIMPLE' AND source_system != 'RECURRENCE'"
    );
    expect(pend?.n).toBe(2);
  });
});

/* ================================================================
 * BUGS 5 e 7 — DESCRIBÇÃO DA PARCELA NA FATURA
 * ================================================================ */
describe('v21 bugs 5/7 — descrição do usuário nas parcelas da fatura', () => {
  test('item de fatura de parcela no cartão mostra a descrição do plano e o vencimento', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Itau');
    const card = await seedCard(db, acc, 'Nubank', 15, 10);
    await services.installments.createPlan({
      description: 'Notebook gamer',
      mode: 'DIVIDE_TOTAL',
      totalCents: 120_000,
      totalInstallments: 12,
      firstDueDate: '2026-05-20',
      purchaseDate: '2026-05-05',
      cardId: card,
    });
    // Fatura de referência 2026-06 (1ª parcela, venc. 20/05 com fechamento 15)
    const detail = await services.invoices.getInvoiceDetailByCardMonth(card, '2026-06');
    expect(detail).not.toBeNull();
    const item = detail!.items.find((i) => i.installment_id != null);
    expect(item).toBeTruthy();
    expect(item!.description).toBe('Notebook gamer'); // NÃO "Parcela"
    expect(item!.occurred_on).toBe('2026-05-20'); // vencimento da parcela
    expect(item!.sequence_number).toBe(1);
    expect(item!.total_installments).toBe(12);
    // Expansor do Fluxo (mesma query): descrição correta
    const due = await services.invoices.listInvoicesDueInMonth('2026-07');
    const inv = due.find((d) => d.cardId === card);
    expect(inv).toBeTruthy();
    const it = inv!.items.find((x) => x.sequenceNumber != null);
    expect(it!.description).toBe('Notebook gamer');
    expect(it!.totalInstallments).toBe(12);
  });
});

/* ================================================================
 * BUG 1 — EDIÇÃO ESPECÍFICA DO PARCELAMENTO (updatePlanFields)
 * ================================================================ */
describe('v21 bug 1 — updatePlanFields altera cada campo refletindo nele', () => {
  test('descrição e categoria mudam a âncora; pagas intocadas; total regravado', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 0);
    const { planId } = await services.installments.createPlan({
      description: 'Móveis',
      mode: 'DIVIDE_TOTAL',
      totalCents: 100_000,
      totalInstallments: 4,
      firstDueDate: '2026-01-10',
      purchaseDate: '2026-01-05',
      accountId: acc,
    });
    // paga a 1ª parcela
    const dual1 = await services.installments.getDualView(planId);
    const first1 = dual1!.cashFlow.find((c) => c.sequence === 1)!;
    await services.installments.setPaymentStatus(
      (await db.getFirstAsync<{ id: string }>('SELECT id FROM installments WHERE plan_id = ? AND sequence_number = 1', [planId]))!.id,
      true
    );

    await services.installments.updatePlanFields(planId, {
      description: 'Móveis da sala',
      categoryId: null,
    });
    const anchor = await db.getFirstAsync<{ description: string; amount_cents: number }>(
      'SELECT t.description, t.amount_cents FROM installment_plans p JOIN transactions t ON t.id = p.original_transaction_id WHERE p.id = ?',
      [planId]
    );
    expect(anchor?.description).toBe('Móveis da sala');
    // total = pagas (25.000) + restante (75.000) — nada mudou de valor
    expect(anchor?.amount_cents).toBe(100_000);
  });

  test('mudar o modo/valor atinge só as em aberto; pagas preservadas', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 0);
    const { planId } = await services.installments.createPlan({
      description: 'Plano X',
      mode: 'DIVIDE_TOTAL',
      totalCents: 100_000,
      totalInstallments: 4,
      firstDueDate: '2026-01-10',
      accountId: acc,
    });
    const id1 = (await db.getFirstAsync<{ id: string }>('SELECT id FROM installments WHERE plan_id = ? AND sequence_number = 1', [planId]))!.id;
    await services.installments.setPaymentStatus(id1, true);

    await services.installments.updatePlanFields(planId, {
      mode: 'FIXED_PER_MONTH',
      fixedAmountCents: 10_000,
    });
    const rows = await db.getAllAsync<{ sequence_number: number; amount_cents: number; status: string }>(
      'SELECT sequence_number, amount_cents, status FROM installments WHERE plan_id = ? ORDER BY sequence_number',
      [planId]
    );
    expect(rows[0]).toMatchObject({ sequence_number: 1, amount_cents: 25_000, status: 'PAID' });
    expect(rows[1]).toMatchObject({ sequence_number: 2, amount_cents: 10_000, status: 'PENDING' });
    expect(rows[2].amount_cents).toBe(10_000);
    expect(rows[3].amount_cents).toBe(10_000);
    // âncora = pagas + restante
    const anchor = await db.getFirstAsync<{ amount_cents: number }>(
      'SELECT t.amount_cents FROM installment_plans p JOIN transactions t ON t.id = p.original_transaction_id WHERE p.id = ?',
      [planId]
    );
    expect(anchor?.amount_cents).toBe(55_000);
    // move da parcela 2 acompanhou o valor
    const move2 = await db.getFirstAsync<{ amount_cents: number }>(
      'SELECT amount_cents FROM financial_moves WHERE installment_id = (SELECT id FROM installments WHERE plan_id = ? AND sequence_number = 2)',
      [planId]
    );
    expect(move2?.amount_cents).toBe(10_000);
  });

  test('aumentar o número de parcelas cria sequência nova; diminuir cancela em aberto', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 0);
    const { planId } = await services.installments.createPlan({
      description: 'Plano Y',
      mode: 'FIXED_PER_MONTH',
      fixedAmountCents: 5_000,
      totalInstallments: 3,
      firstDueDate: '2026-01-10',
      accountId: acc,
    });
    await services.installments.updatePlanFields(planId, { totalInstallments: 5 });
    let rows = await db.getAllAsync<{ sequence_number: number; amount_cents: number; due_date: string }>(
      'SELECT sequence_number, amount_cents, due_date FROM installments WHERE plan_id = ? ORDER BY sequence_number',
      [planId]
    );
    expect(rows).toHaveLength(5);
    expect(rows[4]).toMatchObject({ sequence_number: 5, amount_cents: 5_000 });
    expect(rows[4].due_date).toBe('2026-05-10');

    await services.installments.updatePlanFields(planId, { totalInstallments: 4 });
    rows = await db.getAllAsync<{ sequence_number: number; amount_cents: number; due_date: string }>(
      'SELECT sequence_number, amount_cents, due_date FROM installments WHERE plan_id = ? ORDER BY sequence_number',
      [planId]
    );
    expect(rows).toHaveLength(4);
  });

  test('data da 1ª parcela em aberto desloca os vencimentos (move acompanha)', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 0);
    const { planId } = await services.installments.createPlan({
      description: 'Plano Z',
      mode: 'FIXED_PER_MONTH',
      fixedAmountCents: 1_000,
      totalInstallments: 3,
      firstDueDate: '2026-01-10',
      accountId: acc,
    });
    await services.installments.updatePlanFields(planId, { firstPendingDueDate: '2026-03-10' });
    const rows = await db.getAllAsync<{ sequence_number: number; due_date: string }>(
      'SELECT sequence_number, due_date FROM installments WHERE plan_id = ? ORDER BY sequence_number',
      [planId]
    );
    expect(rows[0].due_date).toBe('2026-03-10');
    expect(rows[1].due_date).toBe('2026-04-10');
    expect(rows[2].due_date).toBe('2026-05-10');
    const move = await db.getFirstAsync<{ effective_date: string }>(
      'SELECT effective_date FROM financial_moves WHERE installment_id = (SELECT id FROM installments WHERE plan_id = ? AND sequence_number = 3)',
      [planId]
    );
    expect(move?.effective_date).toBe('2026-05-10');
  });

  test('mudar destino conta → cartão migra as parcelas em aberto para a fatura', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 0);
    const card = await seedCard(db, acc, 'Card', 15, 10);
    const { planId } = await services.installments.createPlan({
      description: 'Plano M',
      mode: 'FIXED_PER_MONTH',
      fixedAmountCents: 2_000,
      totalInstallments: 3,
      firstDueDate: '2026-01-10',
      accountId: acc,
    });
    await services.installments.updatePlanFields(planId, { accountId: null, cardId: card });
    // plano virou de cartão
    const plan = await db.getFirstAsync<{ account_id: string | null; card_id: string | null }>(
      'SELECT account_id, card_id FROM installment_plans WHERE id = ?',
      [planId]
    );
    expect(plan?.account_id).toBeNull();
    expect(plan?.card_id).toBe(card);
    // itens de fatura criados para as 3 parcelas (dias > fechamento 15)
    const itens = await db.getAllAsync('SELECT id FROM invoice_items');
    expect(itens).toHaveLength(3);
    // não há mais moves em conta
    const moves = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM financial_moves WHERE installment_id IS NOT NULL');
    expect(moves?.n).toBe(0);
  });
});

/* ================================================================
 * BUG 3 — DESCRIBÇÃO DA CONTA FIXA PROPAGA
 * ================================================================ */
describe('v21 bug 3 — alterar descrição da fixa propaga para os meses seguintes', () => {
  test('updateRule(description) sincroniza regra + previsões futuras', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 0);
    // regra a partir de 12 meses atrás (datas relativas ao relógio real)
    const start = monthAdd(monthOf(todaySP()), -12);
    const rule = await services.recurrences.createRule({
      description: 'Aluguel velho',
      type: 'EXPENSE',
      amountCents: 1_200_00,
      dayOfMonth: 5,
      startDate: `${start}-05`,
      accountId: acc,
    });
    await services.recurrences.runDueRecurrences();
    await services.recurrences.runForecast(6);

    await services.recurrences.updateRule(rule.id, { description: 'Aluguel novo' });

    // a regra mudou
    const r = await db.getFirstAsync<{ description: string }>('SELECT description FROM recurrence_rules WHERE id = ?', [rule.id]);
    expect(r?.description).toBe('Aluguel novo');
    // as previsões (PENDING) dos meses seguintes mostram a descrição nova
    const pendentes = await db.getAllAsync<{ description: string }>(
      "SELECT description FROM transactions WHERE recurrence_rule_id = ? AND status = 'PENDING'",
      [rule.id]
    );
    expect(pendentes.length).toBeGreaterThanOrEqual(1);
    for (const p of pendentes) expect(p.description).toBe('Aluguel novo');
  });
});
