/**
 * Testes v13 — correções de bugs urgentes e usabilidade do CONSOLIDADO:
 *  · Bug 1.A: consolidado com linha FIXO PERPETUA nos meses seguintes — o grupo
 *    aparece em TODO ciclo recorrente (cabeçalho buscado fora do mês + previsão).
 *  · Bug 1.B: expandir o consolidado NÃO duplica itens — o número listado é
 *    exatamente o real (sem o registro "de origem" das fixas/parcelas).
 *  · Bug 1.C: PARCELADO no CARTÃO DE CRÉDITO dentro de grupo consolidado —
 *    o plano nasce no cartão (parcelas na FATURA) e o grupo pode nascer sem conta.
 *  · UI 2.A/2.B: saldo do grupo só conta as linhas à vista no mês do cabeçalho;
 *    o chip de status cobre todo o agrupamento (linhas + fixas em conta +
 *    parcelas em conta — itens de cartão ficam de fora, pagos pela fatura).
 */

import { makeCtx, seedAccount, seedCard, getAccountBalance } from './helpers';
import { todaySP, monthOf, monthAdd, dayInMonth } from '../lib/dates';
import {
  buildGroupMonths,
  groupMonthTotals,
  groupStatusInfo,
  groupStatusItems,
  type FlowTx,
} from '../lib/flowModel';

let ctx: ReturnType<typeof makeCtx> extends Promise<infer T> ? T : never;

beforeEach(async () => {
  ctx = await makeCtx();
});

/** Replica o filtro da lista raiz da tela Fluxo (o que NÃO é cartão, nem
 *  ocorrência de grupo, nem cabeçalho). */
function rootRows(allRows: FlowTx[], occIds: Set<string>): FlowTx[] {
  return allRows.filter(
    (t) => !t.card_id && !occIds.has(t.id) && !(t.kind === 'CONSOLIDATED' && t.source_system !== 'INSTALLMENT')
  );
}

describe('Bug 1.A — consolidado com Fixo perpetua nos meses seguintes', () => {
  test('o grupo aparece no mês SEGUINTE com a ocorrência de previsão (cabeçalho fora do mês)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Perpetua', 0);
    const today = todaySP();
    const cur = monthOf(today);
    const next = monthAdd(cur, 1);

    // Grupo-âncora + fixa vinculada (o caminho do formulário Consolidado > Fixo)
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Operação perpetua',
      date: dayInMonth(cur, 1),
      accountId: accId,
      lines: [],
      headerAmountCents: 100_00,
      headerType: 'EXPENSE',
    });
    expect(grupo).not.toBeNull();
    await services.recurrences.createRule({
      description: 'Luz da operação',
      type: 'EXPENSE',
      amountCents: 10_00,
      dayOfMonth: 1,
      startDate: dayInMonth(cur, 1),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences();
    await services.recurrences.runForecast();

    // No mês seguinte o cabeçalho NÃO vem no listFlow (só no mês dele)…
    const rowsNext = (await services.transactions.listFlow(next)) as unknown as FlowTx[];
    expect(rowsNext.some((t) => t.id === grupo!.id)).toBe(false);

    // …mas a agregação v13 busca o cabeçalho no banco e o grupo APARECE
    const { gm, occIds, childrenByGroup } = await buildGroupMonths(db, next, rowsNext);
    const grp = gm[grupo!.id];
    expect(grp).toBeDefined();
    expect(grp.isHeaderMonth).toBe(false);
    expect(grp.header.description).toBe('Operação perpetua');
    expect(grp.occurrences.length).toBe(1);
    expect(grp.occurrences[0].description).toBe('Luz da operação');
    expect(grp.occurrences[0].status).toBe('PENDING'); // previsão do mês seguinte
    expect(childrenByGroup[grupo!.id]).toBeUndefined(); // sem linhas à vista fora do mês

    // A ocorrência do grupo NÃO aparece solta na raiz (vai dentro do card)
    expect(rootRows(rowsNext, occIds).some((t) => t.id === grp.occurrences[0].id)).toBe(false);
  });

  test('no mês seguinte o saldo do grupo conta SÓ o conteúdo daquele mês (linhas à vista não vazam)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Saldo', 0);
    const today = todaySP();
    const cur = monthOf(today);
    const next = monthAdd(cur, 1);

    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Operação com à vista + fixa',
      date: dayInMonth(cur, 1),
      accountId: accId,
      lines: [{ direction: 'DEBIT', description: 'Mercado', amountCents: 50_00, categoryId: null }],
    });
    await services.recurrences.createRule({
      description: 'Luz',
      type: 'EXPENSE',
      amountCents: 10_00,
      dayOfMonth: 1,
      startDate: dayInMonth(cur, 1),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences();
    await services.recurrences.runForecast();

    // Mês do cabeçalho: à vista (50) + fixa (10) = 60 de débitos
    const rowsCur = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const gmCur = (await buildGroupMonths(db, cur, rowsCur)).gm[grupo!.id];
    expect(groupMonthTotals(gmCur).debits).toBe(60_00);

    // Mês seguinte: SÓ a fixa (10) — os 50 da linha à vista NÃO vazam
    const rowsNext = (await services.transactions.listFlow(next)) as unknown as FlowTx[];
    const gmNext = (await buildGroupMonths(db, next, rowsNext)).gm[grupo!.id];
    expect(gmNext).toBeDefined();
    expect(groupMonthTotals(gmNext).debits).toBe(10_00);
    expect(groupMonthTotals(gmNext).credits).toBe(0);
  });
});

