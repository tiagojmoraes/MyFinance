/**
 * Testes v20 — DATA ÂNCORA DO SALDO INICIAL (bug do usuário):
 *  · O "Saldo do dia Previsto/Efetivado" nunca batia com o extrato real porque
 *    o saldo inicial era tratado como válido DESDE SEMPRE: qualquer lançamento
 *    com data anterior ao momento em que aquele valor era verdade somava POR
 *    CIMA do inicial (contagem em dobro) e meses passados mostravam um saldo
 *    que nunca existiu.
 *  · Correção: accounts.initial_balance_date (migração v11 do banco).
 *    - Lançamento ANTERIOR à âncora já está dentro do saldo inicial (não soma);
 *    - Lançamento DO dia da âncora em diante soma por cima;
 *    - Dias ANTERIORES à âncora mostram 0,00 (saldo desconhecido);
 *    - âncora NULL = regra antiga (compatibilidade — nada muda de valor).
 */

import { makeCtx, seedAccount } from './helpers';

let ctx: ReturnType<typeof makeCtx> extends Promise<infer T> ? T : never;

beforeEach(async () => {
  ctx = await makeCtx();
});

/** Cria despesa CONFIRMADA em conta (transação + movimento DEBIT).
 *  v21: à vista FUTURO nasce PENDING (previsão) — estes testes querem o
 *  movimento CONFIRMED na data, então a promoção é forçada até a data. */
const expense = async (accountId: string, cents: number, date: string) => {
  const tx = await ctx.services.transactions.createAccountExpense({
    description: `Despesa ${date}`,
    amountCents: cents,
    date,
    accountId,
  });
  await ctx.services.transactions.promoteDuePendings(date);
  return tx;
};

/** Cria receita CONFIRMADA em conta (transação + movimento CREDIT). */
const income = async (accountId: string, cents: number, date: string) => {
  const tx = await ctx.services.transactions.createAccountIncome({
    description: `Receita ${date}`,
    amountCents: cents,
    date,
    accountId,
  });
  await ctx.services.transactions.promoteDuePendings(date);
  return tx;
};

/** Cria lançamento PENDING em conta (direto no banco — status controlado). */
const pending = async (accountId: string, cents: number, date: string, type = 'EXPENSE') => {
  const rid = `MAN:v20-${date}-${Math.random().toString(36).slice(2, 6)}`;
  await ctx.db.runAsync(
    `INSERT INTO transactions (id, kind, type, amount_cents, occurred_on, occurred_at, description,
      account_id, source_system, external_ref_id, status)
      VALUES (?, 'SIMPLE', ?, ?, ?, ?, 'Pendência', ?, 'MANUAL', ?, 'PENDING')`,
    [`tx-p-${rid}`, type, cents, date, `${date}T12:00:00Z`, accountId, rid]
  );
};

const setAnchor = (accountId: string, date: string | null) =>
  ctx.db.runAsync('UPDATE accounts SET initial_balance_date = ? WHERE id = ?', [date, accountId]);

/* ================================================================
 * 1) COMPATIBILIDADE — âncora NULL mantém a regra antiga
 * ================================================================ */
describe('v20 — âncora NULL (contas antigas) mantém o comportamento anterior', () => {
  test('saldo inicial vale desde sempre: lançamento anterior soma normalmente', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta Antiga', 1_000_00);
    await expense(acc, 30_000, '2026-11-01');

    expect(await services.balance.getAccountBalance(acc, '2026-11-01')).toBe(1_000_00 - 30_000);

    const { efetivado } = await services.balance.getDailyBalancesDual('2026-11');
    expect(efetivado['2026-11-01']).toBe(1_000_00 - 30_000);
    expect(efetivado['2026-11-30']).toBe(1_000_00 - 30_000);
  });
});

/* ================================================================
 * 2) ÂNCORA DEFINIDA — o bug do usuário desaparece
 * ================================================================ */
