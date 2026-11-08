/**
 * Testes v22 — lote de bugs/melhorias do usuário:
 *  · BUG 1: "+Incluir" do consolidado — addAvistaLinesToGroup cria filhos
 *    reais (parent_transaction_id) com movimento na conta e soma o total.
 *  · BUG 2: data da 1ª parcela em aberto é a ÂNCORA da cadência — mudança de
 *    DIA no mesmo mês funciona (antes era ignorada) e, no CARTÃO, o item da
 *    fatura acompanha o novo vencimento (sai da fatura antiga, nasce na nova).
 */

import { makeCtx, seedAccount, seedCard } from './helpers';

let ctx: ReturnType<typeof makeCtx> extends Promise<infer T> ? T : never;

beforeEach(async () => {
  ctx = await makeCtx();
});

/* ================================================================
 * BUG 2 — DATA DO PARCELADO REPOSICIONA OS VENCIMENTOS
 * ================================================================ */
describe('v22 bug 2 — vencimento da 1ª parcela em aberto (âncora por data)', () => {
  test('mudar o DIA no mesmo mês reposiciona todas as em aberto (conta)', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 0);
    const { planId } = await services.installments.createPlan({
      description: 'Plano Dia',
      mode: 'FIXED_PER_MONTH',
      fixedAmountCents: 1_000,
      totalInstallments: 3,
      firstDueDate: '2026-02-10',
      accountId: acc,
    });
    // ANTES (v21): delta em meses = 0 → nada mudava. AGORA: dia é respeitado.
    await services.installments.updatePlanFields(planId, { firstPendingDueDate: '2026-02-25' });
    const rows = await db.getAllAsync<{ sequence_number: number; due_date: string }>(
      'SELECT sequence_number, due_date FROM installments WHERE plan_id = ? ORDER BY sequence_number',
      [planId]
    );
    expect(rows[0].due_date).toBe('2026-02-25');
    expect(rows[1].due_date).toBe('2026-03-25');
    expect(rows[2].due_date).toBe('2026-04-25');
    // movimento da conta acompanhou
    const move = await db.getFirstAsync<{ effective_date: string }>(
      'SELECT effective_date FROM financial_moves WHERE installment_id = (SELECT id FROM installments WHERE plan_id = ? AND sequence_number = 1)',
      [planId]
    );
    expect(move?.effective_date).toBe('2026-02-25');
  });

  test('em CARTÃO o item de fatura acompanha o novo vencimento (sai da fatura antiga)', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 0);
    const card = await seedCard(db, acc, 'Card', 15, 10);
    const { planId } = await services.installments.createPlan({
      description: 'Plano Cartão',
      mode: 'FIXED_PER_MONTH',
      fixedAmountCents: 2_000,
      totalInstallments: 3,
      firstDueDate: '2026-01-10',
      cardId: card,
    });
    // venc. 10/01 (<= fechamento 15) → fatura 2026-01
    const antes = await services.invoices.getInvoiceDetailByCardMonth(card, '2026-01');
    expect(antes!.items.some((i) => i.installment_id != null)).toBe(true);

    // muda o dia dentro do mesmo mês: 10/01 → 20/01 (> fechamento) → fatura 2026-02
    await services.installments.updatePlanFields(planId, { firstPendingDueDate: '2026-01-20' });
    const rows = await db.getAllAsync<{ sequence_number: number; due_date: string }>(
      'SELECT sequence_number, due_date FROM installments WHERE plan_id = ? ORDER BY sequence_number',
      [planId]
    );
    expect(rows[0].due_date).toBe('2026-01-20');
    expect(rows[1].due_date).toBe('2026-02-20');
    expect(rows[2].due_date).toBe('2026-03-20');

    const faturaJan = await services.invoices.getInvoiceDetailByCardMonth(card, '2026-01');
    expect(faturaJan!.items.some((i) => i.installment_id != null)).toBe(false);
    const faturaFev = await services.invoices.getInvoiceDetailByCardMonth(card, '2026-02');
    const itens = faturaFev!.items.filter((i) => i.installment_id != null);
    expect(itens.length).toBe(1); // apenas a 1ª parcela movida para cá
  });
});

/* ================================================================
 * BUG 1 — INCLUIR LINHAS NO GRUPO CONSOLIDADO EXISTENTE
 * ================================================================ */
describe('v22 bug 1 — addAvistaLinesToGroup inclui linhas no grupo', () => {
  test('filhos criados com parent_transaction_id, movimento na conta e total somado', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 0);
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Feira + farmácia',
      date: '2026-03-10',
      categoryId: null,
      accountId: acc,
      lines: [{ direction: 'DEBIT', description: 'Feira', amountCents: 100_00, categoryId: null }],
      headerAmountCents: 100_00,
      headerType: 'EXPENSE',
    });
    expect(grupo).toBeTruthy();

    await services.transactions.addAvistaLinesToGroup(grupo!.id, {
      date: '2026-03-12',
      accountId: acc,
      lines: [
        { direction: 'DEBIT', description: 'Farmácia', amountCents: 200_00, categoryId: null },
        { direction: 'CREDIT', description: 'Troco do vizinho', amountCents: 50_00, categoryId: null },
      ],
    });

    const filhos = await db.getAllAsync<{ description: string; amount_cents: number; parent_transaction_id: string }>(
      'SELECT description, amount_cents, parent_transaction_id FROM transactions WHERE parent_transaction_id = ? ORDER BY occurred_on, description',
      [grupo!.id]
    );
    expect(filhos).toHaveLength(3);
    expect(filhos[0]).toMatchObject({ description: 'Feira', amount_cents: 100_00 });
    expect(filhos[1]).toMatchObject({ description: 'Farmácia', amount_cents: 200_00 });
    expect(filhos[2]).toMatchObject({ description: 'Troco do vizinho', amount_cents: 50_00 });

    // cabeçalho soma as linhas novas (100 + 200 + 50)
    const header = await db.getFirstAsync<{ amount_cents: number }>('SELECT amount_cents FROM transactions WHERE id = ?', [grupo!.id]);
    expect(header?.amount_cents).toBe(350_00);

    // movimento novo na conta, na data da linha
    const move = await db.getFirstAsync<{ effective_date: string; direction: string }>(
      'SELECT effective_date, direction FROM financial_moves WHERE transaction_id = (SELECT id FROM transactions WHERE description = ?)',
      ['Farmácia']
    );
    expect(move).toMatchObject({ effective_date: '2026-03-12', direction: 'DEBIT' });
  });
});
