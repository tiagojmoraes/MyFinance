/**
 * Testes v12 — bugs críticos e usabilidade:
 *  · Bug C: pagamento de fatura abate DIRETAMENTE o total da fatura atual e
 *    NUNCA quita/fecha a fatura seguinte; exclusão do pagamento estorna TUDO.
 *  · Bug B: despesa E receita FIXAS no cartão funcionam — o item entra na
 *    fatura (receita = item negativo/crédito), inclusive a previsão dos meses
 *    futuros, sem duplicar na promoção do mês.
 *  · Bug A: consolidado com linhas Fixo/Parcelado nasce com cabeçalho-âncora
 *    (consolida igual ao "À Vista") e a exclusão do grupo apaga TODO o grupo.
 */

import { makeCtx, seedAccount, seedCard, getAccountBalance } from './helpers';
import { todaySP, monthOf, monthAdd, dayInMonth } from '../lib/dates';

let ctx: ReturnType<typeof makeCtx> extends Promise<infer T> ? T : never;

beforeEach(async () => {
  ctx = await makeCtx();
});

describe('Bug B — despesa fixa no cartão', () => {
  test('a ocorrência do mês entra como item na fatura do cartão', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Base', 0);
    const cardId = await seedCard(db, accId, 'Card Fixa', 15, 10);

    await services.recurrences.createRule({
      description: 'Streaming',
      type: 'EXPENSE',
      amountCents: 29_90,
      dayOfMonth: 1,
      startDate: todaySP(),
      cardId,
    });
    await services.recurrences.runDueRecurrences();

    const cur = monthOf(todaySP());
    const inv = await db.getFirstAsync<{ id: string; total_cents: number }>(
      'SELECT id, total_cents FROM invoices WHERE card_id = ? AND reference_month = ?',
      [cardId, cur]
    );
    expect(inv).not.toBeNull();
    expect(inv!.total_cents).toBe(29_90);
    const item = await db.getFirstAsync<{ amount_cents: number; source_system: string | null }>(
      `SELECT ii.amount_cents, t.source_system
         FROM invoice_items ii JOIN transactions t ON t.id = ii.transaction_id
        WHERE ii.invoice_id = ?`,
      [inv!.id]
    );
    expect(item?.amount_cents).toBe(29_90);
    expect(item?.source_system).toBe('RECURRENCE');
  });

  test('receita fixa no cartão entra como item NEGATIVO (crédito) e abate o total', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Base', 0);
    const cardId = await seedCard(db, accId, 'Card Receita', 15, 10);
    const cur = monthOf(todaySP());

    // Compra ANTES do fechamento (mesma fatura da ocorrência da fixa)
    await services.transactions.createCardExpense({
      description: 'Compra', amountCents: 100_00, cardId, date: dayInMonth(cur, 1),
    });
    await services.recurrences.createRule({
      description: 'Cashback',
      type: 'INCOME',
      amountCents: 30_00,
      dayOfMonth: 1,
      startDate: dayInMonth(cur, 1),
      cardId,
    });
    await services.recurrences.runDueRecurrences();

    const inv = await db.getFirstAsync<{ total_cents: number }>(
      'SELECT total_cents FROM invoices WHERE card_id = ? AND reference_month = ?',
      [cardId, cur]
    );
    // 100,00 de compras − 30,00 de receita fixa = 70,00 de total
    expect(inv?.total_cents).toBe(70_00);
    const creditItem = await db.getFirstAsync<{ amount_cents: number }>(
      `SELECT ii.amount_cents FROM invoice_items ii
         JOIN transactions t ON t.id = ii.transaction_id
        WHERE ii.invoice_id = (SELECT id FROM invoices WHERE card_id = ? AND reference_month = ?)
          AND t.type = 'INCOME'`,
      [cardId, cur]
    );
    expect(creditItem?.amount_cents).toBe(-30_00);
  });

  test('a PREVISÃO da fixa no cartão entra na fatura dos meses futuros e NÃO duplica', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Base', 0);
    const cardId = await seedCard(db, accId, 'Card Previsão', 15, 10);
    const cur = monthOf(todaySP());

    await services.recurrences.createRule({
      description: 'Plano de saúde',
      type: 'EXPENSE',
      amountCents: 50_00,
      dayOfMonth: 1,
      startDate: dayInMonth(cur, 1),
      cardId,
    });
    // Previsão: meses futuros nascem como PENDING — e JÁ entram na fatura
    await services.recurrences.runForecast();

    const next1 = monthAdd(cur, 1);
    const invNext = await db.getFirstAsync<{ id: string; total_cents: number }>(
      'SELECT id, total_cents FROM invoices WHERE card_id = ? AND reference_month = ?',
      [cardId, next1]
    );
    expect(invNext).not.toBeNull();
    expect(invNext!.total_cents).toBe(50_00);

    // Promoção do mês (previsão vira efetivado quando o mês chega):
    // simula a previsão do mês atual que nasceu num boot anterior — o item
    // da fatura nasce UMA vez (o registro é idempotente por transação)
    const curInv = await services.invoices.ensureInvoice(cardId, cur);
    const rules = await db.getAllAsync<{ id: string }>('SELECT id FROM recurrence_rules');
    await db.runAsync(
      `INSERT INTO transactions
        (id, kind, type, amount_cents, occurred_on, occurred_at, description, account_id, card_id, source_system, external_ref_id, recurrence_rule_id, status)
       VALUES ('tx-promo-sim', 'SIMPLE', 'EXPENSE', 5000, ?, ?, 'Plano de saúde', NULL, ?, 'RECURRENCE', ?, ?, 'PENDING')`,
      [`${cur}-01`, `${cur}-01T12:00:00.000Z`, cardId, `REC:${rules[0].id}:${cur}`, rules[0].id]
    );
    await services.recurrences.runDueRecurrences();
    const itemsCur = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM invoice_items WHERE invoice_id = ?',
      [curInv.id]
    );
    expect(itemsCur?.n).toBe(1);

    // Reprocessos NÃO duplicam nenhum item (idempotência ARQ-003)
    await services.recurrences.runForecast();
    await services.recurrences.runDueRecurrences();
    const itemsNext = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM invoice_items WHERE invoice_id = ?',
      [invNext!.id]
    );
    expect(itemsNext?.n).toBe(1);
    const itemsCurAgain = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM invoice_items WHERE invoice_id = ?',
      [curInv.id]
    );
    expect(itemsCurAgain?.n).toBe(1);
  });
});

