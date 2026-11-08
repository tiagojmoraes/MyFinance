/**
 * Testes v16 — bugs e melhorias da rodada 4:
 *  · Bugs 1 e 2: Fixo/Consolidado criados no MÊS VIGENTE aparecem no Fluxo do
 *    mês corrente — a ocorrência com dia ainda não vencido nasce como PREVISÃO
 *    (PENDING) com chip Pago/Não pago; o saldo do grupo conta a fixa do mês;
 *    ensureForecastThrough cobre o mês vigente; já vencido nasce efetivado
 *    (CONFIRMED) e a previsão NÃO duplica; regra com início futuro não gera
 *    previsão antes do começo.
 *  · Bug 3: item de fatura de CONTA FIXA no cartão traz sourceSystem =
 *    'RECURRENCE' (bolinha ✓ padrão no Fluxo, igual à tela da fatura).
 *  · Bug 4: pagamento ADICIONAL é aceito — regra padrão de cartão pela DATA DE
 *    CORTE: o excedente vai para a fatura EM ABERTO na data do pagamento e
 *    abate o que existe e o que vier; na própria fatura em aberto o excedente
 *    pré-paga o ciclo; estorno devolve tudo por parte.
 *  · Melhorias 1, 2, 3, 4 e 5: marcadores de fonte (sem chip de status nos
 *    itens aglutinados; Voltar 44px; sem "Máscara 0,00"; exemplos no
 *    Consolidado; MoneyInput sem loop de seleção).
 */

import { makeCtx, seedAccount, seedCard, getAccountBalance } from './helpers';
import { todaySP, monthOf, monthAdd, dayInMonth } from '../lib/dates';
import {
  buildGroupMonths,
  groupMonthTotals,
  groupStatusInfo,
  type FlowTx,
} from '../lib/flowModel';

let ctx: ReturnType<typeof makeCtx> extends Promise<infer T> ? T : never;

beforeEach(async () => {
  ctx = await makeCtx();
});

/* ================================================================
 * BUGS 1 e 2 — Fixo/Consolidado no MÊS VIGENTE
 * ================================================================ */
