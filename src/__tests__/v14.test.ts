/**
 * Testes v14 — bugs urgentes e usabilidade (rodada 3):
 *  · Bug 1: "Ajustes > Limpar lançamentos e movimentações" funciona ATÉ com
 *    grupo consolidado + conta fixa + parcelamento + fatura paga + OFX no banco
 *    (FKs cruzadas transactions ↔ recurrence_rules e autorreferência das linhas
 *    do grupo liberadas antes dos DELETEs). Cadastros base INTOCADOS.
 *  · Bug 2: RECEITA PARCELADA no consolidado (Crédito + Parcelado) — em CONTA
 *    as parcelas geram CRÉDITOS futuros; no CARTÃO entram NEGATIVAS na fatura;
 *    Fluxo/saldos/tratamento de status com a direção certa.
 *  · Bug 3: parcelado NORMAL não cria "Consolidado" fantasma no Fluxo — a
 *    âncora interna (kind CONSOLIDATED + source INSTALLMENT) não aparece na
 *    lista raiz, nem isolada nem dentro de grupo (o parcelado aparece só pela
 *    sua parcela do mês).
 *  · Bug 4 + Melhoria 1: DADOS do layout unificado — todo card não-cartão tem
 *    as mesmas informações disponíveis (descrição, data, tipo, status, conta,
 *    pill de parcela, categoria); consolidado Fixo e Parcelado usam o mesmo
 *    modelo (GroupMonth + totais) independentemente do subtipo.
 *  · Melhoria 2: marcador de tela — o campo do consolidado chama "Conta do grupo".
 *  · CENÁRIOS FUTUROS: reflexão de cada tipo de lançamento nos meses seguintes.
 */

import { makeCtx, seedAccount, seedCard, getAccountBalance } from './helpers';
import { todaySP, monthOf, monthAdd, dayInMonth } from '../lib/dates';
import { clearLancamentos } from '../db/seed';
import {
  buildGroupMonths,
  groupMonthTotals,
  groupStatusInfo,
  type FlowTx,
  type InstAgg,
} from '../lib/flowModel';

let ctx: ReturnType<typeof makeCtx> extends Promise<infer T> ? T : never;

beforeEach(async () => {
  ctx = await makeCtx();
});

/** Réplica EXATA do filtro da lista raiz da tela Fluxo (v14 — inclui a exclusão
 *  da âncora INSTALLMENT do bug 3). */
function rootRows(allRows: FlowTx[], occIds: Set<string>): FlowTx[] {
  return allRows.filter(
    (t) =>
      !t.card_id &&
      t.source_system !== 'INSTALLMENT' &&
      !occIds.has(t.id) &&
      !(t.kind === 'CONSOLIDATED' && t.source_system !== 'INSTALLMENT')
  );
}

/* ================================================================
 * BUG 1 — Botão de limpeza em Ajustes
 * ================================================================ */
