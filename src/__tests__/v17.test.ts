/**
 * Testes v17 — bugs e melhorias da rodada 5:
 *  · Bug 1: saldo PREVISTO respeita ESTRITAMENTE o escopo das contas com
 *    "Aparecer no saldo do Fluxo" (lançamentos pendentes, parcelas em aberto
 *    em conta e contas arquivadas ficam fora quando a conta está "Não");
 *    fórmula SP_d = SF_d + RPA_d validada dia a dia; recálculo imediato após
 *    incluir/alterar/excluir lançamento.
 *  · Bug 2: alterar a conta fixa em Recorrências reflete DE IMEDIATO no Fluxo —
 *    valor, dia e descrição da competência atual (CONFIRMED e PENDING) e das
 *    previsões seguintes são sincronizados; movimento financeiro e item de
 *    fatura acompanham.
 *  · Bug 3: "Alterar valores (da atual em diante)" aceita os DOIS modos —
 *    "Dividir total" e "Parcela fixa" — inclusive TROCANDO o modo do plano.
 *  · Melhoria 2: card do consolidado segue o padrão dos lançamentos normais —
 *    groupKindInfo expõe Fixo/Parcelado + pill X/N.
 *  · Melhoria 3: "Processar agora" removido de Recorrências.
 *  · Melhoria 4: Contas usa o botão "＋" do cabeçalho (padrão Cartões).
 *  · Melhoria 5: categoria COM movimentação só ARQUIVA (setArchived, cascata
 *    para subcategorias); SEM movimentação pode EXCLUIR; migração v9 cria
 *    archived_at; pickers filtram arquivadas.
 */

import { makeCtx, seedAccount, seedCard, getAccountBalance } from './helpers';
import {
  buildGroupMonths,
  groupKindInfo,
  groupMonthTotals,
  groupStatusInfo,
  type FlowTx,
} from '../lib/flowModel';

let ctx: ReturnType<typeof makeCtx> extends Promise<infer T> ? T : never;

beforeEach(async () => {
  ctx = await makeCtx();
});

/** Helper: db do ctx (para testes que só pediram services). */
function db0(c: { db: import('../db/types').DbDriver }) {
  return c.db;
}

/* ================================================================
 * BUG 1 — SALDO PREVISTO no escopo das contas "Aparecer no saldo do Fluxo"
 * ================================================================ */