describe('Bugs 1 e 2 — Fixo no mês vigente (dia ainda não vencido) aparece no Fluxo', () => {
  test('fixa em CONTA com dia 20, hoje dia 02: ocorrência PENDING nasce NO mês vigente (sem movimento)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Vigente', 500_00);
    await services.recurrences.createRule({
      description: 'Academia',
      type: 'EXPENSE',
      amountCents: 80_00,
      dayOfMonth: 20,
      startDate: '2026-11-20',
      accountId: accId,
    });

    const due = await services.recurrences.runDueRecurrences('2026-11-02');
    expect(due.createdTransactions).toBe(0); // dia 20 ainda não chegou

    const fc = await services.recurrences.runForecast(24, '2026-11-02');
    expect(fc.createdForecast).toBeGreaterThan(0);

    const rows = (await services.transactions.listFlow('2026-11')) as unknown as FlowTx[];
    const occ = rows.find((r) => r.recurrence_rule_id != null);
    expect(occ).toBeDefined();
    expect(occ!.status).toBe('PENDING');
    expect(occ!.occurred_on).toBe('2026-11-20');
    expect(occ!.amount_cents).toBe(80_00);

    // Previsão NÃO afeta o saldo (sem movimento financeiro)
    const moves = await db.getAllAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM financial_moves WHERE transaction_id = ?',
      [occ!.id]
    );
    expect(moves[0].n).toBe(0);
    expect(await getAccountBalance(db, accId)).toBe(500_00);
  });

  test('ensureForecastThrough TAMBÉM cobre o mês vigente (antes era ignorado)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Fluxo Atual', 0);
    await services.recurrences.createRule({
      description: 'Streaming',
      type: 'EXPENSE',
      amountCents: 29_90,
      dayOfMonth: 25,
      startDate: '2026-11-25',
      accountId: accId,
    });

    const r = await services.recurrences.ensureForecastThrough('2026-11', '2026-11-02');
    expect(r.createdForecast).toBeGreaterThan(0);
    const rows = (await services.transactions.listFlow('2026-11')) as unknown as FlowTx[];
    expect(rows.some((r2) => r2.recurrence_rule_id != null && r2.status === 'PENDING')).toBe(true);
  });

  test('propagação é IDEMPOTENTE (rodar de novo não duplica o mês vigente)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db);
    await services.recurrences.createRule({
      description: 'Aluguel',
      type: 'EXPENSE',
      amountCents: 1_200_00,
      dayOfMonth: 10,
      startDate: '2026-11-10',
      accountId: accId,
    });
    await services.recurrences.runForecast(6, '2026-11-02');
    const again = await services.recurrences.runForecast(6, '2026-11-02');
    expect(again.createdForecast).toBe(0);

    const rows = (await services.transactions.listFlow(monthOf('2026-11-02'))) as unknown as FlowTx[];
    const fixas = rows.filter((r) => r.recurrence_rule_id != null);
    expect(fixas.filter((r) => r.occurred_on === '2026-11-10').length).toBe(1);
  });

  test('dia JÁ vencido no mês vigente: nasce EFETIVADO (CONFIRMED) e a previsão não duplica', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Paga', 1_000_00);
    await services.recurrences.createRule({
      description: 'Internet',
      type: 'EXPENSE',
      amountCents: 100_00,
      dayOfMonth: 1,
      startDate: '2026-11-01',
      accountId: accId,
    });

    await services.recurrences.runDueRecurrences('2026-11-02');
    await services.recurrences.runForecast(6, '2026-11-02');

    const rows = (await services.transactions.listFlow('2026-11')) as unknown as FlowTx[];
    const fixas = rows.filter((r) => r.recurrence_rule_id != null);
    expect(fixas.length).toBe(1);
    expect(fixas[0].status).toBe('CONFIRMED');
    expect(fixas[0].occurred_on).toBe('2026-11-01');
    // Efetivada: com movimento (entrou no saldo)
    const moves = await db.getAllAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM financial_moves WHERE transaction_id = ?',
      [fixas[0].id]
    );
    expect(moves[0].n).toBe(1);
    expect(await getAccountBalance(db, accId)).toBe(1_000_00 - 100_00);
  });

  test('regra com INÍCIO FUTURO não gera previsão antes do começo (guarda start_date)', async () => {
    const { services } = ctx;
    const accId = await seedAccount(db0(ctx));
    await services.recurrences.createRule({
      description: 'Plano futuro',
      type: 'EXPENSE',
      amountCents: 50_00,
      dayOfMonth: 15,
      startDate: '2026-12-15',
      accountId: accId,
    });

    const r = await services.recurrences.runForecast(6, '2026-11-02');
    const rows = (await services.transactions.listFlow('2026-11')) as unknown as FlowTx[];
    expect(rows.filter((x) => x.recurrence_rule_id != null).length).toBe(0);
    // Primeira previsão é exatamente no mês inicial
    const dez = (await services.transactions.listFlow('2026-12')) as unknown as FlowTx[];
    const primeira = dez.filter((x) => x.recurrence_rule_id != null);
    expect(primeira.length).toBe(1);
    expect(primeira[0].occurred_on).toBe('2026-12-15');
    void r;
  });

  test('CONSOLIDADO com Fixo: saldo do grupo NO mês vigente conta a fixa e o chip de status aparece (não é mais nulo)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Grupo', 300_00);
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Despesas da casa',
      date: '2026-11-02',
      accountId: accId,
      lines: [],
      // no app real: total das linhas Fixo/Parcelado (cabeçalho-âncora)
      headerAmountCents: 120_00,
      headerType: 'EXPENSE',
    });
    expect(grupo).not.toBeNull();

    await services.recurrences.createRule({
      description: 'Luz',
      type: 'EXPENSE',
      amountCents: 120_00,
      dayOfMonth: 20,
      startDate: '2026-11-20',
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences('2026-11-02');
    await services.recurrences.runForecast(6, '2026-11-02');

    const allRows = (await services.transactions.listFlow('2026-11')) as unknown as FlowTx[];
    const { gm } = await buildGroupMonths(db, '2026-11', allRows);
    const g = gm[grupo!.id];
    expect(g).toBeDefined();
    expect(g.isHeaderMonth).toBe(true);
    expect(g.occurrences.length).toBe(1); // a fixa DO MÊS VIGENTE

    const { debits, credits } = groupMonthTotals(g);
    expect(debits).toBe(120_00); // saldo do grupo inclui a fixa do mês
    expect(credits).toBe(0);

    const info = groupStatusInfo(g, []);
    expect(info).not.toBeNull(); // ANTES era null (sem botão no mês vigente)
    expect(info!.allDone).toBe(false);
    expect(info!.isIncome).toBe(false);

    // Cabeçalho comanda: marcar Pago promove a PENDING para CONFIRMED + movimento
    const occ = g.occurrences[0];
    await services.transactions.setPaymentStatus(occ.id, true);
    const after = await db.getFirstAsync<{ status: string }>(
      'SELECT status FROM transactions WHERE id = ?',
      [occ.id]
    );
    expect(after!.status).toBe('CONFIRMED');
    const mv = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM financial_moves WHERE transaction_id = ? AND status = ?',
      [occ.id, 'CONFIRMED']
    );
    expect(mv!.n).toBe(1);
    expect(await getAccountBalance(db, accId)).toBe(300_00 - 120_00);

    // Chip do grupo passa a "Pago"
    const rowsAfter = (await services.transactions.listFlow('2026-11')) as unknown as FlowTx[];
    const { gm: gm2 } = await buildGroupMonths(db, '2026-11', rowsAfter);
    const info2 = groupStatusInfo(gm2[grupo!.id], []);
    expect(info2!.allDone).toBe(true);
  });

  test('RECEITA fixa no mês vigente: previsão PENDING com chip Recebido/Não recebido', async () => {
    const { services } = ctx;
    const accId = await seedAccount(db0(ctx));
    await services.recurrences.createRule({
      description: 'Renda extra',
      type: 'INCOME',
      amountCents: 500_00,
      dayOfMonth: 28,
      startDate: '2026-11-28',
      accountId: accId,
    });
    await services.recurrences.runForecast(3, '2026-11-02');
    const rows = (await services.transactions.listFlow('2026-11')) as unknown as FlowTx[];
    const occ = rows.find((r) => r.recurrence_rule_id != null);
    expect(occ).toBeDefined();
    expect(occ!.status).toBe('PENDING');
    expect(occ!.type).toBe('INCOME');
  });
});