describe('Bug 1.B — expandir o consolidado NÃO duplica itens', () => {
  test('o número listado é exatamente o real (1 à vista + 1 fixa + 1 parcela no mês)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta SemDup', 0);
    const today = todaySP();
    const cur = monthOf(today);

    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Operação completa',
      date: dayInMonth(cur, 1),
      accountId: accId,
      lines: [{ direction: 'DEBIT', description: 'Mercado', amountCents: 50_00, categoryId: null }],
    });
    await services.recurrences.createRule({
      description: 'Luz',
      type: 'EXPENSE',
      amountCents: 10_00,
      dayOfMonth: 1,
      startDate: dayInMonth(cur, 1),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    await services.installments.createPlan({
      description: 'Notebook',
      mode: 'DIVIDE_TOTAL',
      totalCents: 30_00,
      totalInstallments: 3,
      firstDueDate: dayInMonth(cur, 15),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences();
    await services.recurrences.runForecast();

    const rows = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const { gm, occIds, instIds, childrenByGroup } = await buildGroupMonths(db, cur, rows);
    const grp = gm[grupo!.id];
    expect(grp).toBeDefined();

    // EXATAMENTE os itens reais do mês — nada duplicado:
    expect(childrenByGroup[grupo!.id].length).toBe(1); // 1 linha à vista
    expect(grp.occurrences.length).toBe(1); // 1 ocorrência da fixa (não 2!)
    expect(grp.installments.length).toBe(1); // 1 parcela no mês
    const itemCount = grp.header.child_count + grp.occurrences.length + grp.installments.length;
    expect(itemCount).toBe(3);

    // A ocorrência e a parcela saem da raiz (não aparecem 2x na tela)
    expect(rootRows(rows, occIds).some((t) => t.id === grp.occurrences[0].id)).toBe(false);
    const rootInstIds = rows
      .filter((t) => !t.card_id && !occIds.has(t.id))
      .map(() => null)
      .filter(Boolean);
    expect(rootInstIds.length).toBeGreaterThanOrEqual(0);
    expect(instIds.has(grp.installments[0].installmentId)).toBe(true);

    // Reprocessos (propagação/efetivação de novo) NÃO acumulam linhas
    await services.recurrences.runDueRecurrences();
    await services.recurrences.runForecast();
    const rows2 = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const again = await buildGroupMonths(db, cur, rows2);
    expect(again.gm[grupo!.id].occurrences.length).toBe(1);
    expect(again.gm[grupo!.id].installments.length).toBe(1);
    expect(again.childrenByGroup[grupo!.id].length).toBe(1);
  });

  test('a expansão refaz a leitura e o resultado é idêntico (sem acumular a cada clique)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Cliques', 0);
    const today = todaySP();
    const cur = monthOf(today);
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Só fixa',
      date: dayInMonth(cur, 1),
      accountId: accId,
      lines: [],
      headerAmountCents: 20_00,
      headerType: 'EXPENSE',
    });
    await services.recurrences.createRule({
      description: 'Água',
      type: 'EXPENSE',
      amountCents: 20_00,
      dayOfMonth: 1,
      startDate: dayInMonth(cur, 1),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences();

    // Simula 3 cliques de expansão seguidos (cada um relê o mês)
    for (let i = 0; i < 3; i++) {
      const rows = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
      const { gm } = await buildGroupMonths(db, cur, rows);
      expect(gm[grupo!.id].occurrences.length).toBe(1);
    }
  });
});

