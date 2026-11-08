/** Fase 3 — Parcelamentos: divisão de centavos, visão dual e moves future-dated. */

import { makeCtx, seedAccount, seedCard, getAccountBalance, expectRejects } from './helpers';

describe('InstallmentService', () => {
  test('DIVIDE_TOTAL: resto fica na última parcela (sem perder centavos)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc);
    const { planId } = await services.installments.createPlan({
      description: 'Notebook', mode: 'DIVIDE_TOTAL', totalCents: 100001,
      totalInstallments: 3, firstDueDate: '2026-06-10', cardId: card, purchaseDate: '2026-05-20',
    });
    const dual = await services.installments.getDualView(planId)!;
    const amounts = dual!.cashFlow.map((c) => c.amountCents);
    expect(amounts).toEqual([33333, 33333, 33335]);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(100001);
  });

  test('visão dual separa fluxo (vencimentos) de custo (data da compra) — regra de ouro', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc);
    const { planId } = await services.installments.createPlan({
      description: 'Notebook', mode: 'DIVIDE_TOTAL', totalCents: 120000,
      totalInstallments: 12, firstDueDate: '2026-06-10', cardId: card, purchaseDate: '2026-05-20',
    });
    const dual = (await services.installments.getDualView(planId))!;
    // cost_report: total na data ORIGINAL da compra
    expect(dual.costReport.occurredOn).toBe('2026-05-20');
    expect(dual.costReport.totalCents).toBe(120000);
    // cash_flow: parcelas espalhadas a partir do primeiro vencimento
    expect(dual.cashFlow).toHaveLength(12);
    expect(dual.cashFlow[0].dueDate).toBe('2026-06-10');
    expect(dual.cashFlow[11].dueDate).toBe('2027-05-10'); // clamp não afeta dia 10
  });

  test('parcelas em cartão caem nas faturas corretas pelos vencimentos', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc, 'Nu', 15, 10);
    await services.installments.createPlan({
      description: 'Celular', mode: 'FIXED_PER_MONTH', fixedAmountCents: 20000,
      totalInstallments: 3, firstDueDate: '2026-06-10', cardId: card, purchaseDate: '2026-05-14',
    });
    const invoices = await services.db.getAllAsync<{ reference_month: string; total_cents: number }>(
      'SELECT reference_month, total_cents FROM invoices ORDER BY reference_month'
    );
    // parcelas 06/10, 07/10, 08/10 -> faturas 06, 07, 08 com 20000 cada
    expect(invoices.map((i) => i.reference_month)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(invoices.every((i) => i.total_cents === 20000)).toBe(true);
  });

  test('parcelas em CONTA geram moves future-dated (saldo não cai antes)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Conta', 1000);
    await services.installments.createPlan({
      description: 'Dívida amigo', mode: 'FIXED_PER_MONTH', fixedAmountCents: 10000,
      totalInstallments: 4, firstDueDate: '2026-12-05', accountId: acc,
    });
    // Hoje (out/2026) não deve incluir as parcelas de dezembro — liquidez usa todaySP()
    const bal = await services.balance.getAccountBalance(acc);
    expect(bal).toBe(1000);
    const moves = await services.db.getAllAsync<{ effective_date: string; amount_cents: number }>(
      "SELECT effective_date, amount_cents FROM financial_moves WHERE installment_id IS NOT NULL ORDER BY effective_date"
    );
    expect(moves).toHaveLength(4);
    expect(moves[0].effective_date).toBe('2026-12-05');
    expect(moves.every((m) => m.amount_cents === 10000)).toBe(true);
  });

  test('modo FIXED_PER_MONTH soma total correto na transação original', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc);
    await services.installments.createPlan({
      description: 'X', mode: 'FIXED_PER_MONTH', fixedAmountCents: 9999,
      totalInstallments: 5, firstDueDate: '2026-06-10', cardId: card,
    });
    const tx = await services.db.getFirstAsync<{ amount_cents: number; kind: string }>(
      "SELECT amount_cents, kind FROM transactions WHERE source_system = 'INSTALLMENT'"
    );
    expect(tx?.amount_cents).toBe(49995);
    expect(tx?.kind).toBe('CONSOLIDATED');
  });

  test('plano exige cartão XOR conta', async () => {
    const { services } = await makeCtx();
    await expect(
      services.installments.createPlan({
        description: 'inválido', mode: 'DIVIDE_TOTAL', totalCents: 1000,
        totalInstallments: 2, firstDueDate: '2026-06-10',
      })
    ).rejects.toThrow();
  });

  test('financiamento longo: 360 parcelas (30 anos) — total preservado, faturas mês a mês', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc, 'Cartão Financiamento');

    const total = 60_000_00; // R$ 60.000,00 em 360x = financiamento de 30 anos
    const t0 = Date.now();
    const { planId } = await services.installments.createPlan({
      description: 'Financiamento imóvel 30 anos',
      mode: 'DIVIDE_TOTAL',
      totalCents: total,
      totalInstallments: 360,
      firstDueDate: '2026-01-10',
      cardId: card,
      purchaseDate: '2026-01-05',
    });
    // eslint-disable-next-line no-console
    console.log(`[stress 360x] plano criado em ${Date.now() - t0}ms`);

    const insts = await services.db.getAllAsync<{ amount_cents: number; due_date: string; sequence_number: number }>(
      'SELECT amount_cents, due_date, sequence_number FROM installments WHERE plan_id = ? ORDER BY sequence_number',
      [planId]
    );
    expect(insts).toHaveLength(360);
    // Soma exata: nada se perde em 30 anos (ARQ-001)
    expect(insts.reduce((a, b) => a + b.amount_cents, 0)).toBe(total);
    // Datas: 1ª = 10/01/2026 → 360ª = 10/12/2055 (360 meses corridos a partir da 1ª)
    expect(insts[0].due_date).toBe('2026-01-10');
    expect(insts[359].due_date).toBe('2055-12-10');
    // Resto da divisão inteira vai para a última parcela (padrão bancário)
    const base = Math.floor(total / 360);
    expect(insts[0].amount_cents).toBe(base);
    expect(insts[359].amount_cents).toBe(base + (total - base * 360));

    // 360 faturas mensais distintas no cartão
    const faturas = await services.db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM invoices');
    expect(faturas?.c).toBe(360);

    // Visão dual completa: fluxo de 360 vencimentos + saldo remanescente cheio
    const dual = (await services.installments.getDualView(planId))!;
    expect(dual.cashFlow).toHaveLength(360);
    expect(dual.costReport.occurredOn).toBe('2026-01-05');
    expect(dual.costReport.totalCents).toBe(total);
    expect(dual.remainingCents).toBe(total);

    // Fatura de um mês qualquer contém exatamente 1 parcela
    const itemsFatura = await services.db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.reference_month = '2040-06'`
    );
    expect(itemsFatura?.c).toBe(1);
  }, 120_000);

  test('editar valores: cartão — pagas intactas, da atual em diante muda (v7.0.5)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc, 'Cartão Edit');

    // 12x de R$ 100 no cartão
    const { planId } = await services.installments.createPlan({
      description: 'Plano editável', mode: 'FIXED_PER_MONTH', fixedAmountCents: 100_00,
      totalInstallments: 12, firstDueDate: '2026-01-10', cardId: card, purchaseDate: '2026-01-05',
    });
    // Simula 3 parcelas já pagas (1..3)
    await services.db.runAsync(
      "UPDATE installments SET status = 'PAID' WHERE plan_id = ? AND sequence_number <= 3", [planId]
    );

    const res = await services.installments.updateFromCurrent(planId, { fixedAmountCents: 150_00 });
    expect(res.fromSequence).toBe(4);
    expect(res.updatedCount).toBe(9);

    const insts = await services.db.getAllAsync<{ sequence_number: number; amount_cents: number; status: string }>(
      'SELECT sequence_number, amount_cents, status FROM installments WHERE plan_id = ? ORDER BY sequence_number', [planId]
    );
    // Anteriores intocadas
    expect(insts.filter((i) => i.sequence_number <= 3).every((i) => i.amount_cents === 10_000 && i.status === 'PAID')).toBe(true);
    // Da atual em diante com o novo valor
    expect(insts.filter((i) => i.sequence_number >= 4).every((i) => i.amount_cents === 15_000 && i.status === 'PENDING')).toBe(true);

    // Itens de fatura: meses 1..3 continuam 10.000; meses 4..12 viraram 15.000
    const itensAntigos = await services.db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM invoice_items ii JOIN installments i ON i.id = ii.installment_id
        WHERE i.plan_id = ? AND i.sequence_number <= 3 AND ii.amount_cents = 10000`, [planId]
    );
    expect(itensAntigos?.c).toBe(3);
    const itensNovos = await services.db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM invoice_items ii JOIN installments i ON i.id = ii.installment_id
        WHERE i.plan_id = ? AND i.sequence_number >= 4 AND ii.amount_cents = 15000`, [planId]
    );
    expect(itensNovos?.c).toBe(9);

    // Lançamento consolidado recalculado: 3 pagas + 9 novas
    const tx = await services.db.getFirstAsync<{ amount_cents: number }>(
      "SELECT amount_cents FROM transactions WHERE source_system = 'INSTALLMENT'"
    );
    expect(tx?.amount_cents).toBe(3 * 10_000 + 9 * 15_000);
  });

  test('editar valores: conta — moves future-dated mudam, pagas intactas (v7.0.5)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);

    // 10x dividindo R$ 1.000 (R$ 100/mês) na CONTA
    const { planId } = await services.installments.createPlan({
      description: 'Financiamento conta', mode: 'DIVIDE_TOTAL', totalCents: 100_000,
      totalInstallments: 10, firstDueDate: '2026-01-05', accountId: acc, purchaseDate: '2026-01-02',
    });
    await services.db.runAsync(
      "UPDATE installments SET status = 'PAID' WHERE plan_id = ? AND sequence_number <= 2", [planId]
    );

    // Restante passa a ser R$ 960 em 8 parcelas = R$ 120 cada
    await services.installments.updateFromCurrent(planId, { remainingTotalCents: 96_000 });

    const insts = await services.db.getAllAsync<{ sequence_number: number; amount_cents: number }>(
      'SELECT sequence_number, amount_cents FROM installments WHERE plan_id = ? ORDER BY sequence_number', [planId]
    );
    expect(insts.filter((i) => i.sequence_number <= 2).every((i) => i.amount_cents === 10_000)).toBe(true);
    expect(insts.filter((i) => i.sequence_number >= 3).every((i) => i.amount_cents === 12_000)).toBe(true);

    // Moves futuras acompanham; pagas não mudam
    const moves = await services.db.getAllAsync<{ amount_cents: number; effective_date: string }>(
      'SELECT amount_cents, effective_date FROM financial_moves WHERE installment_id IS NOT NULL ORDER BY effective_date'
    );
    expect(moves).toHaveLength(10);
    expect(moves.filter((m) => m.effective_date < '2026-03-01').every((m) => m.amount_cents === 10_000)).toBe(true);
    expect(moves.filter((m) => m.effective_date >= '2026-03-01').every((m) => m.amount_cents === 12_000)).toBe(true);

    // Consolidado = pagas (200) + restante novo (960)
    const tx = await services.db.getFirstAsync<{ amount_cents: number }>(
      "SELECT amount_cents FROM transactions WHERE source_system = 'INSTALLMENT'"
    );
    expect(tx?.amount_cents).toBe(116_000);
  });

  test('excluir: cartão — "apenas este" cancela só a atual; pagas e demais intactas (v7.0.6)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc, 'Cartão Excluir');

    // 12x de R$ 100 no cartão
    const { planId } = await services.installments.createPlan({
      description: 'Plano com exclusão', mode: 'FIXED_PER_MONTH', fixedAmountCents: 100_00,
      totalInstallments: 12, firstDueDate: '2026-01-10', cardId: card, purchaseDate: '2026-01-05',
    });
    await services.db.runAsync(
      "UPDATE installments SET status = 'PAID' WHERE plan_id = ? AND sequence_number <= 3", [planId]
    );

    const res = await services.installments.cancelFromCurrent(planId, { onlyCurrent: true });
    expect(res.canceledCount).toBe(1);
    expect(res.firstSequence).toBe(4);
    expect(res.paidCount).toBe(3);
    expect(res.remainingCount).toBe(8);
    expect(res.newTotalCents).toBe(11 * 10_000); // consolidado = 3 pagas + 8 restantes

    const insts = await services.db.getAllAsync<{ sequence_number: number; status: string }>(
      'SELECT sequence_number, status FROM installments WHERE plan_id = ? ORDER BY sequence_number', [planId]
    );
    expect(insts.find((i) => i.sequence_number === 4)!.status).toBe('CANCELED');
    expect(insts.filter((i) => i.sequence_number <= 3).every((i) => i.status === 'PAID')).toBe(true);
    expect(insts.filter((i) => i.sequence_number >= 5).every((i) => i.status === 'PENDING')).toBe(true);

    // Item de fatura da parcela 4 saiu; das demais continuam
    const itens = await services.db.getAllAsync<{ sequence_number: number | null }>(
      `SELECT i.sequence_number AS sequence_number FROM invoice_items ii JOIN installments i ON i.id = ii.installment_id
        WHERE i.plan_id = ? ORDER BY i.sequence_number`, [planId]
    );
    expect(itens.map((r) => r.sequence_number)).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test('excluir: "este e as próximas" — todas em aberto canceladas, consolidado = pagas (v7.0.6)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const card = await seedCard(services.db, acc, 'Cartão Encerrar');

    // 6x dividindo R$ 1.200 (R$ 200/mês)
    const { planId } = await services.installments.createPlan({
      description: 'Compra a encerrar', mode: 'DIVIDE_TOTAL', totalCents: 120_000,
      totalInstallments: 6, firstDueDate: '2026-01-10', cardId: card, purchaseDate: '2026-01-05',
    });
    await services.db.runAsync(
      "UPDATE installments SET status = 'PAID' WHERE plan_id = ? AND sequence_number <= 2", [planId]
    );

    const res = await services.installments.cancelFromCurrent(planId, { onlyCurrent: false });
    expect(res.canceledCount).toBe(4);
    expect(res.paidCount).toBe(2);
    expect(res.remainingCount).toBe(0);
    expect(res.newTotalCents).toBe(2 * 20_000); // custo real = só o que foi pago

    const insts = await services.db.getAllAsync<{ sequence_number: number; status: string }>(
      'SELECT sequence_number, status FROM installments WHERE plan_id = ? ORDER BY sequence_number', [planId]
    );
    expect(insts.filter((i) => i.sequence_number <= 2).every((i) => i.status === 'PAID')).toBe(true);
    expect(insts.filter((i) => i.sequence_number >= 3).every((i) => i.status === 'CANCELED')).toBe(true);

    // Faturas 3..6 ficaram sem itens (totais zerados)
    const itensRestantes = await services.db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM invoice_items ii JOIN installments i ON i.id = ii.installment_id
        WHERE i.plan_id = ? AND i.sequence_number >= 3`, [planId]
    );
    expect(itensRestantes?.c).toBe(0);

    // Consolidado (custo total) = somente as pagas
    const tx = await services.db.getFirstAsync<{ amount_cents: number }>(
      "SELECT amount_cents FROM transactions WHERE source_system = 'INSTALLMENT'"
    );
    expect(tx?.amount_cents).toBe(40_000);
  });

  test('excluir: conta — débitos das canceladas são APAGADOS (v18: exclusão física)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Conta', 1000);

    // 4x de R$ 100 na conta
    const { planId } = await services.installments.createPlan({
      description: 'Dívida a excluir', mode: 'FIXED_PER_MONTH', fixedAmountCents: 10_000,
      totalInstallments: 4, firstDueDate: '2026-01-05', accountId: acc, purchaseDate: '2026-01-02',
    });
    await services.db.runAsync(
      "UPDATE installments SET status = 'PAID' WHERE plan_id = ? AND sequence_number = 1", [planId]
    );

    const res = await services.installments.cancelFromCurrent(planId, { onlyCurrent: false });
    expect(res.canceledCount).toBe(3);
    expect(res.newTotalCents).toBe(10_000);

    // v18 (bug 2): mesma regra da exclusão pelo Fluxo — os débitos das
    // canceladas são apagados de verdade (só a paga mantém movimento)
    const moves = await services.db.getAllAsync<{ effective_date: string; status: string }>(
      'SELECT effective_date, status FROM financial_moves WHERE installment_id IS NOT NULL ORDER BY effective_date'
    );
    expect(moves).toHaveLength(1);
    expect(moves[0].status).toBe('CONFIRMED');

    // Consolidado = somente a paga
    const tx = await services.db.getFirstAsync<{ amount_cents: number }>(
      "SELECT amount_cents FROM transactions WHERE source_system = 'INSTALLMENT'"
    );
    expect(tx?.amount_cents).toBe(10_000);
  });

  test('v10: excluir compra parcelada — parcelas PENDENTES saem do banco; plano segue só com o histórico pago', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Conta', 1000);

    // 4x de R$ 100 na conta; apenas a 1ª paga
    const { planId, transactionId } = await services.installments.createPlan({
      description: 'Dívida', mode: 'FIXED_PER_MONTH', fixedAmountCents: 10_000,
      totalInstallments: 4, firstDueDate: '2026-01-05', accountId: acc, purchaseDate: '2026-01-02',
    });
    await services.db.runAsync(
      "UPDATE installments SET status = 'PAID' WHERE plan_id = ? AND sequence_number = 1", [planId]
    );

    await services.transactions.deleteTransaction(transactionId);

    // Transação da compra APAGADA fisicamente
    const txRow = await services.db.getFirstAsync('SELECT id FROM transactions WHERE id = ?', [transactionId]);
    expect(txRow).toBeNull();
    // Sobrou apenas a parcela PAGA; as pendentes saíram do banco
    const insts = await services.db.getAllAsync<{ sequence_number: number; status: string }>(
      'SELECT sequence_number, status FROM installments WHERE plan_id = ? ORDER BY sequence_number', [planId]
    );
    expect(insts).toHaveLength(1);
    expect(insts[0]).toEqual({ sequence_number: 1, status: 'PAID' });
    // Plano desvinculado da compra excluída (histórico preservado)
    const plan = await services.db.getFirstAsync<{ original_transaction_id: string | null }>(
      'SELECT original_transaction_id FROM installment_plans WHERE id = ?', [planId]
    );
    expect(plan?.original_transaction_id).toBeNull();
  });

  test('v10: excluir compra parcelada sem nenhuma paga apaga plano e parcelas por completo', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Conta', 0);

    const { planId, transactionId } = await services.installments.createPlan({
      description: 'Compra a excluir', mode: 'DIVIDE_TOTAL', totalCents: 30_000,
      totalInstallments: 3, firstDueDate: '2026-02-10', accountId: acc, purchaseDate: '2026-01-30',
    });

    await services.transactions.deleteTransaction(transactionId);

    const insts = await services.db.getFirstAsync<{ c: number }>(
      'SELECT COUNT(*) AS c FROM installments WHERE plan_id = ?', [planId]
    );
    expect(insts?.c).toBe(0);
    const plan = await services.db.getFirstAsync('SELECT id FROM installment_plans WHERE id = ?', [planId]);
    expect(plan).toBeNull();
    const txRow = await services.db.getFirstAsync('SELECT id FROM transactions WHERE id = ?', [transactionId]);
    expect(txRow).toBeNull();
  });
});
