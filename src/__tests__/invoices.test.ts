/** Fase 3 — Corte de fatura exato, pagamento parcial e crédito excedente. */

import { makeCtx, seedAccount, seedCard, getAccountBalance, expectRejects } from './helpers';
import { monthOf } from '../lib/dates';

describe('CardInvoiceService — regra de corte', () => {
  test('compra até o dia de corte entra na fatura ATUAL', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc, 'Nubank', 15, 10);
    // 15/05 23:59:59 SP -> fatura de maio
    await services.transactions.createCardExpense({
      description: 'Compra no corte', amountCents: 10000, cardId: card,
      date: '2026-05-15', occurredAt: '2026-05-15T02:59:59.000Z', // 23:59:59 SP (UTC-3)
    });
    const inv = await services.db.getFirstAsync<{ reference_month: string }>('SELECT reference_month FROM invoices');
    expect(inv?.reference_month).toBe('2026-05');
  });

  test('compra no dia seguinte ao corte entra na PRÓXIMA', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc, 'Nubank', 15, 10);
    await services.transactions.createCardExpense({
      description: 'Depois do corte', amountCents: 20000, cardId: card,
      date: '2026-05-16', occurredAt: '2026-05-16T03:00:00.000Z', // 16/05 00:00 SP
    });
    const inv = await services.db.getFirstAsync<{ reference_month: string }>('SELECT reference_month FROM invoices');
    expect(inv?.reference_month).toBe('2026-06');
  });

  test('due_day <= closing_day empurra vencimento para o mês seguinte', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc, 'C6', 20, 10);
    const inv = await services.invoices.ensureInvoice(card, '2026-05');
    expect(inv.due_date).toBe('2026-06-10');
    expect(inv.period_start).toBe('2026-04-21');
    expect(inv.period_end).toBe('2026-05-20');
  });

  test('dia de corte maior que o mês é clampado (31 em abril)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc, 'Inter', 31, 25);
    const inv = await services.invoices.ensureInvoice(card, '2026-04');
    expect(inv.period_end).toBe('2026-04-30');
  });
});

