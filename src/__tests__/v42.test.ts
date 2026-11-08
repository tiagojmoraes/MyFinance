/**
 * v42 — ORÇAMENTOS + POUPANÇA (testes da versão).
 *
 * ORÇAMENTO (BudgetService):
 *  · "gastou" do mês = à vista em conta (CONFIRMED + previsão PENDING)
 *    + compras no cartão + parcelas do mês (âncora do plano NÃO conta em
 *    dobro) — e despesas de OUTRA categoria não vazam;
 *  · total do cabeçalho = soma orçado/gasto/falta;
 *  · save na mesma categoria atualiza (um orçamento por categoria).
 *
 * POUPANÇA (SavingsService):
 *  · plano MENSAL gera previsões futuras (TRANSFER PENDING) idempotentes;
 *  · overview do mês: previsto / falta / efetivado;
 *  · CLOSING: saldo previsto positivo do fim do mês vira estimativa;
 *    confirmação cria transferência no último dia; repetir falha;
 *  · sem plano CLOSING ativo ou saldo ≤ 0 → sem sugestão.
 */

import { makeCtx, seedAccount, seedCard, expectRejects } from './helpers';
import { todaySP, monthOf, dayInMonth, lastDayNumberOf, monthAdd } from '../lib/dates';

describe('v42 — Orçamentos (BudgetService)', () => {
  test('gasto do mês = à vista + previsão + cartão + parcela; âncora não conta em dobro', async () => {
    const { db, services } = await makeCtx();
    const accA = await seedAccount(db, 'Conta A');
    const card = await seedCard(db, accA, 'Cartão A');

    const today = todaySP();
    const month = monthOf(today);
    const lastDay = dayInMonth(month, lastDayNumberOf(month));

    // Orçamentos: Mercado 500,00 · Compras 300,00
    await services.budgets.save('cat-mercado', 50_000);
    await services.budgets.save('cat-compras', 30_000);

    // 1) à vista em conta (CONFIRMED): 120,00
    await services.transactions.createAccountExpense({
      description: 'Feira',
      amountCents: 12_000,
      accountId: accA,
      categoryId: 'cat-mercado',
      date: today,
    });
    // 2) previsão futura (PENDING): 80,00 — compromete o orçamento também
    await services.transactions.createAccountExpense({
      description: 'Sábado mercado',
      amountCents: 8_000,
      accountId: accA,
      categoryId: 'cat-mercado',
      date: lastDay,
    });
    // 3) compra no cartão: 50,00
    await services.transactions.createCardExpense({
      description: 'Mercado no cartão',
      amountCents: 5_000,
      cardId: card,
      categoryId: 'cat-mercado',
      occurredAt: `${today}T12:00:00.000Z`,
    });
    // 4) parcela EM CONTA de plano com âncora em cat-compras: 100,00 no mês
    //    (âncora de 1.200,00 NÃO pode entrar na soma — contaria em dobro)
    await db.runAsync(
      `INSERT INTO transactions (id, kind, type, amount_cents, occurred_on, occurred_at, description, category_id, account_id, source_system, status)
       VALUES ('tx-anc-v42', 'SIMPLE', 'EXPENSE', 120000, ?, ?, 'Notebook parcelado', 'cat-compras', ?, 'MANUAL', 'CONFIRMED')`,
      [today, `${today}T12:00:00.000Z`, accA]
    );
    await db.runAsync(
      `INSERT INTO installment_plans (id, original_transaction_id, total_installments, mode, total_cents, first_due_date, account_id)
       VALUES ('plan-v42', 'tx-anc-v42', 12, 'DIVIDE_TOTAL', 120000, ?, ?)`,
      [lastDay, accA]
    );
    await db.runAsync(
      `INSERT INTO installments (id, plan_id, sequence_number, amount_cents, due_date, status)
       VALUES ('inst-v42-1', 'plan-v42', 1, 10000, ?, 'PENDING')`,
      [lastDay]
    );

    // 5) despesa de OUTRA categoria — não pode vazar
    await services.transactions.createAccountExpense({
      description: 'Uber',
      amountCents: 9_999,
      accountId: accA,
      categoryId: 'cat-transporte',
      date: today,
    });

    const sum = await services.budgets.getMonthSummary(month);
    const mercado = sum.items.find((i) => i.categoryId === 'cat-mercado');
    const compras = sum.items.find((i) => i.categoryId === 'cat-compras');

    expect(mercado?.spentCents).toBe(25_000); // 120 + 80 + 50
    expect(mercado?.remainingCents).toBe(25_000); // 500 − 250
    expect(mercado?.pct).toBe(50);
    expect(compras?.spentCents).toBe(10_000); // só a parcela (âncora fora)
    expect(compras?.remainingCents).toBe(20_000);
    expect(sum.budgetedCents).toBe(80_000);
    expect(sum.spentCents).toBe(35_000);
    expect(sum.remainingCents).toBe(45_000);
  });

  test('save na mesma categoria ATUALIZA (um orçamento por categoria) e desativar sai do resumo', async () => {
    const { services } = await makeCtx();
    await services.budgets.save('cat-lazer', 20_000);
    await services.budgets.save('cat-lazer', 35_000); // atualiza
    let rows = await services.budgets.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe(35_000);

    const sum = await services.budgets.getMonthSummary(monthOf(todaySP()));
    expect(sum.items).toHaveLength(1);

    await services.budgets.setActive(rows[0].id, false);
    const sum2 = await services.budgets.getMonthSummary(monthOf(todaySP()));
    expect(sum2.items).toHaveLength(0);
    expect(sum2.remainingCents).toBe(0);

    // excluir
    await services.budgets.remove(rows[0].id);
    rows = await services.budgets.list();
    expect(rows).toHaveLength(0);
  });
});

