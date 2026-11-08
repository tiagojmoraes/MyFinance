/**
 * Testes v10 — regras novas:
 *  · Toggle Pago/Não pago das parcelas em conta (move reposicionado p/ hoje);
 *  · Exclusão de parcelas "da parcela em diante";
 *  · Estorno total de pagamento de fatura (deletePayment);
 *  · Conta fixa em CARTÃO entra na fatura do mês.
 */

import { makeCtx, seedAccount, seedCard, getAccountBalance } from './helpers';
import { todaySP } from '../lib/dates';

let ctx: ReturnType<typeof makeCtx> extends Promise<infer T> ? T : never;

beforeEach(async () => {
  ctx = await makeCtx();
});

describe('InstallmentService.setPaymentStatus (v10 — toggle da parcela)', () => {
  test('marcar PAGO reposiciona o débito para HOJE; desmarcar volta para o vencimento', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Parcelas', 0);
    const { planId } = await services.installments.createPlan({
      description: 'Notebook',
      mode: 'DIVIDE_TOTAL',
      totalCents: 30_000,
      totalInstallments: 3,
      firstDueDate: '2026-05-10',
      accountId: accId,
    });
    const inst = await db.getFirstAsync<{ id: string; amount_cents: number }>(
      "SELECT id, amount_cents FROM installments WHERE plan_id = ? AND sequence_number = 1",
      [planId]
    );
    expect(inst).not.toBeNull();

    // Pago: status PAID + move com effective_date = hoje
    await services.installments.setPaymentStatus(inst!.id, true);
    const afterPaid = await db.getFirstAsync<{ status: string }>(
      'SELECT status FROM installments WHERE id = ?',
      [inst!.id]
    );
    expect(afterPaid?.status).toBe('PAID');
    const movePaid = await db.getFirstAsync<{ effective_date: string; status: string }>(
      'SELECT effective_date, status FROM financial_moves WHERE installment_id = ?',
      [inst!.id]
    );
    expect(movePaid?.effective_date).toBe(todaySP());
    expect(movePaid?.status).toBe('CONFIRMED');

    // Desmarcado: PENDING + move volta para a data de vencimento
    await services.installments.setPaymentStatus(inst!.id, false);
    const afterUnpaid = await db.getFirstAsync<{ status: string }>(
      'SELECT status FROM installments WHERE id = ?',
      [inst!.id]
    );
    expect(afterUnpaid?.status).toBe('PENDING');
    const moveUnpaid = await db.getFirstAsync<{ effective_date: string }>(
      'SELECT effective_date FROM financial_moves WHERE installment_id = ?',
      [inst!.id]
    );
    expect(moveUnpaid?.effective_date).toBe('2026-05-10');
  });

  test('listAccountInstallmentsDueInMonth inclui pagas e pendentes com status', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Lista', 0);
    const { planId } = await services.installments.createPlan({
      description: 'Geladeira',
      mode: 'DIVIDE_TOTAL',
      totalCents: 20_000,
      totalInstallments: 2,
      firstDueDate: '2026-06-01',
      accountId: accId,
    });
    const first = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM installments WHERE plan_id = ? AND sequence_number = 1',
      [planId]
    );
    await services.installments.setPaymentStatus(first!.id, true);
    // Parcela 1 vence em 2026-06; parcela 2 em 2026-07 (mensal)
    const june = await services.installments.listAccountInstallmentsDueInMonth('2026-06');
    expect(june.length).toBe(1);
    expect(june[0].status).toBe('PAID');
    const july = await services.installments.listAccountInstallmentsDueInMonth('2026-07');
    expect(july.length).toBe(1);
    expect(july[0].status).toBe('PENDING');
  });
});

describe('InstallmentService.cancelFromSequence (v10 — da parcela em diante)', () => {
  test('cancela as pendentes a partir da sequência informada; pagas ficam intactas', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Cancel', 0);
    const { planId } = await services.installments.createPlan({
      description: 'Celular',
      mode: 'DIVIDE_TOTAL',
      totalCents: 50_000,
      totalInstallments: 5,
      firstDueDate: '2026-05-10',
      accountId: accId,
    });
    // Paga a 1ª parcela
    const first = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM installments WHERE plan_id = ? AND sequence_number = 1',
      [planId]
    );
    await services.installments.setPaymentStatus(first!.id, true);

    const res = await services.installments.cancelFromSequence(planId, 3);
    expect(res.canceledCount).toBe(3);

    const rows = await db.getAllAsync<{ sequence_number: number; status: string }>(
      'SELECT sequence_number, status FROM installments WHERE plan_id = ? ORDER BY sequence_number',
      [planId]
    );
    expect(rows[0].status).toBe('PAID');
    expect(rows[1].status).toBe('PENDING');
    expect(rows.slice(2).map((r) => r.status)).toEqual(['CANCELED', 'CANCELED', 'CANCELED']);

    // Movimentos das canceladas foram APAGADOS (exclusão física)
    const orphanMoves = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM financial_moves WHERE installment_id IN (SELECT id FROM installments WHERE status = ?)',
      ['CANCELED']
    );
    expect(orphanMoves?.n).toBe(0);

    // Custo recalculado = pagas + restante (10.000 + 10.000)
    expect(res.newTotalCents).toBe(20_000);
  });
});