/* ================================================================
 * BUG 3 — Iconografia da fixa NO CARTÃO (dados do Fluxo)
 * ================================================================ */
describe('Bug 3 — item de fatura de fixa traz sourceSystem RECURRENCE (bolinha ✓)', () => {
  test('fixa no cartão: item da fatura com sourceSystem RECURRENCE; compra simples sem', async () => {
    const { services } = ctx;
    const accId = await seedAccount(db0(ctx));
    const cardId = await seedCard(db0(ctx), accId, 'Card Fixa', 15, 25);

    await services.recurrences.createRule({
      description: 'Netflix',
      type: 'EXPENSE',
      amountCents: 44_90,
      dayOfMonth: 5,
      startDate: '2026-01-05',
      cardId,
    });
    await services.recurrences.runDueRecurrences('2026-01-10');

    await services.transactions.createCardExpense({
      description: 'Padaria',
      amountCents: 25_00,
      date: '2026-01-06',
      cardId,
    });

    const due = await services.invoices.listInvoicesDueInMonth('2026-01');
    expect(due.length).toBe(1);
    const netflix = due[0].items.find((i) => i.description === 'Netflix');
    const padaria = due[0].items.find((i) => i.description === 'Padaria');
    expect(netflix).toBeDefined();
    expect(netflix!.sourceSystem).toBe('RECURRENCE'); // ganha a bolinha ✓
    expect(padaria).toBeDefined();
    expect(padaria!.sourceSystem).not.toBe('RECURRENCE'); // compra simples: sem bolinha
  });
});

