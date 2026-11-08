/** Fase 1/2 — Saldos, transações manuais, transferência atômica e void. */

import { makeCtx, seedAccount, seedCard, getAccountBalance, expectRejects } from './helpers';
import { todaySP, addDays } from '../lib/dates';

describe('BalanceService', () => {
  test('saldo = inicial + créditos - débitos (fórmula da spec)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Banco', 10000);
    await services.transactions.createAccountExpense({ description: 'Mercado', amountCents: 2500, accountId: acc });
    await services.transactions.createAccountIncome({ description: 'Freelance', amountCents: 50000, accountId: acc });
    const bal = await services.balance.getAccountBalance(acc);
    expect(bal).toBe(10000 - 2500 + 50000);
  });

  test('à vista FUTURO é previsão: não entra no efetivado até a promoção (v21, bug 2)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Banco', 0);
    await services.transactions.createAccountExpense({ description: 'Hoje', amountCents: 100, accountId: acc });
    const future = addDays(todaySP(), 10);
    // Débito agendado para o futuro: nasce PENDING (movimento VOIDED) —
    // não efetiva sozinho, nem hoje, nem em consultas as-of a data futura
    await services.transactions.createAccountExpense({ description: 'Agendado', amountCents: 999, accountId: acc, date: future });
    const bal = await services.balance.getAccountBalance(acc);
    expect(bal).toBe(-100);
    const asOfFuture = await services.balance.getAccountBalance(acc, addDays(future, 1));
    expect(asOfFuture).toBe(-100);
    // Promoção automática no dia do vencimento: vira CONFIRMED e entra no saldo
    const promoted = await services.transactions.promoteDuePendings(addDays(future, 1));
    expect(promoted).toBe(1);
    expect(await services.balance.getAccountBalance(acc, addDays(future, 1))).toBe(-1099);
  });

  test('exclusão FÍSICA remove o lançamento do saldo (v10 — sem marca "Cancelado")', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Banco', 1000);
    const tx = await services.transactions.createAccountExpense({ description: 'Compra', amountCents: 400, accountId: acc });
    expect(await services.balance.getAccountBalance(acc)).toBe(600);
    await services.transactions.deleteTransaction(tx.id);
    // O registro sai DE VEZ do banco: sem linha, sem movimento, saldo restaurado
    const row = await services.db.getFirstAsync('SELECT id FROM transactions WHERE id = ?', [tx.id]);
    expect(row).toBeNull();
    const moves = await services.db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM financial_moves WHERE transaction_id = ?', [tx.id]);
    expect(moves?.c).toBe(0);
    expect(await services.balance.getAccountBalance(acc)).toBe(1000);
  });

  test('saldo geral soma apenas contas incluídas', async () => {
    const { services } = await makeCtx();
    const a1 = await seedAccount(services.db, 'Incluída', 5000);
    const a2 = await seedAccount(services.db, 'Excluída', 99999);
    await services.db.runAsync('UPDATE accounts SET include_in_general_balance = 0 WHERE id = ?', [a2]);
    await services.transactions.createAccountExpense({ description: 'gasto', amountCents: 1000, accountId: a1 });
    const general = await services.balance.getGeneralBalance();
    expect(general).toBe(4000);
  });

  test('lista de saldos por conta', async () => {
    const { services } = await makeCtx();
    await seedAccount(services.db, 'A', 100);
    await seedAccount(services.db, 'B', 200);
    const list = await services.balance.listAccountBalances();
    expect(list).toHaveLength(2);
    const total = list.reduce((acc, cur) => acc + cur.balanceCents, 0);
    expect(total).toBe(300);
  });
});

describe('TransactionService', () => {
  test('transferência atômica: 1 transação + 2 moves', async () => {
    const { services } = await makeCtx();
    const from = await seedAccount(services.db, 'Origem', 10000);
    const to = await seedAccount(services.db, 'Destino', 0);
    await services.transactions.createTransfer({
      description: 'Guardando', amountCents: 3000, fromAccountId: from, toAccountId: to,
    });
    expect(await getAccountBalance(services.db, from)).toBe(7000);
    expect(await getAccountBalance(services.db, to)).toBe(3000);
    const tx = await services.db.getFirstAsync<{ type: string; transfer_account_id: string }>(
      "SELECT type, transfer_account_id FROM transactions WHERE type = 'TRANSFER'"
    );
    expect(tx?.type).toBe('TRANSFER');
    expect(tx?.transfer_account_id).toBe(to);
    const moveCount = await services.db.getFirstAsync<{ c: number }>(
      "SELECT COUNT(*) AS c FROM financial_moves WHERE transaction_id IN (SELECT id FROM transactions WHERE type='TRANSFER')"
    );
    expect(moveCount?.c).toBe(2);
  });

  test('transferência para a mesma conta é rejeitada', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Unica', 100);
    await expect(
      services.transactions.createTransfer({ description: 'x', amountCents: 10, fromAccountId: acc, toAccountId: acc })
    ).rejects.toThrow();
  });

  test('exclusão da transferência desfaz os dois lados (v10 — física)', async () => {
    const { services } = await makeCtx();
    const from = await seedAccount(services.db, 'Origem', 10000);
    const to = await seedAccount(services.db, 'Destino', 0);
    const tx = await services.transactions.createTransfer({
      description: 'Pix', amountCents: 1000, fromAccountId: from, toAccountId: to,
    });
    await services.transactions.deleteTransaction(tx.id);
    const row = await services.db.getFirstAsync('SELECT id FROM transactions WHERE id = ?', [tx.id]);
    expect(row).toBeNull();
    expect(await getAccountBalance(services.db, from)).toBe(10000);
    expect(await getAccountBalance(services.db, to)).toBe(0);
  });

  test('compra no cartão NÃO gera move imediato (ARQ-002)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Conta', 5000);
    const card = await seedCard(services.db, acc);
    await services.transactions.createCardExpense({
      description: 'Netflix', amountCents: 5590, cardId: card, date: '2026-05-10',
    });
    expect(await getAccountBalance(services.db, acc)).toBe(5000); // intocado
    const item = await services.db.getFirstAsync<{ amount_cents: number }>(
      'SELECT amount_cents FROM invoice_items'
    );
    expect(item?.amount_cents).toBe(5590);
  });

  test('compra em conta gera move DEBIT imediato', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Conta', 5000);
    const tx = await services.transactions.createAccountExpense({ description: 'Pão', amountCents: 1250, accountId: acc });
    const move = await services.db.getFirstAsync<{ direction: string }>(
      'SELECT direction FROM financial_moves WHERE transaction_id = ?',
      [tx.id]
    );
    expect(move?.direction).toBe('DEBIT');
  });
});