describe('v20 — saldo inicial com data âncora', () => {
  test('lançamento ANTERIOR à âncora NÃO soma (já está dentro do saldo inicial)', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Itaú', 1_000_00);
    await setAnchor(acc, '2026-11-05');
    // Gasto de 300 ANTES da âncora: já estava refletido no saldo real de 1.000
    await expense(acc, 30_000, '2026-11-01');

    // Saldo de hoje/depois da âncora: 1.000 (a despesa de 300 NÃO soma de novo)
    expect(await services.balance.getAccountBalance(acc, '2026-11-05')).toBe(1_000_00);
    expect(await services.balance.getAccountBalance(acc, '2026-11-30')).toBe(1_000_00);
    // Antes da âncora o saldo é desconhecido: 0,00
    expect(await services.balance.getAccountBalance(acc, '2026-11-04')).toBe(0);
  });

  test('movimentos DO dia da âncora em diante somam por cima (regra do início do dia)', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Nubank', 1_000_00);
    await setAnchor(acc, '2026-11-05');
    await expense(acc, 25_000, '2026-11-05'); // no próprio dia da âncora
    await income(acc, 10_000, '2026-11-07');

    expect(await services.balance.getAccountBalance(acc, '2026-11-05')).toBe(1_000_00 - 25_000);
    expect(await services.balance.getAccountBalance(acc, '2026-11-06')).toBe(1_000_00 - 25_000);
    expect(await services.balance.getAccountBalance(acc, '2026-11-07')).toBe(1_000_00 - 25_000 + 10_000);
  });

  test('Saldo do dia: 0,00 antes da âncora; saldo inicial entra no dia dela', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Inter', 1_000_00);
    await setAnchor(acc, '2026-11-05');
    await expense(acc, 30_000, '2026-11-01'); // antes: não soma
    await expense(acc, 25_000, '2026-11-05'); // no dia: soma

    const { efetivado, previsto } = await services.balance.getDailyBalancesDual('2026-11');
    expect(efetivado['2026-11-01']).toBe(0);
    expect(efetivado['2026-11-04']).toBe(0);
    expect(efetivado['2026-11-05']).toBe(1_000_00 - 25_000);
    expect(efetivado['2026-11-30']).toBe(1_000_00 - 25_000);
    // Sem pendências, previsto = efetivado em todos os dias
    expect(previsto['2026-11-05']).toBe(efetivado['2026-11-05']);
    expect(previsto['2026-11-01']).toBe(0);
  });

  test('PREVISTO: pendência ANTES da âncora não entra; pendência DEPOIS entra', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta Pend', 1_000_00);
    await setAnchor(acc, '2026-11-10');
    await pending(acc, 90_00, '2026-11-02'); // antes da âncora: já dentro do saldo
    await pending(acc, 70_00, '2026-11-20'); // depois: previsão real

    const { efetivado, previsto } = await services.balance.getDailyBalancesDual('2026-11');
    expect(previsto['2026-11-02']).toBe(efetivado['2026-11-02']); // a de 90 NÃO vira previsão
    expect(efetivado['2026-11-02']).toBe(0);
    expect(previsto['2026-11-10']).toBe(1_000_00);
    expect(previsto['2026-11-20']).toBe(1_000_00 - 70_00);
    expect(efetivado['2026-11-20']).toBe(1_000_00);
  });
});

/* ================================================================
 * 3) MÚLTIPLAS CONTAS — cada uma com a própria âncora
 * ================================================================ */
describe('v20 — várias contas no escopo do Fluxo, âncoras diferentes', () => {
  test('cada saldo inicial entra no dia da própria âncora', async () => {
    const { db, services } = ctx;
    const a = await seedAccount(db, 'Conta A', 500_00);
    const b = await seedAccount(db, 'Conta B', 300_00);
    await setAnchor(a, '2026-10-20'); // antes do mês visto: entra do dia 1
    await setAnchor(b, '2026-11-15'); // dentro do mês: entra no dia 15

    const { efetivado } = await services.balance.getDailyBalancesDual('2026-11');
    for (let d = 1; d <= 14; d++) {
      expect(efetivado[`2026-11-${String(d).padStart(2, '0')}`]).toBe(500_00);
    }
    expect(efetivado['2026-11-15']).toBe(800_00);
    expect(efetivado['2026-11-30']).toBe(800_00);
  });

  test('âncora DEPOIS do fim do mês: a conta não compõe o mês visto', async () => {
    const { db, services } = ctx;
    const a = await seedAccount(db, 'Conta Hoje', 400_00);
    const b = await seedAccount(db, 'Conta Futura', 600_00);
    await setAnchor(a, null);
    await setAnchor(b, '2026-12-01');

    const { efetivado } = await services.balance.getDailyBalancesDual('2026-11');
    expect(efetivado['2026-11-01']).toBe(400_00);
    expect(efetivado['2026-11-30']).toBe(400_00);

    // Início/saldos por conta: a futura mostra 0,00 até chegar o dia dela
    const geralNov = await services.balance.getGeneralBalance('2026-11-30');
    expect(geralNov).toBe(400_00);
    const contas = await services.balance.listAccountBalances('2026-11-30');
    expect(contas.find((c) => c.accountId === a)?.balanceCents).toBe(400_00);
    expect(contas.find((c) => c.accountId === b)?.balanceCents).toBe(0);
  });
});