describe('Bug 1 — "Limpar lançamentos e movimentações" funciona com QUALQUER conteúdo', () => {
  test('limpa banco PESADO (consolidado com linhas + fixa + parcelado + fatura paga + OFX) sem erro de FK', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Pesada', 100_000);
    const acc2Id = await seedAccount(db, 'Conta Pesada 2', 0);
    const cardId = await seedCard(db, accId, 'Card Pesado', 15, 10);
    const cur = monthOf(todaySP());

    // 1. Grupo consolidado COM linhas à vista (cabeçalho + filhos — autorreferência)
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Operação pesada',
      date: dayInMonth(cur, 2),
      accountId: accId,
      lines: [
        { direction: 'DEBIT', description: 'Mercado', amountCents: 50_00, categoryId: null },
        { direction: 'CREDIT', description: 'Venda', amountCents: 20_00, categoryId: null },
      ],
    });
    expect(grupo).not.toBeNull();

    // 2. Fixa vinculada ao grupo (transactions ↔ recurrence_rules cruzadas)
    await services.recurrences.createRule({
      description: 'Luz da operação',
      type: 'EXPENSE',
      amountCents: 10_00,
      dayOfMonth: 2,
      startDate: dayInMonth(cur, 2),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences();
    await services.recurrences.runForecast();

    // 3. Parcelamento no grupo (em conta e no cartão)
    await services.installments.createPlan({
      description: 'Notebook do grupo',
      mode: 'DIVIDE_TOTAL',
      totalCents: 30_00,
      totalInstallments: 3,
      firstDueDate: dayInMonth(cur, 5),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    await services.installments.createPlan({
      description: 'Celular do grupo',
      mode: 'DIVIDE_TOTAL',
      totalCents: 60_00,
      totalInstallments: 2,
      firstDueDate: dayInMonth(cur, 6),
      cardId,
      groupTransactionId: grupo!.id,
    });

    // 4. Compra à vista no cartão + pagamento de fatura (invoice_payments)
    await services.transactions.createCardExpense({
      description: 'Compra solta',
      amountCents: 40_00,
      cardId,
      date: dayInMonth(cur, 1),
    });
    const inv = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM invoices WHERE card_id = ? AND reference_month = ?',
      [cardId, cur]
    );
    expect(inv).not.toBeNull();
    await services.invoices.payInvoice({ invoiceId: inv!.id, fromAccountId: accId, amountCents: 30_00 });

    // 5. Receita parcelada (v14) + transferência + lançamento simples
    await services.installments.createPlan({
      description: 'Aluguel recebido',
      mode: 'DIVIDE_TOTAL',
      totalCents: 36_00,
      totalInstallments: 36,
      firstDueDate: dayInMonth(cur, 10),
      accountId: accId,
      type: 'INCOME',
    });
    await services.transactions.createTransfer({
      description: 'Reserva',
      amountCents: 10_00,
      date: todaySP(),
      fromAccountId: accId,
      toAccountId: acc2Id,
    });
    await services.transactions.createAccountExpense({
      description: 'Café', amountCents: 500, accountId: accId,
    });

    // Confere que o banco está PESADO de verdade
    const txBefore = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(txBefore!.n).toBeGreaterThan(6);

    // A LIMPEZA — tem de funcionar SEM "FOREIGN KEY constraint failed"
    await clearLancamentos(db);

    // Movimentações ZERADAS (todas as tabelas de movimento)
    for (const table of [
      'transactions', 'financial_moves', 'invoice_items', 'invoice_payments',
      'installments', 'installment_plans', 'invoices',
      'recurrence_rules', 'recurrence_exclusions', 'ofx_imports', 'ofx_statement_lines',
    ]) {
      const r = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(r?.n).toBe(0);
    }

    // Cadastros base INTOCADOS
    expect((await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM accounts'))?.n).toBe(2);
    expect((await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM cards'))?.n).toBe(1);
    expect((await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM categories'))?.n).toBeGreaterThanOrEqual(13);
    // Saldo volta ao inicial
    expect(await getAccountBalance(db, accId)).toBe(100_000);
  });

  test('a limpeza é IDEMPOTENTE (rodar 2x não quebra) e o Fluxo fica vazio depois', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Dupla', 0);
    await services.transactions.createConsolidatedGroup({
      description: 'Grupo p/ 2ª rodada',
      date: todaySP(),
      accountId: accId,
      lines: [{ direction: 'DEBIT', description: 'X', amountCents: 10_00, categoryId: null }],
    });
    await clearLancamentos(db);
    await clearLancamentos(db); // 2ª vez — nada a apagar, sem erro

    const rows = (await services.transactions.listFlow(monthOf(todaySP()))) as unknown as FlowTx[];
    expect(rows.length).toBe(0);
  });
});

/* ================================================================
 * BUG 2 — Consolidado > Receita (Crédito) > Parcelado
 * ================================================================ */
describe('Bug 2 — receita PARCELADA no consolidado (conta)', () => {
  test('ALUGUEL em 36x: grupo INCOME nasce, parcelas são CRÉDITOS futuros e o Fluxo mostra o grupo nos meses seguintes', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Aluguel', 0);
    const cur = monthOf(todaySP());

    // Cabeçalho-âncora de RECEITA (o formulário manda headerType=INCOME)
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Receita do imóvel',
      date: dayInMonth(cur, 1),
      lines: [],
      headerAmountCents: 108_000_00,
      headerType: 'INCOME',
    });
    expect(grupo).not.toBeNull();

    const { planId } = await services.installments.createPlan({
      description: 'Aluguel',
      mode: 'DIVIDE_TOTAL',
      totalCents: 108_000_00,
      totalInstallments: 36,
      firstDueDate: dayInMonth(cur, 10),
      accountId: accId,
      type: 'INCOME',
      groupTransactionId: grupo!.id,
    });
    const planRow = await db.getFirstAsync<{ account_id: string | null }>(
      'SELECT account_id FROM installment_plans WHERE id = ?', [planId]
    );
    expect(planRow?.account_id).toBe(accId);

    // Parcelas: 36x de 3000,00 — moves de CRÉDITO future-dated
    const moves = await db.getAllAsync<{ direction: string; amount_cents: number; effective_date: string }>(
      `SELECT fm.direction, fm.amount_cents, fm.effective_date FROM financial_moves fm
         JOIN installments i ON i.id = fm.installment_id
        WHERE i.plan_id = ? ORDER BY i.sequence_number LIMIT 2`, [planId]
    );
    expect(moves.length).toBe(2);
    expect(moves[0].direction).toBe('CREDIT');
    expect(moves[0].amount_cents).toBe(300_000);
    expect(moves[1].effective_date).toBe(dayInMonth(monthAdd(cur, 1), 10));

    // Fluxo no mês seguinte: o grupo APARECE com a parcela 2/36
    const next = monthAdd(cur, 1);
    const rowsNext = (await services.transactions.listFlow(next)) as unknown as FlowTx[];
    const aggNext = await buildGroupMonths(db, next, rowsNext);
    const grpNext = aggNext.gm[grupo!.id];
    expect(grpNext).toBeDefined();
    expect(grpNext.installments.length).toBe(1);
    expect(grpNext.installments[0].sequenceNumber).toBe(2);
    expect(grpNext.installments[0].type).toBe('INCOME');
    // Totais do mês: parcela de receita conta como CRÉDITO (não débito)
    const totals = groupMonthTotals(grpNext);
    expect(totals.credits).toBe(300_000);
    expect(totals.debits).toBe(0);

    // Na raiz: a parcela do grupo não aparece solta (fica dentro do card)
    expect(rootRows(rowsNext, aggNext.occIds).some((t) => t.source_system === 'INSTALLMENT')).toBe(false);

    // Status do grupo (receita): chip "Recebido/Não recebido" — isIncome
    const info = groupStatusInfo(grpNext, []);
    expect(info).not.toBeNull();
    expect(info!.isIncome).toBe(true);
    expect(info!.count).toBe(1);

    // A parcela do grupo NÃO aparece como parcela avulsa depois do filtro da tela
    const avulsas = (await services.installments.listAccountInstallmentsDueInMonth(next)) as unknown as InstAgg[];
    expect(avulsas.filter((i) => !aggNext.instIds.has(i.installmentId)).length).toBe(0);
  });

  test('OBRAS em 5x + saldo PREVISTO: a receita parcelada SOMA na previsão do dia', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Obras', 100_00);
    const cur = monthOf(todaySP());

    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Repasse de obras',
      date: dayInMonth(cur, 1),
      lines: [],
      headerAmountCents: 50_00,
      headerType: 'INCOME',
    });
    await services.installments.createPlan({
      description: 'Obras',
      mode: 'DIVIDE_TOTAL',
      totalCents: 50_00,
      totalInstallments: 5,
      firstDueDate: dayInMonth(cur, 15),
      accountId: accId,
      type: 'INCOME',
      groupTransactionId: grupo!.id,
    });

    // Previsão do último dia do mês: 100,00 inicial + 10,00 da 1ª parcela (não paga)
    const dual = await services.balance.getDailyBalancesDual(cur);
    const lastDay = Math.max(...Object.keys(dual.previsto).map((d) => parseInt(d.slice(8, 10), 10)));
    expect(dual.previsto[`${cur}-${String(lastDay).padStart(2, '0')}`]).toBe(110_00);
    // Efetivado NÃO conta a parcela pendente
    expect(dual.efetivado[`${cur}-${String(lastDay).padStart(2, '0')}`]).toBe(100_00);
  });

  test('toggle de status da parcela de receita: "Recebido" move o crédito para HOJE; "Não recebido" devolve ao vencimento', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Toggle Receita', 0);
    const cur = monthOf(todaySP());
    const { planId } = await services.installments.createPlan({
      description: 'Corretagem',
      mode: 'DIVIDE_TOTAL',
      totalCents: 288_00, // 36 × 8,00
      totalInstallments: 36,
      firstDueDate: dayInMonth(cur, 5),
      accountId: accId,
      type: 'INCOME',
    });
    const insts = await db.getAllAsync<{ id: string; due_date: string }>(
      'SELECT id, due_date FROM installments WHERE plan_id = ? ORDER BY sequence_number', [planId]
    );

    await services.installments.setPaymentStatus(insts[0].id, true);
    let move = await db.getFirstAsync<{ direction: string; effective_date: string; status: string }>(
      'SELECT direction, effective_date, status FROM financial_moves WHERE installment_id = ?', [insts[0].id]
    );
    expect(move?.direction).toBe('CREDIT');
    expect(move?.effective_date).toBe(todaySP());

    await services.installments.setPaymentStatus(insts[0].id, false);
    const move2 = await db.getFirstAsync<{ effective_date: string }>(
      'SELECT effective_date FROM financial_moves WHERE installment_id = ?', [insts[0].id]
    );
    expect(move2?.effective_date).toBe(insts[0].due_date);

    // Saldo: parcela marcada como recebida entra no saldo ATUAL (≤ hoje);
    // as demais continuam como previsão futura (fora do saldo atual)
    await services.installments.setPaymentStatus(insts[0].id, true);
    expect(await services.balance.getAccountBalance(accId)).toBe(800);
    // E na visão com TODOS os movimentos futuros (helper): 36 × 8,00
    expect(await getAccountBalance(db, accId)).toBe(288_00);
  });

  test('CORRETAGEM 36x NO CARTÃO: itens NEGATIVOS abatem o total da fatura de cada mês', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Corretagem Cartao', 0);
    const cardId = await seedCard(db, accId, 'Card Corretagem', 15, 10);
    const cur = monthOf(todaySP());

    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Corretagem no cartão',
      date: dayInMonth(cur, 1),
      lines: [],
      headerAmountCents: 36_00,
      headerType: 'INCOME',
    });
    const { planId } = await services.installments.createPlan({
      description: 'Corretagem',
      mode: 'DIVIDE_TOTAL',
      totalCents: 36_00,
      totalInstallments: 36,
      firstDueDate: dayInMonth(cur, 12),
      cardId,
      type: 'INCOME',
      groupTransactionId: grupo!.id,
    });

    // Fatura do mês: item NEGATIVO de 1,00 (abate)
    const inv = await db.getFirstAsync<{ total_cents: number }>(
      'SELECT total_cents FROM invoices WHERE card_id = ? AND reference_month = ?', [cardId, cur]
    );
    expect(inv).not.toBeNull();
    expect(inv!.total_cents).toBe(-100);

    // Com uma compra de 5,00 na mesma fatura, o total vira 4,00
    await services.transactions.createCardExpense({
      description: 'Compra', amountCents: 5_00, cardId, date: dayInMonth(cur, 2),
    });
    const inv2 = await db.getFirstAsync<{ total_cents: number }>(
      'SELECT total_cents FROM invoices WHERE card_id = ? AND reference_month = ?', [cardId, cur]
    );
    expect(inv2!.total_cents).toBe(400);

    // A conta NÃO é afetada (compra/receita de cartão só toca a conta na fatura)
    expect(await getAccountBalance(db, accId)).toBe(0);
    expect(planId).toBeTruthy();
  });

  test('receita parcelada editada a partir da atual mantém o item da fatura NEGATIVO', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Edit Receita', 0);
    const cardId = await seedCard(db, accId, 'Card Edit Receita', 15, 10);
    const cur = monthOf(todaySP());
    const { planId } = await services.installments.createPlan({
      description: 'Corretagem edit',
      mode: 'DIVIDE_TOTAL',
      totalCents: 20_00,
      totalInstallments: 4,
      firstDueDate: dayInMonth(cur, 10),
      cardId,
      type: 'INCOME',
    });
    await services.installments.updateFromCurrent(planId, { remainingTotalCents: 28_00 });
    const items = await db.getAllAsync<{ amount_cents: number }>(
      `SELECT ii.amount_cents FROM invoice_items ii
         JOIN installments i ON i.id = ii.installment_id
        WHERE i.plan_id = ? ORDER BY i.sequence_number`, [planId]
    );
    expect(items.length).toBe(4);
    for (const it of items) expect(it.amount_cents).toBe(-700);
  });
});

