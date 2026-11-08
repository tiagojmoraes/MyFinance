/**
 * Testes v9 — novas regras do Fluxo e do Novo Lançamento:
 *  1. Status Pago/Não Pago (Recebido/Não Recebido) e efeito no saldo;
 *  2. Propagação de contas fixas (Fixo) para meses futuros (previsão PENDING);
 *  3. Mês da fatura explícito (sugestão + até 6 meses) e bloqueio de fatura fechada;
 *  4. Edição (Alterar) de despesa em conta e compra no cartão;
 *  5. Faturas aglutinadas por mês de vencimento + saldo por dia.
 */

import { makeCtx, seedAccount, seedCard, getAccountBalance, expectRejects } from './helpers';

let ctx: Awaited<ReturnType<typeof makeCtx>>;
beforeEach(async () => {
  ctx = await makeCtx();
});

describe('v9 — Status Pago/Não Pago', () => {
  test('despesa NÃO PAGO sai do saldo e vira previsão; PAGO volta ao saldo', async () => {
    const { services } = ctx;
    const acc = await seedAccount(services.db, 'Banco', 100_000);
    const tx = await services.transactions.createAccountExpense({
      description: 'Mercado', amountCents: 25_000, accountId: acc,
    });
    expect(await getAccountBalance(services.db, acc)).toBe(75_000);

    // Marca NÃO PAGO -> PENDING, movimento sai do saldo
    await services.transactions.setPaymentStatus(tx.id, false);
    const afterPending = await services.db.getFirstAsync<{ status: string }>('SELECT status FROM transactions WHERE id = ?', [tx.id]);
    expect(afterPending?.status).toBe('PENDING');
    expect(await getAccountBalance(services.db, acc)).toBe(100_000);

    // Marca PAGO de volta -> CONFIRMED + movimento recriado
    await services.transactions.setPaymentStatus(tx.id, true);
    const afterPaid = await services.db.getFirstAsync<{ status: string }>('SELECT status FROM transactions WHERE id = ?', [tx.id]);
    expect(afterPaid?.status).toBe('CONFIRMED');
    expect(await getAccountBalance(services.db, acc)).toBe(75_000);
  });

  test('receita NÃO RECEBIDA não soma no saldo; RECEBIDA soma', async () => {
    const { services } = ctx;
    const acc = await seedAccount(services.db, 'Banco', 0);
    const tx = await services.transactions.createAccountIncome({
      description: 'Freelance', amountCents: 50_000, accountId: acc,
    });
    await services.transactions.setPaymentStatus(tx.id, false);
    expect(await getAccountBalance(services.db, acc)).toBe(0);
    await services.transactions.setPaymentStatus(tx.id, true);
    expect(await getAccountBalance(services.db, acc)).toBe(50_000);
  });

  test('compra no cartão e transferência não aceitam status', async () => {
    const { services } = ctx;
    const from = await seedAccount(services.db, 'Origem', 10_000);
    const to = await seedAccount(services.db, 'Destino', 0);
    const card = await seedCard(services.db, from);
    const cardTx = await services.transactions.createCardExpense({
      description: 'Netflix', amountCents: 5_000, cardId: card,
    });
    await expectRejects(() => services.transactions.setPaymentStatus(cardTx.id, false));
    const tr = await services.transactions.createTransfer({
      description: 'Pix', amountCents: 1_000, fromAccountId: from, toAccountId: to,
    });
    await expectRejects(() => services.transactions.setPaymentStatus(tr.id, false));
  });
});

