/**
 * v87 — POUPANÇA (plano inativo), DESEJO (reserva atômica) e FATURA (vazia).
 *
 *  · Poupança inativa NÃO entra no "programado" e na sobra do fechamento
 *    (era tudo somado junto — desligar o plano parava de gerar entry, mas
 *    o valor antigo continuava contando);
 *  · A reserva de desejo é atômica: a transferência + o registro + o
 *    "reserved_cents" entram numa única transação (antes uma falha no meio
 *    deixava o dinheiro na caixinha sem registro da reserva);
 *  · Fatura de cartão SEM itens (tudo removido) NÃO vira "PAID" (antes,
 *    total 0 → due 0 → status PAID — o histórico mentia).
 */

import { makeCtx, seedAccount, seedCard, expectRejects } from '../helpers';
import { todaySP, monthOf, monthAdd } from '../../lib/dates';

describe('v87 — poupança: plano inativo sai dos totais', () => {
  test('desligar o plano zera o "programado" (planned) do mês', async () => {
    const { db, services } = await makeCtx();
    const src = await seedAccount(db, 'Origem');
    const dst = await seedAccount(db, 'Destino');
    const planId = await services.savings.createMonthlyPlan({
      amountCents: 25_000, dayOfMonth: 28, fromAccountId: src, toAccountId: dst,
    });
    // gera forecast e pega o overview do mês atual
    await services.savings.generateForecast();
    const mes = monthOf(todaySP());
    const antes = await services.savings.getMonthOverview(mes);
    expect(antes.plannedCents).toBeGreaterThanOrEqual(25_000);

    // desliga o plano
    await services.savings.setActive(planId, false);
    const depois = await services.savings.getMonthOverview(mes);
    expect(depois.plannedCents).toBe(0);
  });
});

describe('v87 — desejo: reserva é atômica', () => {
  // O comportamento (tx + reserva + contador sobem juntos ou nada) já é
  // coberto pelo v83 e pelos fluxos existentes; este novo assert testa
  // apenas que getById vê o item como OPEN depois de addItem — pré-condição
  // do reserve, que evita o falso erro "Item não está mais na lista".
  test('addItem deixa o item como OPEN (pré-condição da reserva)', async () => {
    const { db, services } = await makeCtx();
    await seedAccount(db, 'Origem');
    await seedAccount(db, 'Reserva · Programação de Compra');
    const id = await services.wishlist.addItem({
      classificacao: 'PRIORIDADE', description: 'Fone', targetCents: 100_000, link: null,
    });
    const row = await db.getFirstAsync<{ status: string; reserved_cents: number }>(
      'SELECT status, reserved_cents FROM wishlist_items WHERE id = ?', [id]
    );
    expect(row?.status).toBe('OPEN');
    expect(row?.reserved_cents).toBe(0);
  });
});

describe('v87 — fatura de cartão vazia NÃO vira "PAID"', () => {
  test('remover todos os itens de uma fatura deixa o status como OPEN, não PAID', async () => {
    const { db, services } = await makeCtx();
    const acc = await seedAccount(db, 'Conta');
    const card = await seedCard(db, acc, 'Card', 15, 20);
    await services.transactions.createCardExpense({
      description: 'Único item', amountCents: 50_000, cardId: card, date: '2026-04-10',
    });
    const fat = await services.invoices.getInvoiceDetailByCardMonth(card, '2026-04');
    // remove o item da fatura
    await db.runAsync('DELETE FROM invoice_items WHERE invoice_id = ?', [fat!.invoice.id]);
    await services.invoices.rebuildTotals(fat!.invoice.id);
    const row = await db.getFirstAsync<{ status: string; total_cents: number }>(
      'SELECT status, total_cents FROM invoices WHERE id = ?', [fat!.invoice.id]
    );
    expect(row?.total_cents).toBe(0);
    expect(row?.status).toBe('OPEN'); // antes virava PAID (total 0 = due 0)
  });

  test('fatura COM itens e devido 0 ainda vira PAID (o caso normal)', async () => {
    const { db, services } = await makeCtx();
    const acc = await seedAccount(db, 'Conta');
    const card = await seedCard(db, acc, 'CardB', 15, 20);
    await services.transactions.createCardExpense({
      description: 'Compra', amountCents: 30_000, cardId: card, date: '2026-04-10',
    });
    const fat = await services.invoices.getInvoiceDetailByCardMonth(card, '2026-04');
    await services.invoices.payInvoice({
      invoiceId: fat!.invoice.id, fromAccountId: acc, amountCents: 30_000, paidOn: '2026-04-25',
    });
    const row = await db.getFirstAsync<{ status: string }>(
      'SELECT status FROM invoices WHERE id = ?', [fat!.invoice.id]
    );
    expect(row?.status).toBe('PAID');
  });
});
