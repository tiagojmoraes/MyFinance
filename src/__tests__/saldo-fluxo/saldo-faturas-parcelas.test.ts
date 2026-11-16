/**
 * v87 — SALDO POR DIA: faturas do mesmo dia SOMAM e parcela em aberto é
 * previsão (não abaixa o saldo efetivado da conta).
 *
 *  · Faturas de DOIS cartões vencendo no MESMO dia: o previsto do dia tem que
 *    descontar as DUAS (antes usava MAX escalar → uma linha arbitrária).
 *  · Parcela em ABERTO (PENDING) de plano em conta: o saldo da conta NÃO
 *    abaixa (o dinheiro não saiu) — igual ao "efetivado" do Fluxo.
 */

import { makeCtx, seedAccount, seedCard } from '../helpers';
import { todaySP, monthOf, dayInMonth } from '../../lib/dates';

let ctx: ReturnType<typeof makeCtx> extends Promise<infer T> ? T : never;

beforeEach(async () => {
  ctx = await makeCtx();
});

describe('v87 — faturas do mesmo dia somam no previsto', () => {
  test('dois cartões com vencimento no mesmo dia → o previsto desconta os DOIS', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 0);
    // fechamento 15, vencimento 20 (depois do fechamento → vence no mesmo mês)
    const cardA = await seedCard(db, acc, 'A', 15, 20);
    const cardB = await seedCard(db, acc, 'B', 15, 20);
    const mes = monthOf(todaySP());

    // compra no cartão A e no B (ambos entram na fatura do mês)
    await services.transactions.createCardExpense({
      description: 'Compra A', amountCents: 30_000, cardId: cardA, date: `${mes}-02`,
    });
    await services.transactions.createCardExpense({
      description: 'Compra B', amountCents: 20_000, cardId: cardB, date: `${mes}-02`,
    });

    // as DUAS faturas vencem no mesmo dia (fechamento 15, vencimento 20)
    const venc = await db.getAllAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM invoices WHERE due_date = ?',
      [dayInMonth(mes, 20)]
    );
    expect(venc[0]?.n).toBe(2);

    const dual = await services.balance.getDailyBalancesDual(mes);
    // o previsto do dia do vencimento tem que estar 50.000 abaixo do efetivado
    const efetivado = dual.efetivado[dayInMonth(mes, 20)] ?? 0;
    const previsto = dual.previsto[dayInMonth(mes, 20)] ?? 0;
    expect(efetivado - previsto).toBe(50_000);
  });
});

describe('v87 — parcela em aberto não abaixa o saldo da conta', () => {
  test('saldo da conta ignora parcela PENDING (é previsão) e inclui quando paga', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 100_000);
    const { planId } = await services.installments.createPlan({
      description: 'Parcelado',
      mode: 'FIXED_PER_MONTH',
      fixedAmountCents: 10_000,
      totalInstallments: 2,
      firstDueDate: `${monthOf(todaySP())}-05`,
      accountId: acc,
    });
    // parcela em aberto: o saldo NÃO abaixa (o dinheiro não saiu)
    expect(await services.balance.getAccountBalance(acc)).toBe(100_000);
    // o previsto do Fluxo (por dia) também não mexe no efetivado
    const dual = await services.balance.getDailyBalancesDual(monthOf(todaySP()));
    const dia = `${monthOf(todaySP())}-05`;
    expect((dual.efetivado[dia] ?? 0) - (dual.previsto[dia] ?? 0)).toBe(10_000);

    // ao PAGAR a parcela, o saldo passa a contar
    const inst = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM installments WHERE plan_id = ? AND sequence_number = 1',
      [planId]
    );
    await services.installments.setPaymentStatus(inst!.id, true);
    expect(await services.balance.getAccountBalance(acc)).toBe(90_000);
  });
});
