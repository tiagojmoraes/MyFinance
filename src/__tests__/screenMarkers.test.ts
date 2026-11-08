/**
 * Testes dos marcadores visuais das telas (v7.0.1):
 *  - Bolinha preta "✓": transações de conta fixa (source_system = RECURRENCE).
 *  - Pill preta "atual/total": metadados de parcela em itens de fatura e fluxo.
 */

import { makeCtx, seedAccount, seedCard } from './helpers';
import type { TestCtx } from './helpers';

let ctx: TestCtx;

beforeEach(async () => {
  ctx = await makeCtx();
});

describe('Marcadores visuais — dados das telas', () => {
  test('item de fatura de parcela traz sequence_number e total_installments (pill X/N)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db);
    const cardId = await seedCard(db, accId, 'Cartão Pill');

    await services.installments.createPlan({
      description: 'Notebook Gamer',
      mode: 'DIVIDE_TOTAL',
      totalCents: 120_00,
      totalInstallments: 12,
      firstDueDate: '2026-01-10',
      cardId,
      purchaseDate: '2026-01-05',
    });

    const invoice = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM invoices WHERE card_id = ? AND reference_month = '2026-01'",
      [cardId]
    );
    expect(invoice).not.toBeNull();

    const items = await db.getAllAsync<{
      sequence_number: number | null;
      total_installments: number | null;
      source_system: string | null;
    }>(
      `SELECT ins.sequence_number AS sequence_number,
              ip.total_installments AS total_installments,
              t.source_system AS source_system
         FROM invoice_items ii
         LEFT JOIN transactions t ON t.id = ii.transaction_id
         LEFT JOIN installments ins ON ins.id = ii.installment_id
         LEFT JOIN installment_plans ip ON ip.id = ins.plan_id
        WHERE ii.invoice_id = ?`,
      [invoice!.id]
    );

    expect(items.length).toBe(1);
    expect(items[0].sequence_number).toBe(1);
    expect(items[0].total_installments).toBe(12);
    // Sem origem de recorrência: sem bolinha fixa, apenas pill
    expect(items[0].source_system).toBeNull();
  });

  test('transação consolidada no fluxo traz plano (total/pagas) para a pill', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db);
    const cardId = await seedCard(db, accId, 'Cartão Fluxo');

    await services.installments.createPlan({
      description: 'Celular',
      mode: 'DIVIDE_TOTAL',
      totalCents: 60_00,
      totalInstallments: 6,
      firstDueDate: '2026-03-05',
      cardId,
      purchaseDate: '2026-03-01',
    });

    const rows = await db.getAllAsync<{ plan_total_installments: number | null; plan_paid_count: number | null }>(
      `SELECT ip.total_installments AS plan_total_installments,
              (SELECT COUNT(*) FROM installments i WHERE i.plan_id = ip.id AND i.status = 'PAID') AS plan_paid_count
         FROM transactions t
         LEFT JOIN installment_plans ip ON ip.original_transaction_id = t.id
        WHERE t.source_system = 'INSTALLMENT'`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].plan_total_installments).toBe(6);
    expect(rows[0].plan_paid_count).toBe(0); // pill exibiria 1/6
  });

  test('transação de conta fixa nasce com source_system RECURRENCE (bolinha ✓)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db);

    await services.recurrences.createRule({
      description: 'Aluguel',
      type: 'EXPENSE',
      amountCents: 150_00,
      dayOfMonth: 5,
      startDate: '2026-01-01',
      accountId: accId,
    });

    const created = await services.recurrences.runDueRecurrences();
    expect(created.createdTransactions).toBeGreaterThan(0);

    const txs = await db.getAllAsync<{ source_system: string; recurrence_rule_id: string | null }>(
      "SELECT source_system, recurrence_rule_id FROM transactions WHERE source_system = 'RECURRENCE'"
    );
    expect(txs.length).toBeGreaterThan(0);
    for (const tx of txs) {
      expect(tx.source_system).toBe('RECURRENCE');
      expect(tx.recurrence_rule_id).not.toBeNull();
    }
  });

  test('item de fatura de compra simples NÃO tem pill (sequence null) e compra no cartão aparece no fluxo', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db);
    const cardId = await seedCard(db, accId, 'Cartão Simples');

    await services.transactions.createCardExpense({
      description: 'Padaria',
      amountCents: 25_90,
      date: '2026-01-03',
      cardId,
    });

    const invoice = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM invoices WHERE card_id = ? AND reference_month = '2026-01'",
      [cardId]
    );
    const items = await db.getAllAsync<{ sequence_number: number | null }>(
      `SELECT ins.sequence_number AS sequence_number
         FROM invoice_items ii
         LEFT JOIN installments ins ON ins.id = ii.installment_id
        WHERE ii.invoice_id = ?`,
      [invoice!.id]
    );
    expect(items.length).toBe(1);
    expect(items[0].sequence_number).toBeNull(); // sem pill, não é parcelado
  });
});