/* ================================================================
 * BUG 3 — parcelado normal NÃO cria "Consolidado" fantasma
 * ================================================================ */
describe('Bug 3 — nada de "Consolidado" fantasma ao criar parcelado normal', () => {
  test('parcelado em CONTA: o Fluxo mostra SÓ a parcela do mês — zero linhas CONSOLIDADO na raiz', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Parcelado Puro', 0);
    const cur = monthOf(todaySP());
    await services.installments.createPlan({
      description: 'Notebook avulso',
      mode: 'DIVIDE_TOTAL',
      totalCents: 30_00,
      totalInstallments: 3,
      firstDueDate: dayInMonth(cur, 8),
      accountId: accId,
    });

    const rows = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    // A âncora existe no banco (âncora de custo, uso interno)...
    const anchor = rows.find((t) => t.source_system === 'INSTALLMENT');
    expect(anchor).toBeDefined();
    expect(anchor!.kind).toBe('CONSOLIDATED'); // ...mas é ela o fantasma...
    // ...e o filtro da raiz (v14) a remove:
    const agg = await buildGroupMonths(db, cur, rows);
    const raiz = rootRows(rows, agg.occIds);
    expect(raiz.some((t) => t.kind === 'CONSOLIDATED')).toBe(false);
    expect(raiz.some((t) => t.source_system === 'INSTALLMENT')).toBe(false);

    // O parcelado aparece UMA vez: como parcela em conta do mês
    const instRows = (await services.installments.listAccountInstallmentsDueInMonth(cur)) as unknown as InstAgg[];
    expect(instRows.length).toBe(1);
    expect(instRows[0].sequenceNumber).toBe(1);
    expect(instRows[0].type).toBe('EXPENSE');

    // Nenhum grupo consolidado falso é agregado
    expect(Object.keys(agg.gm).length).toBe(0);
  });

  test('parcelado no CARTÃO: nada na raiz (segue na fatura) — como já era', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Parcelado Cartao', 0);
    const cardId = await seedCard(db, accId, 'Card Puro', 15, 10);
    const cur = monthOf(todaySP());
    await services.installments.createPlan({
      description: 'Celular avulso',
      mode: 'DIVIDE_TOTAL',
      totalCents: 20_00,
      totalInstallments: 2,
      firstDueDate: dayInMonth(cur, 9),
      cardId,
    });
    const rows = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const agg = await buildGroupMonths(db, cur, rows);
    expect(rootRows(rows, agg.occIds).length).toBe(0);
    expect(Object.keys(agg.gm).length).toBe(0);
    const instRows = await services.installments.listAccountInstallmentsDueInMonth(cur);
    expect(instRows.length).toBe(0); // parcela de cartão não é parcela em conta
  });

  test('parcelado DENTRO de grupo consolidado: a âncora não duplica nem vira grupo falso', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Grupo Fantasma', 0);
    const cur = monthOf(todaySP());
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Operação com parcelado',
      date: dayInMonth(cur, 1),
      accountId: accId,
      lines: [],
      headerAmountCents: 30_00,
      headerType: 'EXPENSE',
    });
    await services.installments.createPlan({
      description: 'Notebook do grupo',
      mode: 'DIVIDE_TOTAL',
      totalCents: 30_00,
      totalInstallments: 3,
      firstDueDate: dayInMonth(cur, 8),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    const rows = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const agg = await buildGroupMonths(db, cur, rows);
    // EXATAMENTE 1 grupo (o de verdade) — a âncora não vira grupo nem item da raiz
    expect(Object.keys(agg.gm).length).toBe(1);
    expect(agg.gm[grupo!.id]).toBeDefined();
    const raiz = rootRows(rows, agg.occIds);
    expect(raiz.some((t) => t.source_system === 'INSTALLMENT')).toBe(false);
    expect(agg.gm[grupo!.id].installments.length).toBe(1);
  });

  test('mês SEGUINTE do parcelado avulso: só a parcela 2/3, nenhum fantasma', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Fantasma Prox', 0);
    const cur = monthOf(todaySP());
    await services.installments.createPlan({
      description: 'Notebook avulso 2',
      mode: 'DIVIDE_TOTAL',
      totalCents: 30_00,
      totalInstallments: 3,
      firstDueDate: dayInMonth(cur, 8),
      accountId: accId,
    });
    const next = monthAdd(cur, 1);
    const rowsNext = (await services.transactions.listFlow(next)) as unknown as FlowTx[];
    const aggNext = await buildGroupMonths(db, next, rowsNext);
    expect(Object.keys(aggNext.gm).length).toBe(0);
    const raiz = rootRows(rowsNext, aggNext.occIds);
    expect(raiz.some((t) => t.kind === 'CONSOLIDATED')).toBe(false);
    const instNext = (await services.installments.listAccountInstallmentsDueInMonth(next)) as unknown as InstAgg[];
    expect(instNext.length).toBe(1);
    expect(instNext[0].sequenceNumber).toBe(2);
  });
});

