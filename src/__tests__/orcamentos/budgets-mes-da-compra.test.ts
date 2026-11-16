/**
 * v72 — ORÇAMENTO: regra do MÊS DA COMPRA (pedido do usuário).
 *  · "o orçamento é dentro do mês mesmo que o pagamento seja no próximo":
 *    parcelas (em conta e no cartão) somam NO MÊS DA COMPRA (âncora), o
 *    plano INTEIRO — nunca espalhado pelos vencimentos até 2027;
 *  · o pai cobre a SUBÁRVORE inteira: subitens SEM orçamento também entram
 *    no gasto do pai (antes escapavam da composição);
 *  · saldo do dia: compra no cartão (pendente OU efetivada) reserva desde a
 *    COMPRA até a véspera da fatura — o saldo desce na compra e fica descido
 *    até o pagamento.
 *  Roda: npx jest src/__tests__/budgets-mes-da-compra.test.ts
 */

import { makeCtx, seedAccount, seedCategory } from '../helpers';
import { todaySP, monthOf, monthAdd, dayInMonth, lastDayNumberOf } from '../../lib/dates';

const mes = () => monthOf(todaySP());

describe('v72 Orçamento — parcelas pelo MÊS DA COMPRA', () => {
  test('plano comprado no mês soma INTEIRO no mês da compra; meses seguintes não herdam', async () => {
    const { db, services } = await makeCtx();
    const acc = await seedAccount(db, 'Conta Parcelas V72');
    // v88: o app não cria mais categorias de seed — o teste cria a sua
    await seedCategory(db, 'Compras', 'cat-compras');
    const mesCompra = mes();
    const primeiroVenc = monthAdd(mesCompra, 1);

    // âncora: compra de 1.200,00 em cat-compras no dia 5 do mês corrente
    await db.runAsync(
      `INSERT INTO transactions (id, kind, type, amount_cents, occurred_on, occurred_at, description, category_id, account_id, source_system, status)
       VALUES ('tx-anc-v72', 'SIMPLE', 'EXPENSE', 120000, ?, ?, 'Notebook 12x', 'cat-compras', ?, 'MANUAL', 'CONFIRMED')`,
      [`${mesCompra}-05`, `${mesCompra}-05T12:00:00.000Z`, acc]
    );
    await db.runAsync(
      `INSERT INTO installment_plans (id, original_transaction_id, total_installments, mode, total_cents, first_due_date, account_id)
       VALUES ('plan-v72', 'tx-anc-v72', 12, 'DIVIDE_TOTAL', 120000, ?, ?)`,
      [`${primeiroVenc}-10`, acc]
    );
    // 12 parcelas de 100,00 — vencem nos 12 meses SEGUINTES à compra
    for (let i = 1; i <= 12; i++) {
      await db.runAsync(
        'INSERT INTO installments (id, plan_id, sequence_number, amount_cents, due_date, status) VALUES (?,?,?,?,?,?)',
        [`inst-v72-${i}`, 'plan-v72', i, 10_000, dayInMonth(monthAdd(primeiroVenc, i - 1), 10), 'PENDING']
      );
    }
    await services.budgets.save('cat-compras', 150_000);

    // MÊS DA COMPRA: o plano inteiro (1.200) entra — não só a 1ª parcela;
    // a âncora (1.200) NÃO conta em dobro.
    const sumCompra = await services.budgets.getMonthSummary(mesCompra);
    const compras = sumCompra.items.find((i) => i.categoryId === 'cat-compras')!;
    expect(compras.spentCents).toBe(120_000);
    expect(compras.previstoCents).toBe(120_000); // parcelas em aberto = Previsto
    expect(compras.efetivadoCents).toBe(0);

    // MÊS SEGUINTE: nada — o vencimento das parcelas não interessa ao orçamento
    const sumProx = await services.budgets.getMonthSummary(primeiroVenc);
    const comprasProx = sumProx.items.find((i) => i.categoryId === 'cat-compras')!;
    expect(comprasProx.spentCents).toBe(0);
  });

  test('parcelas QUITADAS viram Gasto (efetivado) no mês da compra', async () => {
    const { db, services } = await makeCtx();
    const acc = await seedAccount(db, 'Conta Quitadas V72');
    // v88: o app não cria mais categorias de seed — o teste cria a sua
    await seedCategory(db, 'Compras', 'cat-compras');
    const mesCompra = mes();

    await db.runAsync(
      `INSERT INTO transactions (id, kind, type, amount_cents, occurred_on, occurred_at, description, category_id, account_id, source_system, status)
       VALUES ('tx-anc-v72b', 'SIMPLE', 'EXPENSE', 30000, ?, ?, 'Móvel 3x', 'cat-compras', ?, 'MANUAL', 'CONFIRMED')`,
      [`${mesCompra}-05`, `${mesCompra}-05T12:00:00.000Z`, acc]
    );
    await db.runAsync(
      `INSERT INTO installment_plans (id, original_transaction_id, total_installments, mode, total_cents, first_due_date, account_id)
       VALUES ('plan-v72b', 'tx-anc-v72b', 3, 'DIVIDE_TOTAL', 30000, ?, ?)`,
      [`${monthAdd(mesCompra, 1)}-10`, acc]
    );
    const statuses = ['PAID', 'PAID', 'PENDING'];
    for (let i = 1; i <= 3; i++) {
      await db.runAsync(
        'INSERT INTO installments (id, plan_id, sequence_number, amount_cents, due_date, status) VALUES (?,?,?,?,?,?)',
        [`inst-v72b-${i}`, 'plan-v72b', i, 10_000, dayInMonth(monthAdd(mesCompra, i), 10), statuses[i - 1]]
      );
    }
    await services.budgets.save('cat-compras', 50_000);

    const sum = await services.budgets.getMonthSummary(mesCompra);
    const compras = sum.items.find((i) => i.categoryId === 'cat-compras')!;
    expect(compras.spentCents).toBe(30_000); // comprometido = plano inteiro
    expect(compras.efetivadoCents).toBe(20_000); // 2 parcelas pagas
    expect(compras.previstoCents).toBe(10_000); // 1 parcela em aberto
  });
});

