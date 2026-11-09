import { makeCtx, seedAccount } from './helpers';
import { todaySP } from '../lib/dates';

describe('v73 — status em lote', () => {
  test('altera lançamentos e movimentos de várias transações juntos', async () => {
    const { db, services } = await makeCtx();
    const accountId = await seedAccount(db, 'Conta status em lote', 0);
    const first = await services.transactions.createAccountExpense({
      description: 'Primeira despesa',
      amountCents: 1200,
      accountId,
    });
    const second = await services.transactions.createAccountExpense({
      description: 'Segunda despesa',
      amountCents: 2400,
      accountId,
    });

    await services.transactions.setPaymentStatuses([first.id, first.id, second.id], false);
    expect(await db.getAllAsync<{ id: string; status: string }>(
      'SELECT id, status FROM transactions WHERE id IN (?, ?) ORDER BY id',
      [first.id, second.id]
    )).toEqual([
      { id: first.id, status: 'PENDING' },
      { id: second.id, status: 'PENDING' },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(await db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM financial_moves WHERE transaction_id IN (?, ?) AND status = 'VOIDED'",
      [first.id, second.id]
    )).toEqual({ n: 2 });

    await services.transactions.setPaymentStatuses([first.id, second.id], true);
    expect(await db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM financial_moves WHERE transaction_id IN (?, ?) AND status = 'CONFIRMED'",
      [first.id, second.id]
    )).toEqual({ n: 2 });
  });

  test('atualiza parcelas em lote e mantém a data de vencimento ao reabrir', async () => {
    const { db, services } = await makeCtx();
    const accountId = await seedAccount(db, 'Conta parcelas em lote', 0);
    const plan = await services.installments.createPlan({
      description: 'Plano parcelado',
      mode: 'DIVIDE_TOTAL',
      totalCents: 10000,
      totalInstallments: 2,
      firstDueDate: '2099-01-15',
      accountId,
    });
    const rows = await db.getAllAsync<{ id: string; due_date: string }>(
      'SELECT id, due_date FROM installments WHERE plan_id = ? ORDER BY sequence_number',
      [plan.planId]
    );

    await services.installments.setPaymentStatuses(rows.map((row) => row.id), true);
    expect(await db.getAllAsync<{ effective_date: string }>(
      'SELECT effective_date FROM financial_moves WHERE installment_id IN (?, ?) ORDER BY effective_date',
      rows.map((row) => row.id)
    )).toEqual([{ effective_date: todaySP() }, { effective_date: todaySP() }]);

    await services.installments.setPaymentStatuses(rows.map((row) => row.id), false);
    expect(await db.getAllAsync<{ effective_date: string }>(
      'SELECT effective_date FROM financial_moves WHERE installment_id IN (?, ?) ORDER BY effective_date',
      rows.map((row) => row.id)
    )).toEqual(rows.map((row) => ({ effective_date: row.due_date })));
  });
});