describe('CardInvoiceService.deletePayment (v10 — estorno do pagamento)', () => {
  test('exclui o pagamento, apaga o movimento da conta e o status da fatura volta a OPEN', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Fatura', 100_000);
    const cardId = await seedCard(db, accId, 'Cartão Estorno', 15, 10);

    await services.transactions.createCardExpense({
      description: 'Compra teste',
      amountCents: 50_000,
      date: '2026-03-05',
      cardId,
    });
    const detail = await services.invoices.getInvoiceDetailByCardMonth(cardId, '2026-03');
    expect(detail).not.toBeNull();
    const invoiceId = detail!.invoice.id;

    // Paga tudo
    const pay = await services.invoices.payInvoice({
      invoiceId,
      fromAccountId: accId,
      amountCents: detail!.dueCents,
    });
    const afterPay = await services.invoices.getInvoiceDetail(invoiceId);
    expect(afterPay!.liveStatus).toBe('PAID');
    const balanceAfterPay = await getAccountBalance(db, accId);
    expect(balanceAfterPay).toBe(100_000 - 50_000);

    // Estorno: pagamento sai do banco + movimento da conta é apagado + status volta
    await services.invoices.deletePayment(pay.paymentId);

    const afterDel = await services.invoices.getInvoiceDetail(invoiceId);
    // Fatura com vencimento passado e sem pagamentos = OVERDUE (status ao vivo)
    expect(['OPEN', 'OVERDUE']).toContain(afterDel!.liveStatus);
    expect(afterDel!.invoice.paid_cents).toBe(0);
    expect(await getAccountBalance(db, accId)).toBe(100_000);

    const paymentRows = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM invoice_payments WHERE invoice_id = ?',
      [invoiceId]
    );
    expect(paymentRows?.n).toBe(0);
    const moveRows = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM financial_moves WHERE invoice_payment_id = ?',
      [pay.paymentId]
    );
    expect(moveRows?.n).toBe(0);
  });

  test('quitação por pagamento marcava parcelas PAID — estorno devolve a PENDING', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Mix', 500_000);
    const cardId = await seedCard(db, accId, 'Cartão Mix', 15, 10);

    // Plano no cartão (parcelas entram na fatura)
    await services.installments.createPlan({
      description: 'Notebook cartão',
      mode: 'DIVIDE_TOTAL',
      totalCents: 20_000,
      totalInstallments: 2,
      firstDueDate: '2026-03-10',
      cardId,
    });
    // Cada parcela mensal entra na fatura do seu vencimento (2026-03 e 2026-04)
    const detail = await services.invoices.getInvoiceDetailByCardMonth(cardId, '2026-03');
    expect(detail!.items.length).toBe(1);
    const invoiceId = detail!.invoice.id;

    await services.invoices.payInvoice({ invoiceId, fromAccountId: accId, amountCents: detail!.dueCents });
    const paidInst = await db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM installments WHERE invoice_id = ? AND status = 'PAID'",
      [invoiceId]
    );
    expect(paidInst?.n).toBe(1);

    // Estorno: parcelas voltam a PENDING
    const payments = await services.invoices.getInvoiceDetail(invoiceId);
    const payId = payments!.payments[0].id;
    await services.invoices.deletePayment(payId);
    const pendingInst = await db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM installments WHERE invoice_id = ? AND status = 'PENDING'",
      [invoiceId]
    );
    expect(pendingInst?.n).toBe(1);
  });
});

describe('RecurrenceService — conta fixa em CARTÃO (v10, Req 5)', () => {
  test('a ocorrência mensal entra na FATURA do cartão (sem movimento em conta)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Rec', 0);
    const cardId = await seedCard(db, accId, 'Cartão Fixo', 15, 10);

    await services.recurrences.createRule({
      description: 'Streaming mensal',
      type: 'EXPENSE',
      amountCents: 4_990,
      dayOfMonth: 5,
      startDate: '2026-02-05',
      cardId,
    });
    await services.recurrences.runDueRecurrences();

    // Ocorrências RECURRENCE no cartão
    const recs = await db.getAllAsync<{ id: string; card_id: string }>(
      "SELECT id, card_id FROM transactions WHERE source_system = 'RECURRENCE' AND recurrence_rule_id IS NOT NULL"
    );
    expect(recs.length).toBeGreaterThanOrEqual(2);
    for (const r of recs) expect(r.card_id).toBe(cardId);

    // Sem movimento em conta (compra no cartão é paga pela fatura)
    const moves = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM financial_moves WHERE transaction_id IN (SELECT id FROM transactions WHERE source_system = ?)',
      ['RECURRENCE']
    );
    expect(moves?.n).toBe(0);

    // Itens de fatura criados para as ocorrências
    const items = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM invoice_items WHERE transaction_id IN (SELECT id FROM transactions WHERE source_system = ?)',
      ['RECURRENCE']
    );
    expect(items?.n).toBe(recs.length);
  });
});