describe('v72 Orçamento — pai cobre a SUBÁRVORE inteira', () => {
  test('subitem SEM orçamento entra no gasto do pai (nada escapa da composição)', async () => {
    const { services } = await makeCtx();
    const pai = await services.categories.create({ name: 'Casa V72', direction: 'DEBIT' });
    const sub1 = await services.categories.create({ name: 'Cozinha V72', direction: 'DEBIT', parentId: pai.id });
    const sub2 = await services.categories.create({ name: 'Lavanderia V72', direction: 'DEBIT', parentId: pai.id });
    await services.budgets.save(pai.id, 100_00);
    await services.budgets.save(sub1.id, 60_00); // só UM subitem orçado; sub2 sem orçamento

    const acc = await seedAccount(services.db);
    const m = mes();
    await services.transactions.createAccountExpense({ description: 'Feijão', amountCents: 3_000, accountId: acc, categoryId: sub1.id, date: `${m}-05` });
    await services.transactions.createAccountExpense({ description: 'Sabão', amountCents: 2_000, accountId: acc, categoryId: sub2.id, date: `${m}-06` });
    await services.transactions.createAccountExpense({ description: 'Hydra', amountCents: 500, accountId: acc, categoryId: pai.id, date: `${m}-07` });

    const sum = await services.budgets.getMonthSummary(m);
    const paiItem = sum.items.find((i) => i.categoryId === pai.id)!;
    const s1 = sum.items.find((i) => i.categoryId === sub1.id)!;
    // pai: gasto = próprio (5) + subárvore inteira (30 orçado + 20 SEM orçamento)
    expect(paiItem.spentCents).toBe(5_500);
    expect(paiItem.amountCents).toBe(60_00); // composto = soma dos subitens ORÇADOS
    expect(paiItem.efetivadoCents).toBe(5_500);
    expect(s1.partOfParent).toBe(true);
    // totais: pai 1× — sub2 (sem orçamento) não vaza nem em dobro nem fora
    expect(sum.budgetedCents).toBe(60_00);
    expect(sum.spentCents).toBe(5_500);
    expect(sum.remainingCents).toBe(500);
  });
});

describe('v72 Orçamento — saldo desce NA COMPRA e fica até o pagamento', () => {
  test('compra EFETIVADA no cartão reserva desde a compra até a véspera da fatura', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Conta Cartao V72', 50_000);
    const card = `card-${Math.random().toString(36).slice(2, 8)}`;
    await services.db.runAsync(
      'INSERT INTO cards (id, name, last_four_digits, closing_day, due_day, linked_account_id) VALUES (?,?,?,?,?,?)',
      [card, 'Cartão V72', '9988', 20, 28, acc]
    );
    const cat = await services.categories.create({ name: 'Cartao V72', direction: 'DEBIT' });
    await services.budgets.save(cat.id, 200_000);
    const compra = await services.transactions.createCardExpense({
      description: 'Compra no cartão', amountCents: 30_000, cardId: card, date: `${mes()}-02`, categoryId: cat.id,
    });
    // v72: a compra EFETIVADA também reserva (antes só a pendente reservava)
    await services.db.runAsync("UPDATE transactions SET status = 'CONFIRMED' WHERE id = ?", [compra.id]);
    const adj = await services.budgets.getMonthFluxAdjust(mes(), [acc]);
    const dia3 = `${mes()}-03`;
    const fim = `${mes()}-${String(lastDayNumberOf(mes())).padStart(2, '0')}`;
    // desce NA COMPRA (no previsto, pois já saiu da fila de pendências)…
    expect(adj.efetivado[dia3]).toBeLessThanOrEqual(-30_000);
    // …e não dobra depois da fatura vencer (o saldo base assume)
    expect(adj.efetivado[fim]).toBe(0);
  });

  test('compra PENDENTE no cartão segue reservando (v68 intacto)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Conta Cartao V72b', 50_000);
    const card = `card-${Math.random().toString(36).slice(2, 8)}`;
    await services.db.runAsync(
      'INSERT INTO cards (id, name, last_four_digits, closing_day, due_day, linked_account_id) VALUES (?,?,?,?,?,?)',
      [card, 'Cartão V72b', '7766', 20, 28, acc]
    );
    const cat = await services.categories.create({ name: 'Cartao V72b', direction: 'DEBIT' });
    await services.budgets.save(cat.id, 200_000);
    const compra = await services.transactions.createCardExpense({
      description: 'Compra futura', amountCents: 15_000, cardId: card, date: `${mes()}-02`, categoryId: cat.id,
    });
    await services.db.runAsync("UPDATE transactions SET status = 'PENDING' WHERE id = ?", [compra.id]);
    const adj = await services.budgets.getMonthFluxAdjust(mes(), [acc]);
    const dia3 = `${mes()}-03`;
    expect(adj.previsto[dia3]).toBeLessThanOrEqual(-15_000);
    expect(adj.efetivado[dia3] ?? 0).toBe(0);
  });
});