describe('v42 — Poupança (SavingsService)', () => {
  test('plano MENSAL gera previsões futuras (TRANSFER PENDING), idempotente; overview do mês', async () => {
    const { db, services } = await makeCtx();
    const accA = await seedAccount(db, 'Origem');
    const accB = await seedAccount(db, 'Destino');

    const today = todaySP();
    const curMonth = monthOf(today);
    const dayOfToday = parseInt(today.slice(8, 10), 10);
    // Dia 28 do mês corrente quando ainda não venceu; senão dia 1 do mês seguinte —
    // garante que a entry analisada é sempre uma PREVISÃO FUTURA (PENDING).
    const useDay28 = dayOfToday <= 27;
    const day = useDay28 ? 28 : 1;
    const targetMonth = useDay28 ? curMonth : monthAdd(curMonth, 1);

    await services.savings.createMonthlyPlan({
      amountCents: 30_000,
      dayOfMonth: day,
      fromAccountId: accA,
      toAccountId: accB,
    });

    // Previsões: do mês alvo até +24 meses (>= 24 ocorrências)
    const count = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM savings_entries se
         JOIN savings_plans sp ON sp.id = se.plan_id
        WHERE sp.mode = 'MONTHLY' AND se.month >= ?`,
      [targetMonth]
    );
    expect(count?.n).toBeGreaterThanOrEqual(24);

    // A transferência do mês alvo nasce PREVISÃO (PENDING, movimentos VOIDED)
    const entry = await db.getFirstAsync<{ transaction_id: string; kind: string }>(
      `SELECT transaction_id, kind FROM savings_entries WHERE month = ? AND kind = 'MONTHLY'`,
      [targetMonth]
    );
    expect(entry?.kind).toBe('MONTHLY');
    const tx = await db.getFirstAsync<{ status: string; type: string }>(
      'SELECT status, type FROM transactions WHERE id = ?',
      [entry?.transaction_id ?? '']
    );
    expect(tx?.status).toBe('PENDING');
    expect(tx?.type).toBe('TRANSFER');

    // Idempotência: rodar de novo NÃO duplica
    const createdAgain = await services.savings.generateForecast();
    expect(createdAgain).toBe(0);

    // Overview do mês alvo: previsto = falta = 300,00 · efetivado 0
    const overview = await services.savings.getMonthOverview(targetMonth);
    expect(overview.plannedCents).toBe(30_000);
    expect(overview.remainingCents).toBe(30_000);
    expect(overview.effectedCents).toBe(0);
    expect(overview.entries[0].effected).toBe(false);
    expect(overview.closingSuggestion).toBeNull(); // sem plano CLOSING
  });

  test('FECHAMENTO: saldo previsto positivo vira estimativa; confirmar cria transferência no fim do mês; repetir falha', async () => {
    const { db, services } = await makeCtx();
    const accA = await seedAccount(db, 'Corrente', 200_000);
    const accB = await seedAccount(db, 'Poupança');

    const today = todaySP();
    const curMonth = monthOf(today);
    const lastDayYmd = dayInMonth(curMonth, lastDayNumberOf(curMonth));

    await services.savings.createClosingPlan({ fromAccountId: accA, toAccountId: accB });

    // Saldo previsto final do mês = 2.000,00 (só saldo inicial) → sugere
    const sug = await services.savings.getClosingSuggestion(curMonth);
    expect(sug).not.toBeNull();
    expect(sug?.amountCents).toBe(200_000);

    // Confirma: entry CLOSING + transferência no ÚLTIMO dia do mês
    await services.savings.confirmClosing(curMonth, sug!.amountCents);
    const entry = await db.getFirstAsync<{ transaction_id: string; kind: string }>(
      `SELECT transaction_id, kind FROM savings_entries WHERE month = ? AND kind = 'CLOSING'`,
      [curMonth]
    );
    expect(entry?.kind).toBe('CLOSING');
    const tx = await db.getFirstAsync<{ status: string; occurred_on: string }>(
      'SELECT status, occurred_on FROM transactions WHERE id = ?',
      [entry?.transaction_id ?? '']
    );
    expect(tx?.occurred_on).toBe(lastDayYmd);
    expect(tx?.status).toBe(lastDayYmd > today ? 'PENDING' : 'CONFIRMED');

    // Repetir a confirmação do mesmo mês FALHA
    await expectRejects(
      () => services.savings.confirmClosing(curMonth, 1_000),
      'já foi confirmada'
    );

    // Sugestão some (já existe estimativa no mês)
    const sug2 = await services.savings.getClosingSuggestion(curMonth);
    expect(sug2).toBeNull();
  });

  test('FECHAMENTO: sem plano ativo OU saldo previsto ≤ 0 → sem sugestão', async () => {
    const { db, services } = await makeCtx();
    const accA = await seedAccount(db, 'Zerada', 0);
    const accB = await seedAccount(db, 'Destino');

    const curMonth = monthOf(todaySP());

    // Sem plano CLOSING → null
    expect(await services.savings.getClosingSuggestion(curMonth)).toBeNull();

    // Plano ativo, mas saldo previsto final 0,00 → null
    await services.savings.createClosingPlan({ fromAccountId: accA, toAccountId: accB });
    expect(await services.savings.getClosingSuggestion(curMonth)).toBeNull();
  });
});