/* ================================================================
 * BUG 4 + MELHORIA 1 — layout unificado (dados que o card único exibe)
 * ================================================================ */
describe('Bug 4 / Melhoria 1 — padrão único de exibição no Fluxo (dados)', () => {
  test('todo card não-cartão expõe o MESMO conjunto de informações (descrição, data, tipo, status, conta, categoria, pill)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Padrao', 0);
    const cur = monthOf(todaySP());

    // 1) lançamento comum  2) ocorrência de fixa  3) parcela em conta avulsa  4) grupo
    // (dia 1: conta fixa JÁ venceu — a ocorrência do mês nasce efetivada)
    await services.transactions.createAccountExpense({
      description: 'Mercado comum', amountCents: 10_00, accountId: accId, date: dayInMonth(cur, 1), categoryId: null,
    });
    await services.recurrences.createRule({
      description: 'Água', type: 'EXPENSE', amountCents: 5_00, dayOfMonth: 1,
      startDate: dayInMonth(cur, 1), accountId: accId,
    });
    await services.recurrences.runDueRecurrences();
    await services.installments.createPlan({
      description: 'Notebook padrão', mode: 'DIVIDE_TOTAL', totalCents: 20_00,
      totalInstallments: 2, firstDueDate: dayInMonth(cur, 3), accountId: accId,
    });
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Grupo padrão', date: dayInMonth(cur, 1), accountId: accId,
      lines: [], headerAmountCents: 7_00, headerType: 'EXPENSE',
    });
    await services.recurrences.createRule({
      description: 'Luz do grupo', type: 'EXPENSE', amountCents: 7_00, dayOfMonth: 1,
      startDate: dayInMonth(cur, 1), accountId: accId, groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences();

    const rows = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const agg = await buildGroupMonths(db, cur, rows);

    // (1) comum — campos do card unificado presentes
    const comum = rows.find((t) => t.description === 'Mercado comum')!;
    expect(comum.occurred_on).toBe(dayInMonth(cur, 1));
    expect(comum.status).toBe('CONFIRMED');
    expect(comum.account_name).toBe('Conta Padrao');
    expect(comum.type).toBe('EXPENSE');

    // (2) ocorrência de fixa — MESMOS campos (ela entra no card do grupo ou na raiz)
    const ocorr = rows.find((t) => t.description === 'Água')!;
    expect(ocorr.occurred_on).toBe(dayInMonth(cur, 1));
    expect(ocorr.account_name).toBe('Conta Padrao');
    expect(ocorr.source_system).toBe('RECURRENCE');

    // (3) parcela em conta — MESMOS campos (type + accountName p/ o card único)
    const inst = (await services.installments.listAccountInstallmentsDueInMonth(cur)) as unknown as InstAgg[];
    expect(inst[0].dueDate).toBe(dayInMonth(cur, 3));
    expect(inst[0].status).toBe('PENDING');
    expect(inst[0].type).toBe('EXPENSE');
    expect(inst[0].accountName).toBe('Conta Padrao');
    expect(inst[0].totalInstallments).toBe(2);

    // (4) grupo — mesmo modelo de mês (GroupMonth) e status pelo cabeçalho
    const grp = agg.gm[grupo!.id];
    expect(grp.header.description).toBe('Grupo padrão');
    expect(grp.header.occurred_on).toBe(dayInMonth(cur, 1));
    expect(grp.occurrences.length).toBe(1);
    expect(groupStatusInfo(grp, agg.childrenByGroup[grupo!.id] ?? [])).not.toBeNull();
  });

  test('consolidado FIXO e PARCELADO seguem o MESMO modelo (mesmo GroupMonth, mesmos totais, mesmo chip)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Subtipos', 0);
    const cur = monthOf(todaySP());

    const gFixo = await services.transactions.createConsolidatedGroup({
      description: 'Grupo com fixa', date: dayInMonth(cur, 1), accountId: accId,
      lines: [], headerAmountCents: 12_00, headerType: 'EXPENSE',
    });
    await services.recurrences.createRule({
      description: 'Fixa do grupo', type: 'EXPENSE', amountCents: 12_00, dayOfMonth: 1,
      startDate: dayInMonth(cur, 1), accountId: accId, groupTransactionId: gFixo!.id,
    });

    const gParc = await services.transactions.createConsolidatedGroup({
      description: 'Grupo com parcelado', date: dayInMonth(cur, 1), accountId: accId,
      lines: [], headerAmountCents: 24_00, headerType: 'EXPENSE',
    });
    await services.installments.createPlan({
      description: 'Parcelado do grupo', mode: 'DIVIDE_TOTAL', totalCents: 24_00,
      totalInstallments: 2, firstDueDate: dayInMonth(cur, 1), accountId: accId,
      groupTransactionId: gParc!.id,
    });
    await services.recurrences.runDueRecurrences();
    await services.recurrences.runForecast(); // previsão da fixa no mês seguinte

    const rows = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const agg = await buildGroupMonths(db, cur, rows);
    const fixo = agg.gm[gFixo!.id];
    const parc = agg.gm[gParc!.id];

    // MESMA estrutura de dados para os dois subtipos
    expect(Object.keys(fixo).sort()).toEqual(Object.keys(parc).sort());
    expect(fixo.isHeaderMonth).toBe(parc.isHeaderMonth);
    expect(fixo.occurrences.length).toBe(1);
    expect(parc.installments.length).toBe(1);
    // MESMOS totais proporcionais ao conteúdo do mês: fixa 12; parcelado = 1ª
    // parcela do mês (24/2 = 12) — a 2ª é no mês seguinte
    expect(groupMonthTotals(fixo).debits).toBe(12_00);
    expect(groupMonthTotals(parc).debits).toBe(12_00);
    // No mês seguinte o parcelado mostra a 2ª parcela (12) e a fixa a ocorrência (12)
    const rowsNext = (await services.transactions.listFlow(monthAdd(cur, 1))) as unknown as FlowTx[];
    const aggNext = await buildGroupMonths(db, monthAdd(cur, 1), rowsNext);
    expect(groupMonthTotals(aggNext.gm[gFixo!.id]).debits).toBe(12_00);
    expect(groupMonthTotals(aggNext.gm[gParc!.id]).debits).toBe(12_00);
    // MESMO chip de status (despesa → Pago/Não pago)
    const infoFixo = groupStatusInfo(fixo, []);
    const infoParc = groupStatusInfo(parc, []);
    expect(infoFixo!.isIncome).toBe(false);
    expect(infoParc!.isIncome).toBe(false);
    expect(infoFixo!.count).toBe(1);
    expect(infoParc!.count).toBe(1);
  });

  test('grupo MISTO (fixa de despesa + receita parcelada): totais separam débito/crédito e saldo é líquido', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Misto', 0);
    const cur = monthOf(todaySP());
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Condomínio + repasses', date: dayInMonth(cur, 1), accountId: accId,
      lines: [], headerAmountCents: 30_00, headerType: 'EXPENSE',
    });
    await services.recurrences.createRule({
      description: 'Taxa', type: 'EXPENSE', amountCents: 30_00, dayOfMonth: 1,
      startDate: dayInMonth(cur, 1), accountId: accId, groupTransactionId: grupo!.id,
    });
    await services.installments.createPlan({
      description: 'Repasse', mode: 'DIVIDE_TOTAL', totalCents: 45_00,
      totalInstallments: 3, firstDueDate: dayInMonth(cur, 1), accountId: accId,
      type: 'INCOME', groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences();

    const rows = (await services.transactions.listFlow(cur)) as unknown as FlowTx[];
    const agg = await buildGroupMonths(db, cur, rows);
    const totals = groupMonthTotals(agg.gm[grupo!.id]);
    expect(totals.debits).toBe(30_00);
    expect(totals.credits).toBe(15_00);
  });
});

