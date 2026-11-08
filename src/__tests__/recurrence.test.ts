/** Fase 2 — Recorrências mensais idempotentes com clamp de dia. */

import { makeCtx, seedAccount, getAccountBalance } from './helpers';
import { todaySP, monthOf, monthAdd, lastDayNumberOf } from '../lib/dates';

describe('RecurrenceService', () => {
  test('cria transações dos meses decorridos e é idempotente', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Banco', 0);
    const today = todaySP();
    const start = `${monthAdd(monthOf(today), -2)}-05`;
    await services.recurrences.createRule({
      description: 'Aluguel', type: 'EXPENSE', amountCents: 150000, dayOfMonth: 5, startDate: start, accountId: acc,
    });
    // Expectativa calculada de forma determinística
    let m = monthOf(start);
    let expected = 0;
    while (m <= monthOf(today)) {
      const day = Math.min(5, lastDayNumberOf(m));
      if (`${m}-${String(day).padStart(2, '0')}` <= today) expected++;
      m = monthAdd(m, 1);
    }
    const r1 = await services.recurrences.runDueRecurrences(today);
    expect(r1.createdTransactions).toBe(expected);
    // Idempotência: rodar de novo não cria nada
    const r2 = await services.recurrences.runDueRecurrences(today);
    expect(r2.createdTransactions).toBe(0);
  });

  test('dia 31 clampa para o último dia de meses curtos', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Banco', 0);
    await services.recurrences.createRule({
      description: 'Assinatura', type: 'EXPENSE', amountCents: 1999, dayOfMonth: 31,
      startDate: '2026-01-01', accountId: acc,
    });
    await services.recurrences.runDueRecurrences('2026-03-01');
    // 31/jan e 28/fev gerados; 31/mar ainda não venceu em 01/mar
    const dates = await services.db.getAllAsync<{ occurred_on: string }>(
      'SELECT occurred_on FROM transactions ORDER BY occurred_on'
    );
    expect(dates.map((d) => d.occurred_on)).toEqual(['2026-01-31', '2026-02-28']);
  });

  test('regra com end_date para de gerar', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Banco', 0);
    await services.recurrences.createRule({
      description: 'Financiamento', type: 'EXPENSE', amountCents: 200000, dayOfMonth: 10,
      startDate: '2026-01-01', endDate: '2026-02-28', accountId: acc,
    });
    await services.recurrences.runDueRecurrences('2026-05-01');
    const txs = await services.db.getAllAsync<{ occurred_on: string }>('SELECT occurred_on FROM transactions');
    expect(txs).toHaveLength(2);
  });

  test('receita recorrente gera CREDIT e soma no saldo', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Banco', 0);
    await services.recurrences.createRule({
      description: 'Salário', type: 'INCOME', amountCents: 500000, dayOfMonth: 1,
      startDate: `${monthOf(todaySP())}-01`, accountId: acc,
    });
    await services.recurrences.runDueRecurrences();
    const bal = await getAccountBalance(services.db, acc);
    expect(bal).toBe(500000);
  });

  test('editar regra (v7.0.5): meses anteriores intactos, competência atual e futuras com o novo valor', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Banco', 0);
    // Aluguel R$ 1.000 no dia 5 desde janeiro
    const rule = await services.recurrences.createRule({
      description: 'Aluguel', type: 'EXPENSE', amountCents: 100_000, dayOfMonth: 5,
      startDate: '2026-01-01', accountId: acc,
    });
    // Gera jan, fev e mar (hoje = 20/03/2026)
    await services.recurrences.runDueRecurrences('2026-03-20');
    const antes = await services.db.getAllAsync<{ occurred_on: string; amount_cents: number }>(
      'SELECT occurred_on, amount_cents FROM transactions ORDER BY occurred_on'
    );
    expect(antes.map((t) => t.amount_cents)).toEqual([100_000, 100_000, 100_000]);

    // Aumenta para R$ 1.200: jan/fev ficam; mar (competência atual) muda
    await services.recurrences.updateRule(rule.id, { amountCents: 120_000, today: '2026-03-20' });
    const depois = await services.db.getAllAsync<{ occurred_on: string; amount_cents: number }>(
      'SELECT occurred_on, amount_cents FROM transactions ORDER BY occurred_on'
    );
    expect(depois.map((t) => t.amount_cents)).toEqual([100_000, 100_000, 120_000]);

    // Move da competência atual acompanha (saldo correto)
    const move = await services.db.getFirstAsync<{ amount_cents: number }>(
      "SELECT amount_cents FROM financial_moves WHERE effective_date LIKE '2026-03-%'"
    );
    expect(move?.amount_cents).toBe(120_000);

    // Abril nasce com o novo valor
    await services.recurrences.runDueRecurrences('2026-04-20');
    const abril = await services.db.getFirstAsync<{ amount_cents: number }>(
      "SELECT amount_cents FROM transactions WHERE occurred_on LIKE '2026-04-%'"
    );
    expect(abril?.amount_cents).toBe(120_000);
  });

  test('excluir conta fixa: "este e as próximas" — APAGA do banco do mês em diante e encerra a regra (v10)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Banco', 0);
    const rule = await services.recurrences.createRule({
      description: 'Aluguel', type: 'EXPENSE', amountCents: 100_000, dayOfMonth: 5,
      startDate: '2026-01-01', accountId: acc,
    });
    await services.recurrences.runDueRecurrences('2026-03-20'); // gera jan, fev, mar

    // Exclui a partir de fevereiro: fev e mar saem FISICAMENTE do banco; janeiro fica
    const res = await services.recurrences.excludeFrom(rule.id, '2026-02-05');
    expect(res.voided).toBe(2);

    const txs = await services.db.getAllAsync<{ occurred_on: string; status: string }>(
      'SELECT occurred_on, status FROM transactions ORDER BY occurred_on'
    );
    expect(txs).toHaveLength(1);
    expect(txs[0]).toEqual({ occurred_on: '2026-01-05', status: 'CONFIRMED' });

    // Só janeiro permanece com movimento CONFIRMED
    const movesOk = await services.db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM financial_moves m JOIN transactions t ON t.id = m.transaction_id
        WHERE t.recurrence_rule_id = ? AND m.status = 'CONFIRMED'`, [rule.id]
    );
    expect(movesOk?.c).toBe(1);

    // Regra encerrada (end_date = véspera): abril não nasce mais
    await services.recurrences.runDueRecurrences('2026-04-20');
    const abril = await services.db.getFirstAsync<{ status: string }>(
      "SELECT status FROM transactions WHERE occurred_on LIKE '2026-04-%'"
    );
    expect(abril).toBeNull();
  });

  test('excluir conta fixa: "apenas este" — APAGA a ocorrência e o mês NÃO é recriado (v10)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Banco', 0);
    const rule = await services.recurrences.createRule({
      description: 'Internet', type: 'EXPENSE', amountCents: 119_90, dayOfMonth: 15,
      startDate: '2026-01-01', accountId: acc,
    });
    await services.recurrences.runDueRecurrences('2026-03-20'); // gera jan, fev, mar

    // Exclui só a ocorrência de fevereiro (exclusão física + exceção do mês)
    const fev = await services.db.getFirstAsync<{ id: string }>(
      "SELECT id FROM transactions WHERE recurrence_rule_id = ? AND occurred_on = '2026-02-15'", [rule.id]
    );
    await services.transactions.deleteTransaction(fev!.id);

    const fevDepois = await services.db.getFirstAsync('SELECT id FROM transactions WHERE occurred_on = ?', ['2026-02-15']);
    expect(fevDepois).toBeNull();

    // A regra continua (sem end_date): março já existe e abril nasce normalmente —
    // e fevereiro NÃO é recriado (exceção registrada pela exclusão física)
    await services.recurrences.runDueRecurrences('2026-03-25');
    await services.recurrences.runDueRecurrences('2026-04-20');
    const fevRecriada = await services.db.getFirstAsync('SELECT id FROM transactions WHERE occurred_on = ?', ['2026-02-15']);
    expect(fevRecriada).toBeNull();
    const abril = await services.db.getFirstAsync<{ amount_cents: number; status: string }>(
      "SELECT amount_cents, status FROM transactions WHERE occurred_on LIKE '2026-04-%'"
    );
    expect(abril?.status).toBe('CONFIRMED');
    expect(abril?.amount_cents).toBe(119_90);
  });
});