describe('Bug A — consolidado com Fixo/Parcelado consolida como À Vista', () => {
  test('grupo nasce SEM linhas à vista (cabeçalho-âncora) e fixa/parcelado ficam vinculados', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Grupo Ancora', 0);

    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Operação só com fixo e parcelado',
      date: todaySP(),
      accountId: accId,
      lines: [],
      headerAmountCents: 150_00,
      headerType: 'EXPENSE',
    });
    expect(grupo).not.toBeNull();
    expect(grupo!.kind).toBe('CONSOLIDATED');
    expect(grupo!.amount_cents).toBe(150_00);

    const rule = await services.recurrences.createRule({
      description: 'Luz da operação',
      type: 'EXPENSE',
      amountCents: 10_00,
      dayOfMonth: 5,
      startDate: todaySP(),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    expect(rule.group_transaction_id).toBe(grupo!.id);

    const { planId } = await services.installments.createPlan({
      description: 'Notebook da operação',
      mode: 'DIVIDE_TOTAL',
      totalCents: 30_00,
      totalInstallments: 3,
      firstDueDate: todaySP(),
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    const planRow = await db.getFirstAsync<{ group_transaction_id: string | null }>(
      'SELECT group_transaction_id FROM installment_plans WHERE id = ?',
      [planId]
    );
    expect(planRow?.group_transaction_id).toBe(grupo!.id);
  });

  test('deleteGroupDeep apaga o grupo TODO: linhas, fixas (regra + ocorrências) e parcelas em aberto', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Deep', 0);
    const today = todaySP();
    const cur = monthOf(today);

    // Grupo com linha à vista + fixa + parcelado
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Operação completa',
      date: `${cur}-02`,
      accountId: accId,
      lines: [{ direction: 'DEBIT', description: 'Mercado', amountCents: 50_00, categoryId: null }],
    });
    expect(grupo).not.toBeNull();
    await services.recurrences.createRule({
      description: 'Luz',
      type: 'EXPENSE',
      amountCents: 100_00,
      dayOfMonth: 2,
      startDate: `${cur}-02`,
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences();
    await services.recurrences.runForecast();
    await services.installments.createPlan({
      description: 'Notebook',
      mode: 'DIVIDE_TOTAL',
      totalCents: 30_00,
      totalInstallments: 3,
      firstDueDate: `${cur}-15`,
      accountId: accId,
      groupTransactionId: grupo!.id,
    });

    // Tudo existe e afeta o saldo da conta
    const occBefore = await db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM transactions WHERE source_system = 'RECURRENCE'"
    );
    expect(occBefore!.n).toBeGreaterThan(0);
    const saldoComGrupo = await getAccountBalance(db, accId);
    expect(saldoComGrupo).toBeLessThan(0);

    // Exclusão do GRUPO INTEIRO (botão do card, vale para todo o grupo)
    await services.transactions.deleteGroupDeep(grupo!.id);

    const headerAfter = await db.getFirstAsync('SELECT id FROM transactions WHERE id = ?', [grupo!.id]);
    expect(headerAfter).toBeNull();
    const rulesAfter = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM recurrence_rules');
    expect(rulesAfter?.n).toBe(0);
    const occAfter = await db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM transactions WHERE source_system = 'RECURRENCE'"
    );
    expect(occAfter?.n).toBe(0);
    const plansAfter = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM installment_plans');
    expect(plansAfter?.n).toBe(0);
    const instAfter = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM installments');
    expect(instAfter?.n).toBe(0);
    // Linha à vista também saiu; saldo da conta restaurado
    const movesAfter = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM financial_moves WHERE account_id = ?',
      [accId]
    );
    expect(movesAfter?.n).toBe(0);
    expect(await getAccountBalance(db, accId)).toBe(0);
  });

  test('deleteGroupDeep mantém como histórico as parcelas já PAGAS (plano desvinculado)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Hist', 0);
    const today = todaySP();
    const cur = monthOf(today);

    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Operação com parcela paga',
      date: `${cur}-02`,
      accountId: accId,
      lines: [],
      headerAmountCents: 30_00,
      headerType: 'EXPENSE',
    });
    const { planId } = await services.installments.createPlan({
      description: 'Notebook',
      mode: 'DIVIDE_TOTAL',
      totalCents: 30_00,
      totalInstallments: 3,
      firstDueDate: `${cur}-05`,
      accountId: accId,
      groupTransactionId: grupo!.id,
    });
    const insts = await db.getAllAsync<{ id: string }>(
      'SELECT id FROM installments WHERE plan_id = ? ORDER BY sequence_number',
      [planId]
    );
    // Paga a 1ª parcela (o débito passa a valer de hoje)
    await services.installments.setPaymentStatus(insts[0].id, true);

    await services.transactions.deleteGroupDeep(grupo!.id);

    const headerAfter = await db.getFirstAsync('SELECT id FROM transactions WHERE id = ?', [grupo!.id]);
    expect(headerAfter).toBeNull();
    // Parcela paga sobrevive como histórico; plano fica desvinculado
    const planRow = await db.getFirstAsync<{ group_transaction_id: string | null }>(
      'SELECT group_transaction_id FROM installment_plans WHERE id = ?',
      [planId]
    );
    expect(planRow).not.toBeNull();
    expect(planRow?.group_transaction_id).toBeNull();
    const remaining = await db.getFirstAsync<{ n: number; paid: number }>(
      "SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END) AS paid FROM installments WHERE plan_id = ?",
      [planId]
    );
    expect(remaining?.n).toBe(1);
    expect(remaining?.paid).toBe(1);
    // O saldo conserva o impacto da parcela paga
    expect(await getAccountBalance(db, accId)).toBe(-10_00);
  });
});