/* ================================================================
 * CENÁRIOS DE FUTURO — como cada lançamento se reflete nos meses seguintes
 * ================================================================ */
describe('Reflexão no FUTURO — todos os tipos de lançamento', () => {
  test('à vista em conta: SÓ no mês da compra (não se repete)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Fut Avulso', 0);
    const cur = monthOf(todaySP());
    await services.transactions.createAccountExpense({
      description: 'Compra única', amountCents: 10_00, accountId: accId, date: dayInMonth(cur, 5),
    });
    for (let i = 1; i <= 3; i++) {
      const rows = (await services.transactions.listFlow(monthAdd(cur, i))) as unknown as FlowTx[];
      expect(rows.length).toBe(0);
    }
  });

  test('fixa em conta: mês atual efetivado + previsões PENDING nos próximos (perpétua)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Fut Fixa', 0);
    const cur = monthOf(todaySP());
    await services.recurrences.createRule({
      description: 'Streaming', type: 'EXPENSE', amountCents: 20_00, dayOfMonth: 7,
      startDate: dayInMonth(cur, 7), accountId: accId,
    });
    await services.recurrences.runDueRecurrences();
    await services.recurrences.runForecast();
    const next2 = monthAdd(cur, 2);
    const rows = (await services.transactions.listFlow(next2)) as unknown as FlowTx[];
    const occ = rows.find((t) => t.description === 'Streaming');
    expect(occ).toBeDefined();
    expect(occ!.status).toBe('PENDING');
  });

  test('parcelado em conta 3x: aparece em 3 meses e NÃO no 4º (finito)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Fut Parcelado', 0);
    const cur = monthOf(todaySP());
    await services.installments.createPlan({
      description: 'Compra 3x', mode: 'DIVIDE_TOTAL', totalCents: 30_00,
      totalInstallments: 3, firstDueDate: dayInMonth(cur, 10), accountId: accId,
    });
    for (let i = 0; i < 3; i++) {
      const insts = (await services.installments.listAccountInstallmentsDueInMonth(
        monthAdd(cur, i)
      )) as unknown as InstAgg[];
      expect(insts.length).toBe(1);
      expect(insts[0].sequenceNumber).toBe(i + 1);
    }
    const after = await services.installments.listAccountInstallmentsDueInMonth(monthAdd(cur, 3));
    expect(after.length).toBe(0);
  });

  test('consolidado com fixa + parcelado: grupo visível enquanto HÁ conteúdo nos meses seguintes, com itens exatos', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Fut Grupo', 0);
    const cur = monthOf(todaySP());
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Operação futura', date: dayInMonth(cur, 1), accountId: accId,
      lines: [], headerAmountCents: 10_00, headerType: 'EXPENSE',
    });
    await services.recurrences.createRule({
      description: 'Fixa futura', type: 'EXPENSE', amountCents: 10_00, dayOfMonth: 1,
      startDate: dayInMonth(cur, 1), accountId: accId, groupTransactionId: grupo!.id,
    });
    await services.installments.createPlan({
      description: 'Parcelado futuro', mode: 'DIVIDE_TOTAL', totalCents: 20_00,
      totalInstallments: 2, firstDueDate: dayInMonth(cur, 1), accountId: accId,
      groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences();
    await services.recurrences.runForecast();

    // Mês 1: fixa + 2ª parcela; mês 2: só a fixa (parcelado 2x acabou); mês 3: só a fixa
    for (const [i, occN, instN, debits] of [
      [1, 1, 1, 20_00],
      [2, 1, 0, 10_00],
    ] as const) {
      const rows = (await services.transactions.listFlow(monthAdd(cur, i))) as unknown as FlowTx[];
      const agg = await buildGroupMonths(db, monthAdd(cur, i), rows);
      const grp = agg.gm[grupo!.id];
      expect(grp).toBeDefined();
      expect(grp.occurrences.length).toBe(occN);
      expect(grp.installments.length).toBe(instN);
      expect(groupMonthTotals(grp).debits).toBe(debits);
    }
    // Mês 3: só a fixa (parcelado acabou) — o grupo continua, com 1 item
    const rows3 = (await services.transactions.listFlow(monthAdd(cur, 3))) as unknown as FlowTx[];
    const agg3 = await buildGroupMonths(db, monthAdd(cur, 3), rows3);
    expect(agg3.gm[grupo!.id]).toBeDefined();
    expect(agg3.gm[grupo!.id].occurrences.length).toBe(1);
    expect(agg3.gm[grupo!.id].installments.length).toBe(0);
    expect(groupMonthTotals(agg3.gm[grupo!.id]).debits).toBe(10_00);
  });
  test('receita parcelada 36x no consolidado: grupo de RECEITA aparece com parcela de crédito em todos os 36 ciclos', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Fut Receita 36x', 0);
    const cur = monthOf(todaySP());
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Aluguel 36 meses', date: dayInMonth(cur, 1), accountId: accId,
      lines: [], headerAmountCents: 36_00, headerType: 'INCOME',
    });
    await services.installments.createPlan({
      description: 'Aluguel', mode: 'DIVIDE_TOTAL', totalCents: 36_00,
      totalInstallments: 36, firstDueDate: dayInMonth(cur, 10), accountId: accId,
      type: 'INCOME', groupTransactionId: grupo!.id,
    });
    // Amostragem: mês 1, 12, 24 e 36 têm parcela; mês 37 não
    for (const i of [0, 11, 23, 35]) {
      const rows = (await services.transactions.listFlow(monthAdd(cur, i))) as unknown as FlowTx[];
      const agg = await buildGroupMonths(db, monthAdd(cur, i), rows);
      const grp = agg.gm[grupo!.id];
      expect(grp).toBeDefined();
      expect(grp.installments.length).toBe(1);
      expect(grp.installments[0].sequenceNumber).toBe(i + 1);
      expect(grp.installments[0].type).toBe('INCOME');
      expect(groupMonthTotals(grp).credits).toBe(100);
      expect(groupMonthTotals(grp).debits).toBe(0);
      // Parcela do grupo não vaza para a raiz de parcelas avulsas (filtro da tela)
      const avulsas = (await services.installments.listAccountInstallmentsDueInMonth(
        monthAdd(cur, i)
      )) as unknown as InstAgg[];
      expect(avulsas.filter((x) => !agg.instIds.has(x.installmentId)).length).toBe(0);
    }
    const rows37 = (await services.transactions.listFlow(monthAdd(cur, 36))) as unknown as FlowTx[];
    const agg37 = await buildGroupMonths(db, monthAdd(cur, 36), rows37);
    expect(agg37.gm[grupo!.id]).toBeUndefined();
  });

  test('excluir o grupo com receita parcelada: parcelas futuras e créditos somem; pagas ficam como histórico', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Fut Exclusao', 0);
    const cur = monthOf(todaySP());
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Receita p/ excluir', date: dayInMonth(cur, 1), accountId: accId,
      lines: [], headerAmountCents: 30_00, headerType: 'INCOME',
    });
    const { planId } = await services.installments.createPlan({
      description: 'Repasse 3x', mode: 'DIVIDE_TOTAL', totalCents: 30_00,
      totalInstallments: 3, firstDueDate: dayInMonth(cur, 1), accountId: accId,
      type: 'INCOME', groupTransactionId: grupo!.id,
    });
    const insts = await db.getAllAsync<{ id: string }>(
      'SELECT id FROM installments WHERE plan_id = ? ORDER BY sequence_number', [planId]
    );
    await services.installments.setPaymentStatus(insts[0].id, true); // 1ª recebida

    await services.transactions.deleteGroupDeep(grupo!.id);

    // Cabeçalho sai; parcelas em aberto somem; a recebida fica como histórico
    expect(await db.getFirstAsync('SELECT id FROM transactions WHERE id = ?', [grupo!.id])).toBeNull();
    const remaining = await db.getFirstAsync<{ n: number; paid: number }>(
      "SELECT COUNT(*) AS n, SUM(CASE WHEN status='PAID' THEN 1 ELSE 0 END) AS paid FROM installments WHERE plan_id = ?",
      [planId]
    );
    expect(remaining?.n).toBe(1);
    expect(remaining?.paid).toBe(1);
    // Saldo conserva a 1ª parcela recebida (crédito de 10,00)
    expect(await getAccountBalance(db, accId)).toBe(10_00);
    // Grupo não aparece mais no mês seguinte
    const rowsNext = (await services.transactions.listFlow(monthAdd(cur, 1))) as unknown as FlowTx[];
    const aggNext = await buildGroupMonths(db, monthAdd(cur, 1), rowsNext);
    expect(aggNext.gm[grupo!.id]).toBeUndefined();
  });
});

/* ================================================================
 * MELHORIA 2 — marcador de tela (campo "Conta do grupo")
 * ================================================================ */
describe('Melhoria 2 — campo do consolidado no Novo Lançamento', () => {
  test('o rótulo é exatamente "Conta do grupo" (sem o sufixo longo antigo)', async () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'lancamento.tsx'), 'utf8');
    expect(src).toContain('Conta do grupo`');
    expect(src).not.toContain('Conta do grupo (linhas À vista e Fixo/Parcelado em conta)');
    expect(src).not.toContain('Conta do grupo (linha à vista');
    // Bug 2: o bloqueio antigo de parcelado na direção Crédito saiu do formulário
    expect(src).not.toContain('parcelado é uma COMPRA: use a direção Débito');
  });
});