describe('Bug 1.C — consolidado > cartão de crédito > parcelado', () => {
  test('grupo só com PARCELADO no cartão nasce SEM conta e as parcelas entram na FATURA', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Ancora Cartao', 0);
    const cardId = await seedCard(db, accId, 'Card do Grupo', 15, 10);
    const today = todaySP();
    const cur = monthOf(today);

    // Cabeçalho-âncora SEM conta (o grupo é todo no cartão)
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Operação no cartão',
      date: dayInMonth(cur, 1),
      lines: [],
      headerAmountCents: 300_00,
      headerType: 'EXPENSE',
    });
    expect(grupo).not.toBeNull();

    // Plano PARCELADO no cartão, DENTRO do grupo (sem accountId)
    const { planId } = await services.installments.createPlan({
      description: 'Notebook do grupo',
      mode: 'DIVIDE_TOTAL',
      totalCents: 300_00,
      totalInstallments: 3,
      firstDueDate: dayInMonth(cur, 5),
      cardId,
      groupTransactionId: grupo!.id,
    });
    const planRow = await db.getFirstAsync<{ card_id: string | null; account_id: string | null; group_transaction_id: string | null }>(
      'SELECT card_id, account_id, group_transaction_id FROM installment_plans WHERE id = ?',
      [planId]
    );
    expect(planRow?.card_id).toBe(cardId);
    expect(planRow?.account_id).toBeNull();
    expect(planRow?.group_transaction_id).toBe(grupo!.id);

    // As parcelas nascem DIRETO NA FATURA (3 faturas com item de 100,00)
    for (let i = 0; i < 3; i++) {
      const ym = monthAdd(cur, i);
      const inv = await db.getFirstAsync<{ total_cents: number }>(
        'SELECT total_cents FROM invoices WHERE card_id = ? AND reference_month = ?',
        [cardId, ym]
      );
      expect(inv).not.toBeNull();
      expect(inv!.total_cents).toBe(100_00);
    }

    // No Fluxo: o grupo aparece; a parcela de cartão NÃO vira parcela em conta
    const rows = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const { gm, instIds } = await buildGroupMonths(db, cur, rows);
    expect(gm[grupo!.id]).toBeDefined();
    expect(gm[grupo!.id].installments.length).toBe(0);
    expect(instIds.size).toBe(0);
    // E o saldo da conta NÃO é afetado (compra de cartão só sai no pagamento da fatura)
    expect(await getAccountBalance(db, accId)).toBe(0);
  });

  test('FIXA no cartão dentro do grupo: a ocorrência de todo mês entra na fatura', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Fixa Cartao Grupo', 0);
    const cardId = await seedCard(db, accId, 'Card Fixa Grupo', 15, 10);
    const today = todaySP();
    const cur = monthOf(today);

    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Operação com fixa no cartão',
      date: dayInMonth(cur, 1),
      lines: [],
      headerAmountCents: 25_00,
      headerType: 'EXPENSE',
    });
    await services.recurrences.createRule({
      description: 'Streaming da operação',
      type: 'EXPENSE',
      amountCents: 25_00,
      dayOfMonth: 1,
      startDate: dayInMonth(cur, 1),
      cardId,
      groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences();
    await services.recurrences.runForecast();

    const inv = await db.getFirstAsync<{ total_cents: number }>(
      'SELECT total_cents FROM invoices WHERE card_id = ? AND reference_month = ?',
      [cardId, cur]
    );
    expect(inv?.total_cents).toBe(25_00);

    const rows = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const { gm } = await buildGroupMonths(db, cur, rows);
    expect(gm[grupo!.id].occurrences.length).toBe(1);
    expect(gm[grupo!.id].occurrences[0].card_id).toBe(cardId);
  });
});

