/**
 * v94 — DISPONIBILIDADE FINANCEIRA: o Saldo do Fluxo tem de CAIR mês a mês
 * conforme o dinheiro sai da conta (despesa, transferência).
 *
 * Bug relatado: "o saldo da tela Fluxo não diminui com o passar dos meses".
 * Causa: a conta POUPANÇA (destino da transferência) nascia marcada "Aparece
 * no saldo do Fluxo" — o débito na origem era anulado pelo crédito no destino
 * dentro do MESMO escopo, então guardar dinheiro não mexia no número.
 *
 * Regra nova (v94): Poupança fica FORA do escopo, sempre (migração 58 + guarda
 * no BalanceService). A transferência passa a diminuir o saldo como qualquer
 * saída, e os meses seguintes carregam esse saldo menor.
 */

import { makeCtx, seedAccount } from '../helpers';

let ctx: ReturnType<typeof makeCtx> extends Promise<infer T> ? T : never;

beforeEach(async () => {
  ctx = await makeCtx();
});

/** Marca a conta como SAVINGS e força a flag antiga (dado que a migração corrige). */
const asSavings = async (accountId: string) => {
  await ctx.db.runAsync(
    "UPDATE accounts SET type = 'SAVINGS', include_in_general_balance = 1 WHERE id = ?",
    [accountId]
  );
};

describe('v94 — saldo do Fluxo cai mês a mês (disponibilidade)', () => {
  test('transferência para a Poupança sai do saldo do mês e dos meses seguintes', async () => {
    const { db, services } = ctx;
    const corrente = await seedAccount(db, 'Corrente', 2_000_00);
    const poupanca = await seedAccount(db, 'Poupança', 0);
    await asSavings(poupanca);
    await db.runAsync("UPDATE accounts SET initial_balance_date = '2026-01-01' WHERE id = ?", [corrente]);

    // 400 guardados em fevereiro (data passada → transferência CONFIRMADA)
    await services.transactions.createTransfer({
      fromAccountId: corrente,
      toAccountId: poupanca,
      amountCents: 400_00,
      date: '2026-02-10',
      description: 'Poupança mensal',
    });

    const jan = await services.balance.getDailyBalancesDual('2026-01');
    const fev = await services.balance.getDailyBalancesDual('2026-02');
    const mar = await services.balance.getDailyBalancesDual('2026-03');

    expect(jan.efetivado['2026-01-31']).toBe(2_000_00);
    expect(fev.efetivado['2026-02-28']).toBe(1_600_00); // caiu ao guardar
    expect(mar.efetivado['2026-03-31']).toBe(1_600_00); // o mês seguinte carrega o saldo real
    expect(mar.previsto['2026-03-31']).toBe(1_600_00);
  });

  test('despesas confirmadas reduzem o saldo acumulado de cada mês', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 1_000_00);
    await db.runAsync("UPDATE accounts SET initial_balance_date = '2026-01-01' WHERE id = ?", [acc]);
    const gasto = (cents: number, date: string) =>
      services.transactions.createAccountExpense({
        description: `Gasto ${date}`,
        amountCents: cents,
        date,
        accountId: acc,
      });

    await gasto(100_00, '2026-01-15');
    await gasto(200_00, '2026-02-15');
    await gasto(300_00, '2026-03-15');
    await services.transactions.promoteDuePendings('2026-03-31');

    expect((await services.balance.getDailyBalancesDual('2026-01')).efetivado['2026-01-31']).toBe(900_00);
    expect((await services.balance.getDailyBalancesDual('2026-02')).efetivado['2026-02-28']).toBe(700_00);
    expect((await services.balance.getDailyBalancesDual('2026-03')).efetivado['2026-03-31']).toBe(400_00);
  });
});
