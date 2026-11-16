/** (v80) Parte de v24.test.ts — saldo do dia (relato 1).
 *  v24 — dois relatos do usuário:
 *  1. SALDO DO DIA instável / "não comporta alteração de datas": editar a data
 *     de um lançamento (qualquer status) tem que RECALCULAR todos os dias do
 *     mês — o valor sai do dia antigo e passa a valer no dia novo.
 *  2. NFC-e "continua o mesmo erro": documento PENDING/FAILED de tentativas
 *     antigas travava a nota em "já estava registrada" PARA SEMPRE. Agora o
 *     documento podre é reprocessado (upsert) e a nota é lida de verdade.
 */
import { makeCtx, seedAccount } from '../helpers';
import type { DbDriver } from '../../db/types';
import { todaySP, addDays, monthOf, monthAdd } from '../../lib/dates';
import { mergeDailyAdjust } from '../../lib/monthEndBalance';
import { genId } from '../../lib/id';
import { nowIso } from '../../lib/dates';

let db: DbDriver;
let services: ReturnType<typeof buildServices>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildServices } = require('../../services');

beforeEach(async () => {
  const ctx = await makeCtx();
  db = ctx.db;
  services = ctx.services;
});
describe('v24 saldo do dia — alteração de data recalcula TODOS os dias', () => {
  test('despesa CONFIRMADA movida de 03/12 para 05/12: sai do dia antigo, entra no novo', async () => {
    const acc = await seedAccount(db, 'Itau', 100000); // saldo inicial R$ 1.000,00
    // 03/12 é futuro em relação ao hoje real (2026-11-03): nasce PENDING...
    const tx = await services.transactions.createAccountExpense({
      description: 'Compra R$ 300', amountCents: 30000, date: '2026-12-03', accountId: acc,
    });
    // ...e a abertura do Fluxo em 04/12 promove a CONFIRMADA (v21 bug 2)
    await services.transactions.promoteDuePendings('2026-12-04');

    const antes = await services.balance.getDailyBalancesDual('2026-12');
    expect(antes.efetivado['2026-12-02']).toBe(100000);
    expect(antes.efetivado['2026-12-03']).toBe(70000); // 1.000 − 300
    expect(antes.efetivado['2026-12-04']).toBe(70000);

    // usuário EDITA a data para 05/12 (tela Alterar)
    await services.transactions.updateSimple(tx.id, { date: '2026-12-05' });

    const depois = await services.balance.getDailyBalancesDual('2026-12');
    // dias 02–04 VOLTAM ao saldo sem a compra (recálculo de todos os lançamentos)
    expect(depois.efetivado['2026-12-02']).toBe(100000);
    expect(depois.efetivado['2026-12-03']).toBe(100000);
    expect(depois.efetivado['2026-12-04']).toBe(100000);
    // e o dia novo passa a considerar (efetivado = previsto aqui)
    expect(depois.efetivado['2026-12-05']).toBe(70000);
    expect(depois.previsto['2026-12-05']).toBe(70000);
  });

  test('lançamento FUTURO (previsão) movido de data: previsto dos dias anteriores nunca o considera', async () => {
    const acc = await seedAccount(db, 'Itau', 100000);
    // 10k em 03/12 (futuro → PENDING + move VOIDED)
    const tx = await services.transactions.createAccountExpense({
      description: 'Compra 10k', amountCents: 1000000, date: '2026-12-03', accountId: acc,
    });
    let dual = await services.balance.getDailyBalancesDual('2026-12');
    // o exemplo do usuário: saldo do dia 02/12 NÃO considera o 10k do dia 03/12
    expect(dual.previsto['2026-12-02']).toBe(100000);
    expect(dual.previsto['2026-12-03']).toBe(-900000);

    // move para 08/12 — previsto dos dias 02–07 volta a ignorar o valor
    await services.transactions.updateSimple(tx.id, { date: '2026-12-08' });
    dual = await services.balance.getDailyBalancesDual('2026-12');
    expect(dual.previsto['2026-12-02']).toBe(100000);
    expect(dual.previsto['2026-12-07']).toBe(100000);
    expect(dual.previsto['2026-12-08']).toBe(-900000);
  });

  // v89 (BUG relatado): "Saldo do dia Efetivado/Previsto errado; não recalcula
  // quando se lança despesa com dia ANTERIOR à última que já tinha; meses
  // subsequentes ficam errados". Reprodução exata do relato, datas relativas.
  test('lançar despesa com dia ANTERIOR à última já existente recalcula hoje E meses subsequentes', async () => {
    const acc = await seedAccount(db, 'Itau', 100000); // R$ 1.000,00
    const today = todaySP();
    const yesterday = addDays(today, -1);
    // 1ª despesa efetivada "na última data" (hoje)
    await services.transactions.createAccountExpense({
      description: 'Despesa A', amountCents: 10000, date: today, accountId: acc,
    });
    let dual = await services.balance.getDailyBalancesDual(monthOf(today));
    expect(dual.efetivado[today]).toBe(90000);
    expect(dual.previsto[today]).toBe(90000);
    // 2ª despesa com dia ANTERIOR ao da última que já tinha
    await services.transactions.createAccountExpense({
      description: 'Despesa B', amountCents: 20000, date: yesterday, accountId: acc,
    });
    dual = await services.balance.getDailyBalancesDual(monthOf(today));
    // recalcula: ontem já saiu o B; hoje tem A + B
    expect(dual.efetivado[yesterday]).toBe(80000);
    expect(dual.efetivado[today]).toBe(70000);
    expect(dual.previsto[today]).toBe(70000);
    // meses subsequentes carregam o histórico (dez/jan com o mesmo saldo)
    const next = monthAdd(monthOf(today), 1);
    const dualNext = await services.balance.getDailyBalancesDual(next);
    const firstNext = `${next}-01`;
    expect(dualNext.efetivado[firstNext]).toBe(70000);
    expect(dualNext.previsto[firstNext]).toBe(70000);
  });

  // v89 (BUG relatado): lançar a POUPANÇA MENSAL com dia ANTERIOR ao último
  // lançamento não mexia no "Saldo do dia" (a compensação v68 DEVOLVIA o valor
  // ao número exibido — e se repetia em TODO mês subsequente). Regra nova:
  // o saldo exibido É o dinheiro disponível — a transferência DIMINUI o número.
  test('Poupança Mensal efetivada com dia anterior: Saldo do dia cai (sem compensação no exibido)', async () => {
    const acc = await seedAccount(db, 'Itau', 100000);
    const sav = await seedAccount(db, 'Poup', 0);
    await db.runAsync('UPDATE accounts SET include_in_general_balance = 0 WHERE id = ?', [sav]);
    const today = todaySP();
    const yesterday = addDays(today, -1);
    const m = monthOf(today);
    await services.transactions.createAccountExpense({
      description: 'Despesa', amountCents: 30000, date: today, accountId: acc,
    });
    const tx = await services.transactions.createTransfer({
      fromAccountId: acc, toAccountId: sav, amountCents: 10000, date: yesterday,
      description: 'Poupança mensal',
    });
    // entrada MONTHLY do plano (o que gera a compensação INTERNA no serviço)
    await db.runAsync(
      `INSERT INTO savings_entries (id, plan_id, month, kind, amount_cents, status, transaction_id, created_at)
       VALUES (?, NULL, ?, 'MONTHLY', ?, 'FORECAST', ?, ?)`,
      [genId(), m, 10000, tx.id, nowIso()]
    );
    const dual = await services.balance.getDailyBalancesDual(m);
    // o saldo CRU já caiu com a transferência (ontem)
    expect(dual.efetivado[yesterday]).toBe(90000);
    expect(dual.efetivado[today]).toBe(60000); // 1.000 − 100 poupança − 300 despesa
    // a compensação INTERNA continua existindo (sobra do mês / fechamento)
    const adj = await services.savings.getMonthFluxAdjust(m, [acc]);
    expect(adj.efetivado[today]).toBe(10000);
    // ...mas o que a TELA exibe (mergeDailyAdjust) NÃO a recebe mais
    const exibido = mergeDailyAdjust({ ...dual.efetivado }, null);
    expect(exibido[today]).toBe(60000);
  });

  test('mergeDailyAdjust: só o ajuste do Orçamento entra; Poupança fica fora do exibido', () => {
    const base = { '2026-11-01': 1000 };
    const bud = { '2026-11-01': -100, '2026-11-02': -50 };
    expect(mergeDailyAdjust(base, bud)).toEqual({ '2026-11-01': 900, '2026-11-02': -50 });
    expect(mergeDailyAdjust(base, null)).toEqual({ '2026-11-01': 1000 });
    expect(mergeDailyAdjust({}, bud)).toEqual({ '2026-11-01': -100, '2026-11-02': -50 });
  });
});