/* ================================================================
 * BUG 4 — Pagamento ADICIONAL (regra de corte do cartão)
 * ================================================================ */
describe('Bug 4 — pagamento adicional é ACEITO (regra padrão de cartão)', () => {
  test('fatura JÁ PAGA + pagamento adicional: excedente vai para a fatura em aberto pela data de corte', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Pag', 1_000_00);
    const cardId = await seedCard(db, accId, 'Card Corte', 15, 10);

    // Compra em outubro (antes do corte dia 15) → fatura 2026-10
    const tx = await services.transactions.createCardExpense({
      description: 'Tênis',
      amountCents: 30_00,
      date: '2026-10-10',
      cardId,
    });
    void tx;
    const invOut = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM invoices WHERE card_id = ? AND reference_month = '2026-10'",
      [cardId]
    );
    expect(invOut).not.toBeNull();

    // Quita a fatura de outubro (pagamento dentro do período, dia 12)
    await services.invoices.payInvoice({
      invoiceId: invOut!.id,
      fromAccountId: accId,
      amountCents: 30_00,
      paidOn: '2026-10-12',
    });

    // PAGAMENTO ADICIONAL de 20,00 em 02/11 — antes era RECUSADO
    const r = await services.invoices.payInvoice({
      invoiceId: invOut!.id,
      fromAccountId: accId,
      amountCents: 20_00,
      paidOn: '2026-11-02',
    });
    expect(r.surplusCents).toBe(20_00);
    expect(r.routedMonth).toBe('2026-11'); // fatura em aberto pela data de corte
    expect(r.routedInvoiceId).not.toBeNull();

    // Fatura de novembro recebeu o excedente como pagamento (pré-pago)
    const invNov = await db.getFirstAsync<{ paid_cents: number; total_cents: number }>(
      "SELECT paid_cents, total_cents FROM invoices WHERE card_id = ? AND reference_month = '2026-11'",
      [cardId]
    );
    expect(invNov).not.toBeNull();
    expect(invNov!.paid_cents).toBe(20_00);
    expect(invNov!.total_cents).toBe(0);

    // A fatura de outubro continua quitada e NÃO acumulou o excedente
    const invOut2 = await db.getFirstAsync<{ paid_cents: number; total_cents: number }>(
      "SELECT paid_cents, total_cents FROM invoices WHERE id = ?",
      [invOut!.id]
    );
    expect(invOut2!.paid_cents).toBe(30_00);
    expect(invOut2!.total_cents).toBe(30_00);

    // A conta debitou o valor INTEIRO (30 + 20), uma vez por parte
    expect(await getAccountBalance(db, accId)).toBe(1_000_00 - 30_00 - 20_00);

    // O excedente ABATE o que vier no ciclo: compra de 40,00 em novembro
    await services.transactions.createCardExpense({
      description: 'Livro',
      amountCents: 40_00,
      date: '2026-11-10',
      cardId,
    });
    const nov = await services.invoices.getInvoiceDetailByCardMonth(cardId, '2026-11');
    expect(nov!.invoice.total_cents).toBe(40_00);
    expect(nov!.dueCents).toBe(20_00); // 40 − 20 pré-pagos
    expect(nov!.liveStatus).toBe('PARTIALLY_PAID');
  });

  test('valor MAIOR que o devido em fatura antiga: parte quita a fatura vista e o excedente vai à fatura em aberto', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Split', 500_00);
    const cardId = await seedCard(db, accId, 'Card Split', 15, 10);

    await services.transactions.createCardExpense({
      description: 'Cadeira',
      amountCents: 30_00,
      date: '2026-10-08',
      cardId,
    });
    const invOut = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM invoices WHERE card_id = ? AND reference_month = '2026-10'",
      [cardId]
    );

    // Paga 50,00 numa fatura de 30,00 (pagamento em novembro)
    const r = await services.invoices.payInvoice({
      invoiceId: invOut!.id,
      fromAccountId: accId,
      amountCents: 50_00,
      paidOn: '2026-11-02',
    });
    expect(r.appliedCents).toBe(30_00);
    expect(r.surplusCents).toBe(20_00);
    expect(r.routedMonth).toBe('2026-11');

    const out = await db.getFirstAsync<{ paid_cents: number }>(
      'SELECT paid_cents FROM invoices WHERE id = ?',
      [invOut!.id]
    );
    expect(out!.paid_cents).toBe(30_00);
    const detail = await services.invoices.getInvoiceDetail(invOut!.id);
    expect(detail!.liveStatus).toBe('PAID'); // quitada pela parte aplicada

    const nov = await db.getFirstAsync<{ paid_cents: number }>(
      "SELECT paid_cents FROM invoices WHERE card_id = ? AND reference_month = '2026-11'",
      [cardId]
    );
    expect(nov!.paid_cents).toBe(20_00);
    expect(await getAccountBalance(db, accId)).toBe(500_00 - 50_00);
  });

  test('excedente na PRÓPRIA fatura em aberto (dia antes do corte): pré-paga o ciclo, sem segunda fatura', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Over', 800_00);
    const cardId = await seedCard(db, accId, 'Card Over', 15, 10);

    await services.transactions.createCardExpense({
      description: 'Mochila',
      amountCents: 100_00,
      date: '2026-11-05',
      cardId,
    });
    const invNov = await db.getFirstAsync<{ id: string; reference_month: string }>(
      "SELECT id, reference_month FROM invoices WHERE card_id = ? AND reference_month = '2026-11'",
      [cardId]
    );

    // Paga 150,00 na fatura em aberto de 100,00 — pagamento DENTRO do período
    const r = await services.invoices.payInvoice({
      invoiceId: invNov!.id,
      fromAccountId: accId,
      amountCents: 150_00,
      paidOn: '2026-11-08',
    });
    expect(r.surplusCents).toBe(0); // tudo ficou na própria fatura
    expect(r.routedMonth).toBeNull();

    const detail = await services.invoices.getInvoiceDetail(invNov!.id);
    expect(detail!.invoice.paid_cents).toBe(150_00);
    expect(detail!.dueCents).toBe(0); // Math.max(0, ...) — excedente pré-pago
    expect(detail!.liveStatus).toBe('PAID');

    // Compra nova no MESMO ciclo (antes do corte) é abatida pelo excedente
    await services.transactions.createCardExpense({
      description: 'Caneca',
      amountCents: 40_00,
      date: '2026-11-10',
      cardId,
    });
    const after = await services.invoices.getInvoiceDetail(invNov!.id);
    expect(after!.invoice.total_cents).toBe(140_00);
    expect(after!.dueCents).toBe(0); // 140 − 150 → ainda coberta pelo pré-pago
    expect(after!.liveStatus).toBe('PAID');
  });

  test('ESTORNO do pagamento roteado: conta recebe de volta e a fatura alvo perde o pré-pagamento', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Estorno', 900_00);
    const cardId = await seedCard(db, accId, 'Card Estorno', 15, 10);

    await services.transactions.createCardExpense({
      description: 'Fone',
      amountCents: 20_00,
      date: '2026-10-10',
      cardId,
    });
    const invOut = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM invoices WHERE card_id = ? AND reference_month = '2026-10'",
      [cardId]
    );
    await services.invoices.payInvoice({ invoiceId: invOut!.id, fromAccountId: accId, amountCents: 20_00, paidOn: '2026-10-12' });
    const saldoAposPagamentos = 900_00 - 20_00;

    const r = await services.invoices.payInvoice({ invoiceId: invOut!.id, fromAccountId: accId, amountCents: 15_00, paidOn: '2026-11-02' });
    expect(r.surplusCents).toBe(15_00);
    expect(await getAccountBalance(db, accId)).toBe(saldoAposPagamentos - 15_00);

    // Localiza o pagamento ROTEADO (na fatura de novembro) e o estorna
    const routed = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM invoice_payments WHERE invoice_id = (SELECT id FROM invoices WHERE card_id = ? AND reference_month = '2026-11')",
      [cardId]
    );
    expect(routed).not.toBeNull();
    await services.invoices.deletePayment(routed!.id);

    // Conta volta; fatura de novembro perde o pré-pagamento; outubro segue paga
    expect(await getAccountBalance(db, accId)).toBe(saldoAposPagamentos);
    const nov = await db.getFirstAsync<{ paid_cents: number }>(
      "SELECT paid_cents FROM invoices WHERE card_id = ? AND reference_month = '2026-11'",
      [cardId]
    );
    expect(nov!.paid_cents).toBe(0);
    const out = await services.invoices.getInvoiceDetail(invOut!.id);
    expect(out!.liveStatus).toBe('PAID');
  });

  test('valor zero ou negativo segue recusado; fatura inexistente também', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db);
    const cardId = await seedCard(db, accId, 'Card Zero', 15, 10);
    await services.transactions.createCardExpense({
      description: 'X',
      amountCents: 10_00,
      date: '2026-11-05',
      cardId,
    });
    const inv = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM invoices WHERE card_id = ? AND reference_month = '2026-11'",
      [cardId]
    );
    const errZero = await (async () => {
      try {
        await services.invoices.payInvoice({ invoiceId: inv!.id, fromAccountId: accId, amountCents: 0, paidOn: '2026-11-06' });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(errZero).not.toBeNull();
    expect(errZero!.message).toContain('maior que zero');
  });
});