describe('v9 — Propagação de contas fixas para meses futuros', () => {
  test('runForecast cria PREVISÕES (PENDING, sem movimento) nos próximos meses e é idempotente', async () => {
    const { services } = ctx;
    const acc = await seedAccount(services.db, 'Banco', 0);
    await services.recurrences.createRule({
      description: 'Aluguel', type: 'EXPENSE', amountCents: 100_000,
      dayOfMonth: 10, startDate: '2026-01-10', accountId: acc,
    });
    await services.recurrences.runDueRecurrences('2026-03-20'); // jan, fev, mar efetivados
    const fc = await services.recurrences.runForecast(3, '2026-03-20'); // abr, mai, jun
    expect(fc.createdForecast).toBe(3);

    const futures = await services.db.getAllAsync<{ occurred_on: string; status: string }>(
      "SELECT occurred_on, status FROM transactions WHERE occurred_on > '2026-03-31' ORDER BY occurred_on"
    );
    expect(futures.map((f) => [f.occurred_on, f.status])).toEqual([
      ['2026-04-10', 'PENDING'],
      ['2026-05-10', 'PENDING'],
      ['2026-06-10', 'PENDING'],
    ]);
    // Previsão não afeta o saldo
    expect(await getAccountBalance(services.db, acc)).toBe(-300_000);

    // Idempotência
    const fc2 = await services.recurrences.runForecast(3, '2026-03-20');
    expect(fc2.createdForecast).toBe(0);
  });

  test('previsão vencida é PROMOVIDA para efetivada (CONFIRMED + movimento)', async () => {
    const { services } = ctx;
    const acc = await seedAccount(services.db, 'Banco', 0);
    await services.recurrences.createRule({
      description: 'Internet', type: 'EXPENSE', amountCents: 9_990,
      dayOfMonth: 15, startDate: '2026-03-15', accountId: acc,
    });
    await services.recurrences.runDueRecurrences('2026-03-20');
    await services.recurrences.runForecast(2, '2026-03-20'); // abr, mai previstos

    // Chegou 20/04: a previsão de abril vira efetivada
    await services.recurrences.runDueRecurrences('2026-04-20');
    const abril = await services.db.getFirstAsync<{ status: string }>(
      "SELECT status FROM transactions WHERE occurred_on = '2026-04-15'"
    );
    expect(abril?.status).toBe('CONFIRMED');
    const movesAbril = await services.db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM financial_moves m JOIN transactions t ON t.id = m.transaction_id
        WHERE t.occurred_on = '2026-04-15' AND m.status = 'CONFIRMED'`
    );
    expect(movesAbril?.c).toBe(1);
    expect(await getAccountBalance(services.db, acc)).toBe(-19_980); // mar + abr
  });
});

describe('v9 — Mês da fatura e bloqueio de fatura fechada', () => {
  test('aceita mês explícito até 6 meses à frente e rejeita além', async () => {
    const { services } = ctx;
    const acc = await seedAccount(services.db, 'Conta', 0);
    const card = await seedCard(services.db, acc, 'Cartão Fatura', 15, 10);
    const tx = await services.transactions.createCardExpense({
      description: 'Compra antecipada', amountCents: 12_000, cardId: card, date: '2026-05-10',
      referenceMonth: '2026-07', // +2 meses após a sugestão (2026-05)
    });
    const inv = await services.db.getFirstAsync<{ reference_month: string }>(
      `SELECT i.reference_month FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE ii.transaction_id = ?`,
      [tx.id]
    );
    expect(inv?.reference_month).toBe('2026-07');

    await expectRejects(
      () => services.transactions.createCardExpense({
        description: 'Longe demais', amountCents: 1_000, cardId: card, date: '2026-05-10',
        referenceMonth: '2026-12', // +7 meses
      }),
      'fatura'
    );
  });

  test('fatura JÁ PAGA + data após o fechamento é bloqueada', async () => {
    const { services } = ctx;
    const acc = await seedAccount(services.db, 'Conta', 500_000);
    const card = await seedCard(services.db, acc, 'Cartão Fechado', 15, 10);
    // Compra em 05/05 -> fatura 2026-05; paga totalmente
    const tx = await services.transactions.createCardExpense({
      description: 'Compra 1', amountCents: 20_000, cardId: card, date: '2026-05-05',
    });
    const inv = await services.db.getFirstAsync<{ id: string }>(
      "SELECT id FROM invoices WHERE card_id = ? AND reference_month = '2026-05'", [card]
    );
    await services.invoices.payInvoice({ invoiceId: inv!.id, fromAccountId: acc, amountCents: 20_000, paidOn: '2026-05-25' });

    // Nova compra em 20/05 (após fechamento dia 15) na fatura 2026-05 -> BLOQUEADA
    await expectRejects(
      () => services.transactions.createCardExpense({
        description: 'Compra 2', amountCents: 5_000, cardId: card, date: '2026-05-20',
        referenceMonth: '2026-05',
      }),
      'fechada'
    );
    void tx;
  });
});

describe('v9 — Alterar (edição de lançamentos)', () => {
  test('despesa em conta: atualiza transação e movimento', async () => {
    const { services } = ctx;
    const acc = await seedAccount(services.db, 'Banco', 0);
    const acc2 = await seedAccount(services.db, 'Outro', 0);
    const tx = await services.transactions.createAccountExpense({
      description: 'Mercado', amountCents: 20_000, date: '2026-05-02', accountId: acc,
    });
    await services.transactions.updateSimple(tx.id, {
      description: 'Mercado (corrigido)', amountCents: 35_000, date: '2026-05-04', accountId: acc2,
    });
    const row = await services.db.getFirstAsync<{ description: string; amount_cents: number; occurred_on: string; account_id: string }>(
      'SELECT description, amount_cents, occurred_on, account_id FROM transactions WHERE id = ?', [tx.id]
    );
    expect(row).toEqual({
      description: 'Mercado (corrigido)', amount_cents: 35_000, occurred_on: '2026-05-04', account_id: acc2,
    });
    expect(await getAccountBalance(services.db, acc)).toBe(0);
    expect(await getAccountBalance(services.db, acc2)).toBe(-35_000);
  });

  test('compra no cartão: valor e fatura migram ao alterar o mês', async () => {
    const { services } = ctx;
    const acc = await seedAccount(services.db, 'Conta', 0);
    const card = await seedCard(services.db, acc, 'Cartão Edita', 15, 10);
    const tx = await services.transactions.createCardExpense({
      description: 'Tênis', amountCents: 30_000, cardId: card, date: '2026-05-10',
    });
    await services.transactions.updateSimple(tx.id, {
      amountCents: 45_000,
      referenceMonth: '2026-06',
    });
    const invAntiga = await services.db.getFirstAsync<{ total_cents: number }>(
      "SELECT total_cents FROM invoices WHERE card_id = ? AND reference_month = '2026-05'", [card]
    );
    const invNova = await services.db.getFirstAsync<{ total_cents: number }>(
      "SELECT total_cents FROM invoices WHERE card_id = ? AND reference_month = '2026-06'", [card]
    );
    expect(invAntiga?.total_cents).toBe(0);
    expect(invNova?.total_cents).toBe(45_000);
  });

  test('transferência: atualiza os dois movimentos', async () => {
    const { services } = ctx;
    const from = await seedAccount(services.db, 'Origem', 100_000);
    const to = await seedAccount(services.db, 'Destino', 0);
    const tx = await services.transactions.createTransfer({
      description: 'Pix', amountCents: 10_000, date: '2026-05-01', fromAccountId: from, toAccountId: to,
    });
    await services.transactions.updateSimple(tx.id, { amountCents: 25_000, date: '2026-05-09' });
    expect(await getAccountBalance(services.db, from)).toBe(75_000);
    expect(await getAccountBalance(services.db, to)).toBe(25_000);
  });
});

describe('v9 — Fluxo: faturas do mês e saldo por dia', () => {
  test('faturas com vencimento no mês são aglutinadas com itens', async () => {
    const { services } = ctx;
    const acc = await seedAccount(services.db, 'Conta', 0);
    const card = await seedCard(services.db, acc, 'Cartão Aglutina', 15, 20); // vence dia 20
    await services.transactions.createCardExpense({
      description: 'Streaming', amountCents: 4_990, cardId: card, date: '2026-05-10',
    });
    const aggs = await services.invoices.listInvoicesDueInMonth('2026-05');
    expect(aggs).toHaveLength(1);
    expect(aggs[0].cardName).toBe('Cartão Aglutina');
    expect(aggs[0].dueDate.startsWith('2026-05')).toBe(true);
    expect(aggs[0].dueCents).toBe(4_990);
    expect(aggs[0].items).toHaveLength(1);
    expect(aggs[0].items[0].description).toBe('Streaming');
  });

  test('parcelas de planos em CONTA aparecem como previsão no mês do vencimento', async () => {
    const { services } = ctx;
    const acc = await seedAccount(services.db, 'Conta', 0);
    await services.installments.createPlan({
      description: 'Notebook', mode: 'DIVIDE_TOTAL', totalCents: 120_000,
      totalInstallments: 6, firstDueDate: '2026-05-10', purchaseDate: '2026-05-01', accountId: acc,
    });
    const rows = await services.installments.listAccountInstallmentsDueInMonth('2026-05');
    expect(rows).toHaveLength(1);
    expect(rows[0].sequenceNumber).toBe(1);
    expect(rows[0].amountCents).toBe(20_000);
    const futuras = await services.installments.listAccountInstallmentsDueInMonth('2026-07');
    expect(futuras).toHaveLength(1);
    expect(futuras[0].sequenceNumber).toBe(3);
  });

  test('saldo por dia acumula movimentos até cada dia do mês', async () => {
    const { services } = ctx;
    const acc = await seedAccount(services.db, 'Banco', 100_000);
    await services.transactions.createAccountExpense({
      description: 'Dia 3', amountCents: 30_000, date: '2026-05-03', accountId: acc,
    });
    await services.transactions.createAccountIncome({
      description: 'Dia 6', amountCents: 10_000, date: '2026-05-06', accountId: acc,
    });
    const daily = await services.balance.getDailyBalances('2026-05');
    expect(daily['2026-05-02']).toBe(100_000);
    expect(daily['2026-05-03']).toBe(70_000);
    expect(daily['2026-05-06']).toBe(80_000);
    expect(daily['2026-05-31']).toBe(80_000);
  });
});
