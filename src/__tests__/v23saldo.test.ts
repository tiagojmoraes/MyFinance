/** v23 — BUG "Saldo previsto do dia = saldo geral":
 *  à vista criado para data futura (move VOIDED) e DEPOIS EDITADO — a lista
 *  mostra a data nova, mas o movimento VOIDED fica na data antiga e a promoção
 *  o confirma lá. O saldo do dia antigo passa a considerar o valor. */
import { makeCtx, seedAccount } from './helpers';
import { buildServices } from '../services';
import type { DbDriver } from '../db/types';

let db: DbDriver;
let services: ReturnType<typeof buildServices>;

beforeEach(async () => {
  const ctx = await makeCtx();
  db = ctx.db;
  services = ctx.services;
});

describe('v23 bug saldo do dia previsto (à vista editado)', () => {
  test('à vista 10k: nasce 02/12, editado p/ 03/12 — saldo do dia 02/12 NÃO considera', async () => {
    const acc = await seedAccount(db, 'Itau', 100000);
    // 02/12 é futuro em relação ao hoje real (2026-11-03) → PENDING + move VOIDED em 02/12
    const tx = await services.transactions.createAccountExpense({
      description: 'Compra 10k', amountCents: 1000000, date: '2026-12-02', accountId: acc,
    });
    expect(tx.status).toBe('PENDING');
    // usuário EDITA a data para 03/12 (tela Alterar)
    await services.transactions.updateSimple(tx.id, { date: '2026-12-03' });
    // a lista mostra 03/12...
    const flow = await services.transactions.listFlow('2026-12');
    const shown = flow.find((t) => t.id === tx.id);
    expect(shown?.occurred_on).toBe('2026-12-03');
    // ...e a promoção roda (abertura do Fluxo em 04/12)
    await services.transactions.promoteDuePendings('2026-12-04');
    // move deve ter sido confirmada NA DATA NOVA (03/12), não na antiga
    const move = await db.getFirstAsync<{ effective_date: string; status: string }>(
      'SELECT effective_date, status FROM financial_moves WHERE transaction_id = ?',
      [tx.id]
    );
    console.log('MOVE após promoção:', move);
    expect(move?.status).toBe('CONFIRMED');
    expect(move?.effective_date).toBe('2026-12-03');
    const dual = await services.balance.getDailyBalancesDual('2026-12');
    console.log('prev[02]=', dual.previsto['2026-12-02'], 'prev[03]=', dual.previsto['2026-12-03']);
    // saldo do dia 02/12 = 1.000,00 (SEM o 10k); dia 03/12 = -9.000,00
    expect(dual.previsto['2026-12-02']).toBe(100000);
    expect(dual.previsto['2026-12-03']).toBe(-900000);
    expect(dual.efetivado['2026-12-02']).toBe(100000);
  });

  test('valor também editado: move VOIDED deve acompanhar valor e data novos', async () => {
    const acc = await seedAccount(db, 'Itau', 100000);
    const tx = await services.transactions.createAccountExpense({
      description: 'Compra', amountCents: 500000, date: '2026-12-02', accountId: acc,
    });
    await services.transactions.updateSimple(tx.id, { amountCents: 1000000, date: '2026-12-03' });
    await services.transactions.promoteDuePendings('2026-12-04');
    const move = await db.getFirstAsync<{ effective_date: string; amount_cents: number }>(
      'SELECT effective_date, amount_cents FROM financial_moves WHERE transaction_id = ?',
      [tx.id]
    );
    console.log('MOVE valor/data:', move);
    expect(move?.amount_cents).toBe(1000000);
    expect(move?.effective_date).toBe('2026-12-03');
  });

  test('DADO JÁ CORROMPIDO (v20/v22): move confirmada na data antiga é realinhada ao abrir o app', async () => {
    const acc = await seedAccount(db, 'Itau', 100000);
    // à vista 02/12 (VOIDED) — simula o estado pós-bug: tx editada p/ 03/12,
    // move VOIDED confirma na data ANTIGA (comportamento antigo do updateSimple)
    const tx = await services.transactions.createAccountExpense({
      description: 'Compra 10k', amountCents: 1000000, date: '2026-12-02', accountId: acc,
    });
    await db.runAsync('UPDATE transactions SET occurred_on = ? WHERE id = ?', ['2026-12-03', tx.id]);
    await db.runAsync("UPDATE financial_moves SET status = 'CONFIRMED' WHERE transaction_id = ?", [tx.id]);
    await db.runAsync("UPDATE transactions SET status = 'CONFIRMED' WHERE id = ?", [tx.id]);
    // saldo antes: dia 02/12 considera o 10k (errado)
    const antes = await services.balance.getDailyBalancesDual('2026-12');
    expect(antes.previsto['2026-12-02']).toBe(-900000);
    // abrir o app/Fluxo roda promoteDuePendings → normalização realinha a move
    await services.transactions.promoteDuePendings('2026-12-04');
    const move = await db.getFirstAsync<{ effective_date: string }>(
      'SELECT effective_date FROM financial_moves WHERE transaction_id = ?',
      [tx.id]
    );
    expect(move?.effective_date).toBe('2026-12-03');
    const depois = await services.balance.getDailyBalancesDual('2026-12');
    console.log('DEPOIS da normalização: prev[02]=', depois.previsto['2026-12-02'], 'prev[03]=', depois.previsto['2026-12-03']);
    expect(depois.previsto['2026-12-02']).toBe(100000);
    expect(depois.previsto['2026-12-03']).toBe(-900000);
  });

  test('normalização NÃO mexe em parcela (data própria = vencimento) nem em pagamento de fatura', async () => {
    const acc = await seedAccount(db, 'Itau', 100000);
    await services.installments.createPlan({
      description: 'Notebook', mode: 'FIXED_PER_MONTH', fixedAmountCents: 10000, totalInstallments: 3,
      firstDueDate: '2026-12-10', accountId: acc, cardId: null, type: 'EXPENSE',
    } as never);
    // parcela: move tem installment_id e effective_date = vencimento (≠ occurred_on do evento)
    const move = await db.getFirstAsync<{ effective_date: string; installment_id: string }>(
      `SELECT fm.effective_date, fm.installment_id FROM financial_moves fm
        JOIN installments i ON i.id = fm.installment_id LIMIT 1`
    );
    expect(move?.installment_id).toBeTruthy();
    await services.transactions.promoteDuePendings('2026-12-04');
    const move2 = await db.getFirstAsync<{ effective_date: string }>(
      'SELECT effective_date FROM financial_moves WHERE installment_id = ?',
      [move?.installment_id ?? '']
    );
    // vencimento intacto (não virou occurred_on do evento/purchase)
    expect(move2?.effective_date).toBe(move?.effective_date ?? 'x');
  });
});