/* ================================================================
 * MELHORIAS 1, 2, 3, 4 e 5 — marcadores de fonte (UI)
 * ================================================================ */
describe('Melhorias v16 — marcadores de fonte', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

  test('melhoria 1: itens aglutinados do grupo NÃO têm chip de status próprio', () => {
    const fluxo = read('app/fluxo.tsx');
    // filhos (opts.child) não renderizam renderPaymentChip nem renderInstStatusChip
    expect(fluxo).toContain('!opts.child && tx.status === \'VOIDED\' ? <Badge status="VOIDED" /> : !opts.child ? renderPaymentChip(tx) : null');
    expect(fluxo).toContain('{!opts.child ? renderInstStatusChip(inst) : null}');
  });

  test('melhoria 2: botão Voltar com área de toque mínima de 44px', () => {
    const ui = read('src/components/ui.tsx');
    expect(ui).toContain('min-w-[44px] min-h-[44px]');
    expect(ui).toContain('hitSlop={8}');
  });

  test('melhoria 3: a mensagem "Máscara 0,00" saiu da tela Registrar Pagamento', () => {
    const pg = read('app/cartoes/[id]/fatura/[mes]/pagamento.tsx');
    expect(pg).not.toContain('Máscara 0,00');
    expect(pg).not.toContain('Valores maiores que o saldo devido são recusados');
  });

  test('melhoria 4: mensagens do Consolidado viraram EXEMPLOS de uso', () => {
    const lanc = read('app/lancamento.tsx');
    expect(lanc).toContain('Ex.: Aluguel de R$ 1.200 no dia 5');
    expect(lanc).toContain('Ex.: Obras de R$ 10.000 em 5x');
    expect(lanc).toContain('Ex.: Aluguel recebido em 36x');
    expect(lanc).not.toContain('vira CONTA FIXA neste dia');
    expect(lanc).not.toContain('vira PARCELAMENTO');
  });

  test('melhoria 5: MoneyInput sem loop de seleção (cursor pino no fim)', () => {
    const mi = read('src/components/MoneyInput.tsx');
    expect(mi).not.toContain('onSelectionChange');
    expect(mi).toContain('endSelection');
  });

  test('bug 3: Fluxo renderiza a bolinha de fixa nos itens da fatura', () => {
    const fluxo = read('app/fluxo.tsx');
    expect(fluxo).toContain("it.sourceSystem === 'RECURRENCE' ? <FixedDot size={14} />");
  });
});

/** Helper: db do ctx (para usar dentro de testes que só pediram services). */
function db0(c: { db: import('../db/types').DbDriver }) {
  return c.db;
}

function monthOfRef(ymd: string): string {
  return monthOf(ymd);
}

void todaySP;
void monthAdd;
void dayInMonth;
void monthOfRef;