describe('CardInvoiceService — pagamentos', () => {
  test('pagamento parcial => PARTIALLY_PAID enquanto devido > 0', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc, 'Nu', 15, 10);
    const inv = await services.invoices.ensureInvoice(card, '2026-05');
    await services.transactions.createCardExpense({
      description: 'Compra 1', amountCents: 100000, cardId: card, date: '2026-05-01',
    });
    await services.transactions.createCardExpense({
      description: 'Compra 2', amountCents: 50000, cardId: card, date: '2026-05-02',
    });
    await services.invoices.rebuildTotals(inv.id);
    expect(inv.total_cents).toBe(0); // snapshot antigo; recarregar
    const fresh = await services.db.getFirstAsync<{ total_cents: number; paid_cents: number; status: string; credit_from_prev_cents: number; id: string }>('SELECT * FROM invoices WHERE id = ?', [inv.id]);
    expect(fresh?.total_cents).toBe(150000);

    await services.invoices.payInvoice({ invoiceId: inv.id, fromAccountId: acc, amountCents: 40000 });
    const after = await services.db.getFirstAsync<{ total_cents: number; paid_cents: number; status: string; credit_from_prev_cents: number; id: string }>('SELECT * FROM invoices WHERE id = ?', [inv.id]);
    expect(after?.paid_cents).toBe(40000);
    expect(after?.status).toBe('PARTIALLY_PAID');
    const due = await services.invoices.getDueCents(inv.id);
    expect(due).toBe(110000);
  });

  test('pagamento total quita e move DEBIT aparece na conta', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Conta Pagamento', 200000);
    const card = await seedCard(services.db, acc);
    const inv = await services.invoices.ensureInvoice(card, '2026-05');
    await services.transactions.createCardExpense({
      description: 'Compra', amountCents: 30000, cardId: card, date: '2026-05-01',
    });
    await services.invoices.rebuildTotals(inv.id);
    await services.invoices.payInvoice({ invoiceId: inv.id, fromAccountId: acc, amountCents: 30000 });
    const after = await services.db.getFirstAsync<{ total_cents: number; paid_cents: number; status: string; credit_from_prev_cents: number; id: string }>('SELECT * FROM invoices WHERE id = ?', [inv.id]);
    expect(after?.status).toBe('PAID');
    const move = await services.db.getFirstAsync<{ direction: string; amount_cents: number }>(
      'SELECT direction, amount_cents FROM financial_moves WHERE invoice_payment_id IS NOT NULL'
    );
    expect(move?.direction).toBe('DEBIT');
    expect(move?.amount_cents).toBe(30000);
  });

  test('v16: pagamento MAIOR que o devido é ACEITO — excedente vai para a fatura em aberto pela data de corte', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Conta', 500000);
    const card = await seedCard(services.db, acc, 'Nu', 15, 10);
    const inv = await services.invoices.ensureInvoice(card, '2026-05');
    await services.transactions.createCardExpense({
      description: 'Compra', amountCents: 30000, cardId: card, date: '2026-05-01',
    });
    await services.invoices.rebuildTotals(inv.id);

    // v16 (bug 4): pagamento adicional é ACEITO. Regra padrão de cartão pela
    // DATA DE CORTE: 30.000 quitam esta fatura; o excedente de 5.000 vai para
    // a fatura EM ABERTO na data do pagamento (paidOn 2026-11-01, corte dia 15
    // → fatura 2026-11) e abate o que existir/lá vier. A fatura seguinte à
    // VISTA (2026-06) não é tocada — o roteamento não é "a próxima da lista",
    // é a fatura corrente do ciclo pela data de corte.
    const r = await services.invoices.payInvoice({
      invoiceId: inv.id, fromAccountId: acc, amountCents: 35000, paidOn: '2026-11-01',
    });
    expect(r.appliedCents).toBe(30000);
    expect(r.surplusCents).toBe(5000);
    expect(r.routedMonth).toBe('2026-11');

    // A fatura vista foi QUITADA pela parte aplicada
    const fresh = await services.db.getFirstAsync<{ paid_cents: number; status: string }>('SELECT paid_cents, status FROM invoices WHERE id = ?', [inv.id]);
    expect(fresh?.paid_cents).toBe(30000);
    expect(fresh?.status).toBe('PAID');

    // O excedente está como pagamento pré-pago na fatura do ciclo atual
    const target = await services.db.getFirstAsync<{ paid_cents: number; total_cents: number }>(
      'SELECT paid_cents, total_cents FROM invoices WHERE card_id = ? AND reference_month = ?',
      [card, '2026-11']
    );
    expect(target?.paid_cents).toBe(5000);
    expect(target?.total_cents).toBe(0);

    // A fatura SEGUINTE à vista (2026-06) continua intocada (não existe)
    const next = await services.db.getFirstAsync('SELECT * FROM invoices WHERE card_id = ? AND reference_month = ?', [card, '2026-06']);
    expect(next).toBeNull();
  });

  test('v12: pagamento parcial abate o total da fatura atual (proporcional ao devido)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Conta', 500000);
    const card = await seedCard(services.db, acc, 'Nu', 15, 10);
    const inv = await services.invoices.ensureInvoice(card, '2026-05');
    await services.transactions.createCardExpense({
      description: 'Compra A', amountCents: 60_00, cardId: card, date: '2026-05-01',
    });
    await services.transactions.createCardExpense({
      description: 'Compra B', amountCents: 40_00, cardId: card, date: '2026-05-02',
    });
    await services.invoices.rebuildTotals(inv.id);
    // Paga 50,00 de 100,00 — abate proporcionalmente o total DESTA fatura
    await services.invoices.payInvoice({ invoiceId: inv.id, fromAccountId: acc, amountCents: 50_00 });
    const after = await services.db.getFirstAsync<{ paid_cents: number; status: string }>('SELECT paid_cents, status FROM invoices WHERE id = ?', [inv.id]);
    expect(after?.paid_cents).toBe(50_00);
    expect(after?.status).toBe('PARTIALLY_PAID');
    expect(await services.invoices.getDueCents(inv.id)).toBe(50_00);
  });

  test('v12: excluir o pagamento ESTORNA tudo — move some, status e parcelas voltam', async () => {
    const { services, db } = await makeCtx();
    const acc = await seedAccount(db, 'Conta Pagto', 100000);
    const card = await seedCard(db, acc, 'Card Estorno', 20, 10);
    // Fatura de maio com 2 parcelas de cartão (5000 cada)
    await services.installments.createPlan({
      description: 'Notebook',
      mode: 'DIVIDE_TOTAL',
      totalCents: 10_000,
      totalInstallments: 2,
      firstDueDate: '2026-05-05',
      cardId: card,
    });
    const inv = await db.getFirstAsync<{ id: string }>("SELECT id FROM invoices WHERE card_id = ? AND reference_month = '2026-05'", [card]);
    expect(inv).not.toBeNull();
    // Quita a fatura inteira (1ª parcela: 5000) → status PAID + parcela PAID
    await services.invoices.payInvoice({ invoiceId: inv!.id, fromAccountId: acc, amountCents: 5_000 });
    let fresh = await db.getFirstAsync<{ status: string; paid_cents: number }>('SELECT status, paid_cents FROM invoices WHERE id = ?', [inv!.id]);
    expect(fresh?.status).toBe('PAID');
    const paidInst = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM installments WHERE invoice_id = ? AND status = 'PAID'", [inv!.id]);
    expect(paidInst?.n).toBe(1);
    const saldoAntes = await getAccountBalance(db, acc);
    expect(saldoAntes).toBe(100000 - 5_000);

    // Exclui o pagamento → estorno TOTAL: move some, saldo volta, fatura reabre,
    // parcela volta a PENDING
    const pay = await db.getFirstAsync<{ id: string }>('SELECT id FROM invoice_payments LIMIT 1');
    await services.invoices.deletePayment(pay!.id);
    fresh = await db.getFirstAsync<{ status: string; paid_cents: number }>('SELECT status, paid_cents FROM invoices WHERE id = ?', [inv!.id]);
    expect(fresh?.status).toBe('OPEN');
    expect(fresh?.paid_cents).toBe(0);
    expect(await services.invoices.getDueCents(inv!.id)).toBe(5_000);
    const movesAfter = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM financial_moves WHERE invoice_payment_id IS NOT NULL');
    expect(movesAfter?.n).toBe(0);
    const instAfter = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM installments WHERE invoice_id = ? AND status = 'PENDING'", [inv!.id]);
    expect(instAfter?.n).toBe(1);
    expect(await getAccountBalance(db, acc)).toBe(100000);
  });

  test('v12: fatura anterior com saldo devido NÃO é fechada ao abrir a seguinte', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc, 'Nu', 15, 10);
    const m1 = await services.invoices.ensureInvoice(card, '2026-04');
    await services.transactions.createCardExpense({
      description: 'Compra abril', amountCents: 80_00, cardId: card, date: '2026-04-02',
    });
    await services.invoices.rebuildTotals(m1.id);
    // Abre a fatura seguinte (uma compra em maio, por exemplo)
    await services.transactions.createCardExpense({
      description: 'Compra maio', amountCents: 20_00, cardId: card, date: '2026-05-02',
    });
    const m1Fresh = await services.db.getFirstAsync<{ status: string }>('SELECT status FROM invoices WHERE id = ?', [m1.id]);
    // Com saldo devido, a fatura anterior NUNCA é fechada automaticamente
    expect(m1Fresh?.status).toBe('OPEN');
  });

  test('fatura anterior é fechada ao abrir a seguinte', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc);
    const m1 = await services.invoices.ensureInvoice(card, '2026-04');
    await services.invoices.ensureInvoice(card, '2026-05');
    const m1Fresh = await services.db.getFirstAsync<{ status: string }>('SELECT * FROM invoices WHERE id = ?', [m1.id]);
    expect(m1Fresh?.status).toBe('CLOSED');
  });
});
