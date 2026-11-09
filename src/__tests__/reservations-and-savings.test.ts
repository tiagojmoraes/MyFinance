import { makeCtx, seedAccount } from './helpers';
import { WishlistService } from '../services/WishlistService';

describe('Reservas e poupança', () => {
  test('editar e excluir reserva atualiza item, destino e movimentos', async () => {
    const { db, services } = await makeCtx();
    const origem = await seedAccount(db, 'Reserva origem');
    const destinoAntigo = await seedAccount(db, 'Reserva antiga');
    const destinoNovo = await seedAccount(db, 'Reserva nova');
    await db.runAsync("UPDATE accounts SET type = 'SAVINGS' WHERE id = ?", [destinoNovo]);

    const wishlist = new WishlistService(db, services.transactions, services.balance);
    const itemId = await wishlist.addItem({
      classificacao: 'PRIORIDADE',
      description: 'Reserva alterável',
      targetCents: 1000,
    });
    const reserve = await wishlist.reserve({
      itemId,
      amountCents: 400,
      fromAccountId: origem,
      destination: { kind: 'POUPANCA', accountId: destinoAntigo },
    });

    await services.transactions.updateSimple(reserve.transactionId, {
      amountCents: 600,
      date: '2026-03-20',
      accountId: origem,
      toAccountId: destinoNovo,
    });

    const reserveRow = await db.getFirstAsync<{
      to_account_id: string;
      amount_cents: number;
      is_poupanca: number;
    }>('SELECT to_account_id, amount_cents, is_poupanca FROM wishlist_reserves WHERE transaction_id = ?', [reserve.transactionId]);
    expect(reserveRow).toEqual({ to_account_id: destinoNovo, amount_cents: 600, is_poupanca: 1 });
    expect((await wishlist.getById(itemId))?.reserved_cents).toBe(600);
    expect(await db.getAllAsync(
      'SELECT account_id, amount_cents, effective_date FROM financial_moves WHERE transaction_id = ? ORDER BY direction',
      [reserve.transactionId]
    )).toEqual([
      { account_id: destinoNovo, amount_cents: 600, effective_date: '2026-03-20' },
      { account_id: origem, amount_cents: 600, effective_date: '2026-03-20' },
    ]);

    await services.transactions.deleteTransaction(reserve.transactionId);
    expect((await wishlist.getById(itemId))?.reserved_cents).toBe(0);
    expect(await db.getFirstAsync('SELECT id FROM wishlist_reserves WHERE transaction_id = ?', [reserve.transactionId])).toBeNull();
  });

  test('excluir previsão mensal preserva tombstone sem recriar a transação', async () => {
    const { db, services } = await makeCtx();
    const origem = await seedAccount(db, 'Poupança origem');
    const destino = await seedAccount(db, 'Poupança destino');
    await services.savings.createMonthlyPlan({
      amountCents: 50_000,
      dayOfMonth: 28,
      fromAccountId: origem,
      toAccountId: destino,
    });
    const entry = await db.getFirstAsync<{ month: string; transaction_id: string }>(
      `SELECT se.month, se.transaction_id
         FROM savings_entries se
        WHERE se.kind = 'MONTHLY' ORDER BY se.month LIMIT 1`
    );
    expect(entry?.transaction_id).toBeTruthy();

    await services.transactions.deleteTransaction(entry!.transaction_id);
    expect(await db.getFirstAsync(
      'SELECT id FROM transactions WHERE id = ?',
      [entry!.transaction_id]
    )).toBeNull();
    expect(await db.getFirstAsync(
      "SELECT transaction_id FROM savings_entries WHERE month = ? AND kind = 'MONTHLY'",
      [entry!.month]
    )).toEqual({ transaction_id: null });
    expect((await services.savings.getMonthOverview(entry!.month)).entries).toHaveLength(0);

    await services.savings.generateForecast();
    expect(await db.getFirstAsync(
      "SELECT transaction_id FROM savings_entries WHERE month = ? AND kind = 'MONTHLY'",
      [entry!.month]
    )).toEqual({ transaction_id: null });
  });

  test('saldo programado da Poupança diminui quando a modalidade mensal é efetivada', async () => {
    const { db, services } = await makeCtx();
    const origem = await seedAccount(db, 'Saldo mensal origem', 200_000);
    const destino = await seedAccount(db, 'Saldo mensal destino');
    await db.runAsync('UPDATE accounts SET include_in_general_balance = 0 WHERE id = ?', [destino]);
    await services.savings.createMonthlyPlan({
      amountCents: 50_000,
      dayOfMonth: 28,
      fromAccountId: origem,
      toAccountId: destino,
    });
    const entry = await db.getFirstAsync<{ month: string; transaction_id: string }>(
      "SELECT month, transaction_id FROM savings_entries WHERE kind = 'MONTHLY' ORDER BY month LIMIT 1"
    );

    const before = await services.savings.getMonthOverview(entry!.month);
    expect(before.programadoCents).toBe(150_000);

    await db.runAsync("UPDATE financial_moves SET status = 'CONFIRMED' WHERE transaction_id = ?", [entry!.transaction_id]);
    await db.runAsync("UPDATE transactions SET status = 'CONFIRMED' WHERE id = ?", [entry!.transaction_id]);
    const after = await services.savings.getMonthOverview(entry!.month);
    expect(after.programadoCents).toBe(100_000);
    expect(after.effectedCents).toBe(50_000);
    expect(after.remainingCents).toBe(50_000);
  });
});