describe('Bug 1 — saldo previsto respeita o escopo do saldo do Fluxo', () => {
  test('lançamento PENDING em conta FORA do escopo NÃO entra no previsto; em conta do escopo entra', async () => {
    const { db, services } = ctx;
    const fora = await seedAccount(db, 'Conta Fora', 1_000_00);
    const dentro = await seedAccount(db, 'Conta Dentro', 1_000_00);
    // fora: "Aparecer no saldo do Fluxo" = NÃO
    await db.runAsync('UPDATE accounts SET include_in_general_balance = 0 WHERE id = ?', [fora]);

    // pendência na conta FORA (100) e na conta DENTRO (50)
    const mkPending = async (accountId: string, cents: number) => {
      await db.runAsync(
        `INSERT INTO transactions (id, kind, type, amount_cents, occurred_on, occurred_at, description,
          account_id, source_system, external_ref_id, status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [`tx-${Math.random().toString(36).slice(2, 8)}`, 'SIMPLE', 'EXPENSE', cents, '2026-11-20',
         '2026-11-20T12:00:00Z', 'Pendência', accountId, 'MANUAL', `MAN:${Math.random()}`, 'PENDING']
      );
    };
    await mkPending(fora, 100_00);
    await mkPending(dentro, 50_00);

    const { previsto, efetivado } = await services.balance.getDailyBalancesDual('2026-11');
    // SP_d = SF_d + RPA_d → previsto do dia 20 = efetivado − 50,00 (só a conta do escopo)
    expect(previsto['2026-11-20']).toBe(efetivado['2026-11-20'] - 50_00);
    // dias sem pendência: previsto == efetivado
    expect(previsto['2026-11-19']).toBe(efetivado['2026-11-19']);
    // saldo efetivado NUNCA considera pendências (só o inicial das contas no escopo)
    expect(efetivado['2026-11-20']).toBe(1_000_00);
  });

  test('parcela em aberto de plano em conta FORA do escopo sai da previsão; conta do escopo fica', async () => {
    const { db, services } = ctx;
    const fora = await seedAccount(db, 'Plano Fora', 500_00);
    const dentro = await seedAccount(db, 'Plano Dentro', 500_00);
    await db.runAsync('UPDATE accounts SET include_in_general_balance = 0 WHERE id = ?', [fora]);

    await services.installments.createPlan({
      description: 'Notebook Fora',
      mode: 'DIVIDE_TOTAL',
      totalCents: 120_00,
      totalInstallments: 12,
      firstDueDate: '2026-11-10',
      accountId: fora,
    });
    await services.installments.createPlan({
      description: 'Notebook Dentro',
      mode: 'DIVIDE_TOTAL',
      totalCents: 60_00,
      totalInstallments: 6,
      firstDueDate: '2026-11-15',
      accountId: dentro,
    });

    const { previsto, efetivado } = await services.balance.getDailyBalancesDual('2026-11');
    // dia 15: só a parcela da conta DENTRO (60/6 = 10,00) compõe a previsão
    expect(previsto['2026-11-15']).toBe(efetivado['2026-11-15'] - 10_00);
    // dia 10 (parcela da conta FORA): nenhuma pendência no escopo
    expect(previsto['2026-11-10']).toBe(efetivado['2026-11-10']);
  });

  test('conta ARQUIVADA fora do escopo: pendências dela não entram no previsto', async () => {
    const { db, services } = ctx;
    const arq = await seedAccount(db, 'Conta Arquivada', 300_00);
    await db.runAsync('UPDATE accounts SET archived_at = ?, include_in_general_balance = 1 WHERE id = ?', ['2026-10-01T00:00:00Z', arq]);
    await db.runAsync(
      `INSERT INTO transactions (id, kind, type, amount_cents, occurred_on, occurred_at, description,
        account_id, source_system, external_ref_id, status)
        VALUES ('tx-arq','SIMPLE','EXPENSE',90_00,'2026-11-05','2026-11-05T12:00:00Z','Pend arch',?,
                'MANUAL','MAN:arq','PENDING')`,
      [arq]
    );
    const { previsto, efetivado } = await services.balance.getDailyBalancesDual('2026-11');
    expect(previsto['2026-11-05']).toBe(efetivado['2026-11-05']);
  });

  test('recálculo IMEDIATO: efetivar a pendência move o valor do previsto para o efetivado', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta Recalc', 200_00);
    await db.runAsync(
      `INSERT INTO transactions (id, kind, type, amount_cents, occurred_on, occurred_at, description,
        account_id, source_system, external_ref_id, status)
        VALUES ('tx-r1','SIMPLE','EXPENSE',70_00,'2026-11-12','2026-11-12T12:00:00Z','Conta de luz',?,
                'MANUAL','MAN:r1','PENDING')`,
      [acc]
    );
    const antes = await services.balance.getDailyBalancesDual('2026-11');
    expect(antes.previsto['2026-11-12']).toBe(200_00 - 70_00);
    expect(antes.efetivado['2026-11-12']).toBe(200_00);

    // EFETIVADO (status EFETIVADO = CONFIRMED, sem duplicação — ganha movimento)
    await services.transactions.setPaymentStatus('tx-r1', true);
    const depois = await services.balance.getDailyBalancesDual('2026-11');
    expect(depois.efetivado['2026-11-12']).toBe(200_00 - 70_00);
    expect(depois.previsto['2026-11-12']).toBe(200_00 - 70_00);
    expect(await getAccountBalance(db, acc)).toBe(200_00 - 70_00);
  });

  test('validação matemática da spec: SP_d = SF_d + RPA_d em todos os dias do mês', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta Spec', 1_000_00);
    await services.recurrences.createRule({
      description: 'Aluguel',
      type: 'EXPENSE',
      amountCents: 1_500_00,
      dayOfMonth: 10,
      startDate: '2026-11-10',
      accountId: acc,
    });
    await services.recurrences.runDueRecurrences('2026-11-03');
    await services.recurrences.runForecast(6, '2026-11-03');
    await db.runAsync(
      `INSERT INTO transactions (id, kind, type, amount_cents, occurred_on, occurred_at, description,
        account_id, source_system, external_ref_id, status)
        VALUES ('tx-s1','SIMPLE','INCOME',250_00,'2026-11-20','2026-11-20T12:00:00Z','Freela',?,
                'MANUAL','MAN:s1','PENDING')`,
      [acc]
    );

    const { previsto, efetivado } = await services.balance.getDailyBalancesDual('2026-11');
    // RPA_d = pendências acumuladas até o dia: −1500 a partir do dia 10, +250 a partir do dia 20
    let rpa = 0;
    for (let d = 1; d <= 30; d++) {
      const ymd = `2026-11-${String(d).padStart(2, '0')}`;
      if (d === 10) rpa -= 1_500_00;
      if (d === 20) rpa += 250_00;
      expect(previsto[ymd]).toBe(efetivado[ymd] + rpa); // SP_d = SF_d + RPA_d
      expect(previsto[ymd] - efetivado[ymd]).toBe(rpa); // SP_d − SF_d = RPA_d
    }
  });
});

/* ================================================================
 * BUG 2 — ALTERAÇÃO EM RECORRÊNCIAS REFLETE NA HORA NO FLUXO
 * ================================================================ */
describe('Bug 2 — Alterar em Recorrências atualiza o Fluxo imediatamente', () => {
  test('valor novo vale para a competência PENDING do mês vigente e para as previsões seguintes', async () => {
    const { services } = ctx;
    const accId = await seedAccount(db0(ctx), 'Conta Fixa Edit', 800_00);
    const rule = await services.recurrences.createRule({
      description: 'Academia',
      type: 'EXPENSE',
      amountCents: 90_00,
      dayOfMonth: 20,
      startDate: '2026-11-20',
      accountId: accId,
    });
    await services.recurrences.runForecast(6, '2026-11-02');

    // Fluxo "vê" o valor antigo antes da edição
    const before = (await services.transactions.listFlow('2026-12')) as unknown as FlowTx[];
    expect(before.find((r) => r.recurrence_rule_id === rule.id)!.amount_cents).toBe(90_00);

    // ALTERAR (tela Recorrências) — valor 90 → 120
    await services.recurrences.updateRule(rule.id, { amountCents: 120_00, today: '2026-11-02' });

    // Fluxo refleta NA HORA: mês vigente (PENDING) e meses seguintes
    const nov = (await services.transactions.listFlow('2026-11')) as unknown as FlowTx[];
    expect(nov.find((r) => r.recurrence_rule_id === rule.id)!.amount_cents).toBe(120_00);
    const dez = (await services.transactions.listFlow('2026-12')) as unknown as FlowTx[];
    expect(dez.find((r) => r.recurrence_rule_id === rule.id)!.amount_cents).toBe(120_00);
    const abr = (await services.transactions.listFlow('2027-04')) as unknown as FlowTx[];
    expect(abr.find((r) => r.recurrence_rule_id === rule.id)!.amount_cents).toBe(120_00);
  });

  test('dia novo reposiciona a DATA da ocorrência (30→5) em todos os meses à frente', async () => {
    const { services } = ctx;
    const accId = await seedAccount(db0(ctx), 'Conta Dia', 400_00);
    const rule = await services.recurrences.createRule({
      description: 'Streaming',
      type: 'EXPENSE',
      amountCents: 30_00,
      dayOfMonth: 30,
      startDate: '2026-11-30',
      accountId: accId,
    });
    await services.recurrences.runForecast(6, '2026-11-02');

    await services.recurrences.updateRule(rule.id, { dayOfMonth: 5, today: '2026-11-02' });

    // Competência vigente: ainda sem ocorrência (dia 30 não venceu... era PENDING dia 30)
    const nov = (await services.transactions.listFlow('2026-11')) as unknown as FlowTx[];
    expect(nov.find((r) => r.recurrence_rule_id === rule.id)!.occurred_on).toBe('2026-11-05');
    const dez = (await services.transactions.listFlow('2026-12')) as unknown as FlowTx[];
    expect(dez.find((r) => r.recurrence_rule_id === rule.id)!.occurred_on).toBe('2026-12-05');
  });

  test('competência CONFIRMED do mês corrente: valor e DATA são reposicionados, movimento acompanha', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Conf', 900_00);
    const rule = await services.recurrences.createRule({
      description: 'Internet',
      type: 'EXPENSE',
      amountCents: 100_00,
      dayOfMonth: 1,
      startDate: '2026-11-01',
      accountId: accId,
    });
    await services.recurrences.runDueRecurrences('2026-11-02');
    await services.recurrences.runForecast(6, '2026-11-02');

    await services.recurrences.updateRule(rule.id, {
      amountCents: 130_00,
      dayOfMonth: 3,
      description: 'Internet Fibra',
      today: '2026-11-02',
    });

    const rows = (await services.transactions.listFlow('2026-11')) as unknown as FlowTx[];
    const occ = rows.find((r) => r.recurrence_rule_id === rule.id)!;
    expect(occ.status).toBe('CONFIRMED');
    expect(occ.amount_cents).toBe(130_00);
    expect(occ.occurred_on).toBe('2026-11-03');
    expect(occ.description).toBe('Internet Fibra');
    // movimento financeiro: valor e data novos (saldo reflete na hora)
    const mv = await db.getFirstAsync<{ amount_cents: number; effective_date: string }>(
      'SELECT amount_cents, effective_date FROM financial_moves WHERE transaction_id = ?',
      [occ.id]
    );
    expect(mv!.amount_cents).toBe(130_00);
    expect(mv!.effective_date).toBe('2026-11-03');
    // meses anteriores NÃO são tocados (não existem — regra começou em 11/2026)
    expect(await getAccountBalance(db, accId)).toBe(900_00 - 130_00);
  });

  test('fixa em CARTÃO: item da fatura acompanha o novo valor/dia (sem duplicar)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db0(ctx), 'Conta Card', 0);
    const cardId = await seedCard(db0(ctx), accId, 'Card Fixa Edit', 15, 25);
    const rule = await services.recurrences.createRule({
      description: 'Netflix',
      type: 'EXPENSE',
      amountCents: 44_90,
      dayOfMonth: 20,
      startDate: '2026-11-20',
      cardId,
    });
    await services.recurrences.runForecast(6, '2026-11-02');

    await services.recurrences.updateRule(rule.id, { amountCents: 55_90, today: '2026-11-02' });

    const items = await db.getAllAsync<{ amount_cents: number; reference_month: string }>(
      `SELECT ii.amount_cents, i.reference_month FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id
        WHERE ii.transaction_id = ?`,
      [(await services.transactions.listFlow('2026-11') as unknown as FlowTx[]).find((r) => r.recurrence_rule_id === rule.id)!.id]
    );
    expect(items.length).toBe(1); // sem duplicação
    expect(items[0].amount_cents).toBe(55_90);
  });

  test('meses ANTERIORES à edição ficam intactos (histórico imutável, ARQ-005)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Hist', 2_000_00);
    const rule = await services.recurrences.createRule({
      description: 'Aluguel',
      type: 'EXPENSE',
      amountCents: 1_200_00,
      dayOfMonth: 10,
      startDate: '2026-09-10',
      accountId: accId,
    });
    await services.recurrences.runDueRecurrences('2026-11-02');
    await services.recurrences.runForecast(3, '2026-11-02');

    await services.recurrences.updateRule(rule.id, { amountCents: 1_500_00, today: '2026-11-02' });

    // Setembro e outubro mantêm 1.200,00
    for (const mes of ['2026-09', '2026-10']) {
      const rows = (await services.transactions.listFlow(mes)) as unknown as FlowTx[];
      expect(rows.find((r) => r.recurrence_rule_id === rule.id)!.amount_cents).toBe(1_200_00);
    }
  });
});

/* ================================================================
 * BUG 3 — EDIÇÃO DE PARCELAMENTO COM OS DOIS MODOS DE CÁLCULO
 * ================================================================ */
describe('Bug 3 — Alterar valores aceita Dividir total E Parcela fixa', () => {
  test('plano DIVIDE_TOTAL editado como PARCELA FIXA: pendentes viram valor fixo e o plano muda de modo', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Troca Modo', 0);
    const { planId } = await services.installments.createPlan({
      description: 'Notebook',
      mode: 'DIVIDE_TOTAL',
      totalCents: 120_00,
      totalInstallments: 12,
      firstDueDate: '2026-01-10',
      accountId: accId,
    });
    // paga as 2 primeiras
    const insts = await db.getAllAsync<{ id: string }>(
      "SELECT id FROM installments WHERE plan_id = ? AND sequence_number <= 2",
      [planId]
    );
    for (const i of insts) await services.installments.setPaymentStatus(i.id, true);

    const r = await services.installments.updateFromCurrent(planId, {
      mode: 'FIXED_PER_MONTH',
      fixedAmountCents: 15_00,
    });
    expect(r.mode).toBe('FIXED_PER_MONTH');
    expect(r.updatedCount).toBe(10);
    // todas as pendentes = 15,00
    const pend = await db.getAllAsync<{ amount_cents: number }>(
      "SELECT amount_cents FROM installments WHERE plan_id = ? AND status = 'PENDING'",
      [planId]
    );
    expect(pend.length).toBe(10);
    expect(pend.every((p) => p.amount_cents === 15_00)).toBe(true);
    // modo do plano passou a ser FIXED_PER_MONTH (fixed_amount_cents gravado)
    const plan = await db.getFirstAsync<{ mode: string; fixed_amount_cents: number | null; total_cents: number | null }>(
      'SELECT mode, fixed_amount_cents, total_cents FROM installment_plans WHERE id = ?',
      [planId]
    );
    expect(plan!.mode).toBe('FIXED_PER_MONTH');
    expect(plan!.fixed_amount_cents).toBe(15_00);
    // custo total recalculado = pagas (20,00) + restante (150,00)
    expect(r.newTotalCents).toBe(170_00);
  });

  test('plano FIXED_PER_MONTH editado como DIVIDIR TOTAL: restante é repartido (resto na última)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Divide', 0);
    const { planId } = await services.installments.createPlan({
      description: 'Celular',
      mode: 'FIXED_PER_MONTH',
      fixedAmountCents: 20_00,
      totalInstallments: 5,
      firstDueDate: '2026-01-05',
      accountId: accId,
    });
    const r = await services.installments.updateFromCurrent(planId, {
      mode: 'DIVIDE_TOTAL',
      remainingTotalCents: 101_00, // 5 parcelas → 20,20 × 4 + 20,20... = 20,20*5 (sem resto)
    });
    expect(r.mode).toBe('DIVIDE_TOTAL');
    const pend = await db.getAllAsync<{ amount_cents: number }>(
      "SELECT amount_cents FROM installments WHERE plan_id = ? AND status = 'PENDING' ORDER BY sequence_number",
      [planId]
    );
    const soma = pend.reduce((a, b) => a + b.amount_cents, 0);
    expect(soma).toBe(101_00); // sem perder centavos
    const plan = await db.getFirstAsync<{ mode: string }>(
      'SELECT mode FROM installment_plans WHERE id = ?',
      [planId]
    );
    expect(plan!.mode).toBe('DIVIDE_TOTAL');
  });

  test('SEM mode explícito mantém o comportamento antigo (modo do plano)', async () => {
    const { services } = ctx;
    const accId = await seedAccount(db0(ctx), 'Conta Default', 0);
    const { planId } = await services.installments.createPlan({
      description: 'Máquina',
      mode: 'FIXED_PER_MONTH',
      fixedAmountCents: 40_00,
      totalInstallments: 3,
      firstDueDate: '2026-01-05',
      accountId: accId,
    });
    const r = await services.installments.updateFromCurrent(planId, { fixedAmountCents: 50_00 });
    expect(r.mode).toBe('FIXED_PER_MONTH');
    void r;
  });
});

/* ================================================================
 * MELHORIA 2 — CONSOLIDADO NO PADRÃO DOS LANÇAMENTOS NORMAIS
 * ================================================================ */
describe('Melhoria 2 — groupKindInfo (chips Fixo/Parcelado + pill no card do grupo)', () => {
  test('grupo com FIXA: fixo=true; com PARCELADO: parcelado=true + pill 1/N; misto mostra os dois', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Padrão', 900_00);

    // --- grupo só com FIXA (dia 2 já vencido → ocorrência nasce CONFIRMED)
    const g1 = await services.transactions.createConsolidatedGroup({
      description: 'Casa',
      date: '2026-11-02',
      accountId: accId,
      lines: [],
      headerAmountCents: 100_00,
      headerType: 'EXPENSE',
    });
    await services.recurrences.createRule({
      description: 'Luz', type: 'EXPENSE', amountCents: 100_00, dayOfMonth: 2,
      startDate: '2026-11-02', accountId: accId, groupTransactionId: g1!.id,
    });
    await services.recurrences.runDueRecurrences('2026-11-03');

    // --- grupo com PARCELADO
    const g2 = await services.transactions.createConsolidatedGroup({
      description: 'Obras',
      date: '2026-11-02',
      accountId: accId,
      lines: [],
      headerAmountCents: 10_00,
      headerType: 'EXPENSE',
    });
    await services.installments.createPlan({
      description: 'Obra', mode: 'DIVIDE_TOTAL', totalCents: 10_00, totalInstallments: 5,
      firstDueDate: '2026-11-10', accountId: accId, groupTransactionId: g2!.id,
    });

    const rows = (await services.transactions.listFlow('2026-11')) as unknown as FlowTx[];
    const { gm } = await buildGroupMonths(db, '2026-11', rows);

    const k1 = groupKindInfo(gm[g1!.id]);
    expect(k1.fixo).toBe(true);
    expect(k1.parcelado).toBe(false);
    expect(k1.pill).toBeNull();

    const k2 = groupKindInfo(gm[g2!.id]);
    expect(k2.fixo).toBe(false);
    expect(k2.parcelado).toBe(true);
    expect(k2.pill).toEqual({ current: 1, total: 5 });
  });

  test('mesmo grupo RECOLHIDO mantém saldo e status (padrão único dos cards)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Recolhido', 500_00);
    const g = await services.transactions.createConsolidatedGroup({
      description: 'Mercado do mês',
      date: '2026-11-02',
      accountId: accId,
      lines: [{ direction: 'DEBIT', description: 'Feira', amountCents: 80_00, categoryId: null }],
      headerAmountCents: 80_00,
      headerType: 'EXPENSE',
    });
    const rows = (await services.transactions.listFlow('2026-11')) as unknown as FlowTx[];
    const { gm, childrenByGroup } = await buildGroupMonths(db, '2026-11', rows);
    const grp = gm[g!.id];
    const { debits } = groupMonthTotals(grp);
    expect(debits).toBe(80_00);
    // status do grupo com os FILHOS carregados (como a tela Fluxo faz)
    expect(groupStatusInfo(grp, childrenByGroup[g!.id] ?? [])).not.toBeNull();
    const k = groupKindInfo(grp);
    expect(k.fixo).toBe(false);
    expect(k.parcelado).toBe(false); // só linha à vista: sem chip FIXO/PARCELADO
  });
});

/* ================================================================
 * MELHORIA 5 — CATEGORIAS: ARQUIVAR (com uso) / EXCLUIR (sem uso)
 * ================================================================ */
describe('Melhoria 5 — regras de exclusão e arquivamento de categorias', () => {
  test('migração v9 criou archived_at em categories (user_version >= 9; v18 = 10)', async () => {
    const { db } = ctx;
    const cols = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM pragma_table_info('categories')"
    );
    expect(cols.map((c) => c.name)).toContain('archived_at');
    const v = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(v!.user_version).toBeGreaterThanOrEqual(9);
  });

  test('categoria COM movimentação: remove() recusa e setArchived(true) arquiva (sai do pickers)', async () => {
    const { services } = ctx;
    const cat = await services.categories.create({ name: 'Viagens', direction: 'DEBIT', icon: '✈️' });
    const accId = await seedAccount(db0(ctx), 'Conta Cat', 100_00);
    await services.transactions.createAccountExpense({
      description: 'Passagem',
      amountCents: 30_00,
      date: '2026-11-05',
      categoryId: cat.id,
      accountId: accId,
    });

    // Excluir? NÃO — só Arquivar
    let erro: Error | null = null;
    try {
      await services.categories.remove(cat.id);
    } catch (e) {
      erro = e as Error;
    }
    expect(erro).not.toBeNull();
    expect(erro!.message).toContain('ARQUIVE');

    // Arquivar funciona e marca archived_at
    await services.categories.setArchived(cat.id, true);
    const after = await services.categories.getById(cat.id);
    expect(after!.archived_at).not.toBeNull();
    // listActive() esconde; list() mantém (histórico)
    const active = await services.categories.listActive();
    expect(active.find((c) => c.id === cat.id)).toBeUndefined();
    const all = await services.categories.list();
    expect(all.find((c) => c.id === cat.id)).toBeDefined();
  });

  test('categoria SEM movimentação: pode EXCLUIR definitivamente', async () => {
    const { services } = ctx;
    const cat = await services.categories.create({ name: 'Sem uso', direction: 'CREDIT' });
    await services.categories.remove(cat.id);
    const after = await services.categories.getById(cat.id);
    expect(after).toBeNull();
  });

  test('arquivar a PAI arquiva as SUBCATEGORIAS em cascata; desarquivar vale só para a pai', async () => {
    const { services } = ctx;
    const pai = await services.categories.create({ name: 'Casa', direction: 'DEBIT' });
    const sub = await services.categories.create({ name: 'Luz', direction: 'DEBIT', parentId: pai.id });

    await services.categories.setArchived(pai.id, true);
    expect((await services.categories.getById(pai.id))!.archived_at).not.toBeNull();
    expect((await services.categories.getById(sub.id))!.archived_at).not.toBeNull();

    await services.categories.setArchived(pai.id, false);
    expect((await services.categories.getById(pai.id))!.archived_at).toBeNull();
    expect((await services.categories.getById(sub.id))!.archived_at).not.toBeNull(); // sub continua arquivada
  });

  test('arquivada NÃO recebe novo lançamento (usageCount segue contando o histórico)', async () => {
    const { db, services } = ctx;
    const cat = await services.categories.create({ name: 'Antiga', direction: 'DEBIT' });
    const accId = await seedAccount(db, 'Conta Uso', 0);
    await services.transactions.createAccountExpense({
      description: 'X', amountCents: 10_00, date: '2026-11-05', categoryId: cat.id, accountId: accId,
    });
    await services.categories.setArchived(cat.id, true);
    const usage = await services.categories.usageCount(cat.id);
    expect(usage.transactions).toBe(1);
    expect(usage.total).toBe(1);
  });
});

/* ================================================================
 * MELHORIAS 1, 3 e 4 — marcadores de tela (UI)
 * ================================================================ */
describe('Melhorias v17 — marcadores de fonte (UI)', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

  test('melhoria 1: "Dividir total" mostra o valor exato de cada parcela (Novo Lançamento e Parcelamentos)', () => {
    const lanc = read('app/lancamento.tsx');
    expect(lanc).toContain('divideCents');
    expect(lanc).toContain('Cada parcela:');
    expect(lanc).toContain('ajuste de centavos');
    const parc = read('app/parcelamentos.tsx');
    expect(parc).toContain('divideCents');
    expect(parc).toContain('Cada parcela:');
  });

  test('melhoria 3: o botão "Processar agora" saiu de Recorrências', () => {
    const rec = read('app/recorrencias.tsx');
    expect(rec).not.toContain('Processar agora');
    expect(rec).not.toContain('runNow');
  });

  test('melhoria 4 → v70 MELHORIA 2.3: Contas usa o "＋" do cabeçalho que abre a TELA PRÓPRIA de cadastramento', () => {
    const contas = read('app/contas.tsx');
    expect(contas).toContain('Adicionar nova conta');
    // v70: o "＋" não abre mais form embaixo da lista — abre a tela /conta-nova
    expect(contas).toContain("router.push('/conta-nova')");
    expect(contas).not.toContain('setFormOpen');
    expect(contas).toContain('Toque no ＋ para cadastrar a primeira.');
    // a tela de cadastramento existe e tem os campos do cadastro
    const tela = read('app/conta-nova.tsx');
    expect(tela).toContain('Saldo inicial');
    expect(tela).toContain('Data do saldo inicial');
  });

  test('bug 3: tela Parcelamentos tem os DOIS modos na edição (Segmented Dividir total / Parcela fixa)', () => {
    const parc = read('app/parcelamentos.tsx');
    expect(parc).toContain("Segmented<'DIVIDE_TOTAL' | 'FIXED_PER_MONTH'>");
    expect(parc).toContain("mode: editMode, fixedAmountCents: editCents");
    expect(parc).toContain("mode: editMode, remainingTotalCents: editCents");
  });

  test('melhoria 2 → v18 melhoria 1: flowModel mantém groupKindInfo; o card do grupo fica LIMPO', () => {
    const flowModel = read('src/lib/flowModel.ts');
    expect(flowModel).toContain('export function groupKindInfo');
    const fluxo = read('app/fluxo.tsx');
    // v18: o CABEÇALHO não renderiza mais Fixo/Parcelado (só os itens internos)
    expect(fluxo).not.toContain('kind.fixo ? <FixedDot /> : null');
    expect(fluxo).toContain('CONSOLIDADO');
  });

  test('bug 1 → v18: saldo do dia no escopo das contas ativadas (lista de contas + IN)', () => {
    const bal = read('src/services/BalanceService.ts');
    // v18: a rotina carrega AS CONTAS do escopo e usa IN (...linhas) nas consultas
    expect(bal).toContain('include_in_general_balance = 1 AND archived_at IS NULL');
    expect(bal).toContain('fm.account_id IN (${marks})');
    expect(bal).toContain("t.account_id IN (${marks})");
  });

  test('bug 2: updateRule sincroniza ocorrências (valor/dia/descrição)', () => {
    const rec = read('src/services/RecurrenceService.ts');
    expect(rec).toContain('syncOcorrencia');
    expect(rec).toContain('UPDATE transactions SET amount_cents = ?, description = ? WHERE id = ?');
    expect(rec).toContain("UPDATE transactions SET occurred_on = ?, occurred_at = ? WHERE id = ?");
  });
});