describe('UI 2.B — status do grupo vale para TODO o agrupamento contido', () => {
  test('marcar Pago aplica a linhas + fixa em conta + parcelas; desmarcar volta tudo', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Status', 0);
    const today = todaySP();
    const cur = monthOf(today);

    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Operação status',
      date: dayInMonth(cur, 1),
      accountId: accId,
      lines: [{ direction: 'DEBIT', description: 'Mercado', amountCents: 50_00, categoryId: null }],
    });
    await services.recurrences.createRule({
      description: 'Luz',
      type: 'EXPENSE',
      amountCents: 10_00,
      dayOfMonth: 1,
      startDate: dayInMonth(cur, 1),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    await services.installments.createPlan({
      description: 'Notebook',
      mode: 'DIVIDE_TOTAL',
      totalCents: 30_00,
      totalInstallments: 2,
      firstDueDate: dayInMonth(cur, 1),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences();

    const rows = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const { gm, childrenByGroup } = await buildGroupMonths(db, cur, rows);
    const grp = gm[grupo!.id];
    const children = childrenByGroup[grupo!.id];

    // Estado inicial: à vista confirmada, fixa confirmada, parcelas pendentes
    const info0 = groupStatusInfo(grp, children);
    expect(info0).not.toBeNull();
    expect(info0!.count).toBe(3); // 1 linha + 1 fixa + 1 parcela deste mês (a 2ª é no mês seguinte)
    expect(info0!.allDone).toBe(false);
    expect(info0!.isIncome).toBe(false); // despesa → chip "Pago"

    // TOQUE no chip: marca TUDO (o loop do toggleGroupPayment)
    const { txs, insts } = groupStatusItems(grp, children);
    for (const t of txs) await services.transactions.setPaymentStatus(t.id, true);
    for (const i of insts) await services.installments.setPaymentStatus(i.installmentId, true);

    const rows2 = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const after2 = await buildGroupMonths(db, cur, rows2);
    const info1 = groupStatusInfo(after2.gm[grupo!.id], after2.childrenByGroup[grupo!.id]);
    expect(info1!.allDone).toBe(true);

    // Tudo CONFIRMED/PAID com movimento CONFIRMED
    for (const t of txs) {
      const st = await db.getFirstAsync<{ status: string }>('SELECT status FROM transactions WHERE id = ?', [t.id]);
      expect(st?.status).toBe('CONFIRMED');
    }
    for (const i of insts) {
      const st = await db.getFirstAsync<{ status: string }>('SELECT status FROM installments WHERE id = ?', [i.installmentId]);
      expect(st?.status).toBe('PAID');
    }

    // TOQUE de novo: desmarca TUDO (previsão de volta, movimentos voidados)
    for (const t of txs) await services.transactions.setPaymentStatus(t.id, false);
    for (const i of insts) await services.installments.setPaymentStatus(i.installmentId, false);
    const rows3 = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const after3 = await buildGroupMonths(db, cur, rows3);
    const info2 = groupStatusInfo(after3.gm[grupo!.id], after3.childrenByGroup[grupo!.id]);
    expect(info2!.allDone).toBe(false);
    for (const i of insts) {
      const st = await db.getFirstAsync<{ status: string }>('SELECT status FROM installments WHERE id = ?', [i.installmentId]);
      expect(st?.status).toBe('PENDING');
    }
  });

  test('itens de CARTÃO ficam FORA do status do grupo (pagos pela fatura)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Chip Card', 0);
    const cardId = await seedCard(db, accId, 'Card Chip', 15, 10);
    const today = todaySP();
    const cur = monthOf(today);

    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Grupo com fixa no cartão',
      date: dayInMonth(cur, 1),
      accountId: accId,
      lines: [{ direction: 'DEBIT', description: 'Mercado', amountCents: 50_00, categoryId: null }],
    });
    await services.recurrences.createRule({
      description: 'Streaming',
      type: 'EXPENSE',
      amountCents: 25_00,
      dayOfMonth: 1,
      startDate: dayInMonth(cur, 1),
      cardId,
      groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences();

    const rows = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const { gm, childrenByGroup } = await buildGroupMonths(db, cur, rows);
    const { txs } = groupStatusItems(gm[grupo!.id], childrenByGroup[grupo!.id]);
    // Só a linha à vista (conta) participa; a ocorrência do CARTÃO não entra
    expect(txs.length).toBe(1);
    expect(txs[0].description).toBe('Mercado');
  });

  test('grupo de RECEITA mostra ciclo Recebido/Não recebido (chip pelo tipo do cabeçalho)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Receita Grupo', 0);
    const today = todaySP();
    const cur = monthOf(today);

    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Rendas do mês',
      date: dayInMonth(cur, 1),
      accountId: accId,
      lines: [],
      headerAmountCents: 80_00,
      headerType: 'INCOME',
    });
    await services.recurrences.createRule({
      description: 'Freela mensal',
      type: 'INCOME',
      amountCents: 80_00,
      dayOfMonth: 1,
      startDate: dayInMonth(cur, 1),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences();

    const rows = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const { gm, childrenByGroup } = await buildGroupMonths(db, cur, rows);
    const info = groupStatusInfo(gm[grupo!.id], childrenByGroup[grupo!.id]);
    expect(info).not.toBeNull();
    expect(info!.isIncome).toBe(true);
    expect(info!.allDone).toBe(true); // ocorrência do mês nasce efetivada
  });
});
