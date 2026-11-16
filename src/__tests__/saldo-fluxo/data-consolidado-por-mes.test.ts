/**
 * v88 (BUG) — A DATA DO CARD DO CONSOLIDADO NO FLUXO.
 *
 * O card do consolidado (grupo) mostrava SEMPRE a data do lançamento original
 * (o cabeçalho). Ao passar os meses na tela Fluxo, a data ficava "presa" na
 * data do lançamento e não batia com o mês do filtro.
 *
 * Regra nova (groupMonthDate, em src/lib/flowModel.ts):
 *  · no mês do CABEÇALHO → a data do lançamento;
 *  · nos outros meses → a PRIMEIRA data de conteúdo daquele mês (ocorrência
 *    da conta fixa ou vencimento da parcela mais antigo) — o card fica sempre
 *    dentro do mês que o usuário está olhando.
 */

import { makeCtx, seedAccount } from '../helpers';
import { buildGroupMonths, groupMonthDate, type FlowTx } from '../../lib/flowModel';

let ctx: ReturnType<typeof makeCtx> extends Promise<infer T> ? T : never;

beforeEach(async () => {
  ctx = await makeCtx();
});

/** Carrega os grupos do mês (como a tela Fluxo faz). */
async function gruposDoMes(month: string) {
  const rows = (await ctx.services.transactions.listFlow(month)) as unknown as FlowTx[];
  return (await buildGroupMonths(ctx.db, month, rows)).gm;
}

describe('v88 — data do consolidado por mês', () => {
  test('no mês do CABEÇALHO a data é a data do lançamento', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Data', 1_000_00);
    const g = await services.transactions.createConsolidatedGroup({
      description: 'Casa',
      date: '2026-11-02',
      accountId: accId,
      lines: [],
      headerAmountCents: 100_00,
      headerType: 'EXPENSE',
    });
    await services.recurrences.createRule({
      description: 'Luz', type: 'EXPENSE', amountCents: 100_00, dayOfMonth: 2,
      startDate: '2026-11-02', accountId: accId, groupTransactionId: g!.id,
    });
    await services.recurrences.runDueRecurrences('2026-12-03');

    const gm = await gruposDoMes('2026-11');
    const grp = gm[g!.id];
    expect(grp).toBeDefined();
    expect(grp.isHeaderMonth).toBe(true);
    expect(groupMonthDate(grp)).toBe('2026-11-02');
  });

  test('no mês SEGUINTE a data é a da ocorrência daquele mês (NÃO a do lançamento)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Mes', 1_000_00);
    const g = await services.transactions.createConsolidatedGroup({
      description: 'Casa',
      date: '2026-11-02',
      accountId: accId,
      lines: [],
      headerAmountCents: 100_00,
      headerType: 'EXPENSE',
    });
    await services.recurrences.createRule({
      description: 'Luz', type: 'EXPENSE', amountCents: 100_00, dayOfMonth: 5,
      startDate: '2026-11-02', accountId: accId, groupTransactionId: g!.id,
    });
    await services.recurrences.runDueRecurrences('2026-12-06');

    const gm = await gruposDoMes('2026-12');
    const grp = gm[g!.id];
    expect(grp).toBeDefined();
    expect(grp.isHeaderMonth).toBe(false);
    // a data exibida é a da ocorrência de DEZEMBRO (dia 5), não a do
    // lançamento (2026-11-02) — antes o card mostrava 02/11 em dezembro.
    expect(groupMonthDate(grp)).toBe('2026-12-05');
    // e, por consequência, a data está DENTRO do mês visto
    expect(groupMonthDate(grp).slice(0, 7)).toBe('2026-12');
  });

  test('grupo PARCELADO mostra o vencimento da parcela do mês visto', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Parc', 1_000_00);
    const g = await services.transactions.createConsolidatedGroup({
      description: 'Obras',
      date: '2026-11-02',
      accountId: accId,
      lines: [],
      headerAmountCents: 600_00,
      headerType: 'EXPENSE',
    });
    await services.installments.createPlan({
      description: 'Obra', mode: 'DIVIDE_TOTAL', totalCents: 600_00, totalInstallments: 3,
      firstDueDate: '2026-11-10', accountId: accId, groupTransactionId: g!.id,
    });

    const gm = await gruposDoMes('2026-11');
    const grp = gm[g!.id];
    expect(grp).toBeDefined();
    // no mês do cabeçalho: data do lançamento
    expect(groupMonthDate(grp)).toBe('2026-11-02');
    // em dezembro: a parcela que vence naquele mês
    const gmDez = await gruposDoMes('2026-12');
    const grpDez = gmDez[g!.id];
    expect(grpDez).toBeDefined();
    const data = groupMonthDate(grpDez);
    expect(data.slice(0, 7)).toBe('2026-12');
    expect(data).not.toBe('2026-11-02');
  });
});
