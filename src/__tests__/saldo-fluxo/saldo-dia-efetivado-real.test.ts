/**
 * v19 — "SALDO DO DIA EFETIVADO" É DINHEIRO REAL: a hierarquia não o desconta.
 *
 * Bug do relato do usuário (telas de nov/dez/2026, v18 no aparelho):
 *  · 24/11 — Saldo do dia Previsto: R$ 0,00 · Efetivado: −R$ 8.500,00
 *  · 24/12 — Saldo do dia Previsto: R$ 6.638,42 · Efetivado: −R$ 10.361,58
 * O efetivado é o dinheiro REAL (movimentos CONFIRMED) — não pode virar
 * negativo por causa de PLANEJAMENTO (reserva da Programação de Compra não
 * executada + restante do orçamento) enquanto o previsto conta receita
 * PENDENTE (salário "Não recebido" do dia-alvo).
 *
 * Causa: `applyClosingHierarchy` calculava `consumo = balancePrev −
 * closingPrev` (que inclui as reservas de planejamento e o efeito da receita
 * pendente embutida no saldo previsto) e descontava esse consumo do saldo
 * efetivado. Como o consumo superava o dinheiro real, o efetivado fechava
 * negativo — e o erro ENCADEAVA mês a mês (abertura efetivada do mês
 * seguinte = closing efetivado do anterior).
 *
 * Cenário (R$, análogo às telas do usuário): saldo inicial 1.000 · NFC-e
 * paga 572,63 (fora do orçamento) · gasto orçado 11,05 · orçado 400/mês ·
 * salário 8.500 PENDENTE no dia 24 · item Prioridade 10.000.
 *  · Nov: cabe 8.527,37 · closing previsto 0,00 · closing efetivado 416,32
 *    (ANTES: −8.500,00 — dívida fantasma)
 *  · Dez: cabe 1.472,63 (falta que viajou) · closing previsto 6.627,37 ·
 *    closing efetivado 416,32 (ANTES: −10.372,63 — bug encadeado)
 */
import { makeCtx, seedAccount } from '../helpers';
import { todaySP, monthAdd, monthOf } from '../../lib/dates';

let ctx: Awaited<ReturnType<typeof makeCtx>>;

beforeEach(async () => {
  ctx = await makeCtx();
});

describe('v19 — closing efetivado = saldo real (sem dívida fantasma do previsto)', () => {
  test('efetivado do dia-alvo não desconta reserva de Programação/orçamento nem receita pendente', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 100_000); // R$ 1.000,00
    const catOrc = await services.categories.create({ name: 'Compra Mensal', direction: 'DEBIT' });
    const catFora = await services.categories.create({ name: 'Farmácia', direction: 'DEBIT' });

    await services.settings.set('orcamentos_ativado', '1');
    await services.settings.set('wishlist_na_home', '1');
    await services.budgets.save(catOrc.id, 40_000); // R$ 400/mês

    const hoje = monthOf(todaySP());
    const futuro = monthAdd(hoje, 1);

    // NFC-e paga (CONFIRMED) em categoria FORA do orçamento — R$ 572,63.
    await db.runAsync(
      `INSERT INTO transactions
         (id, kind, type, amount_cents, occurred_on, occurred_at, description, category_id, account_id, source_system, status)
       VALUES ('tx-nfce-1', 'SIMPLE', 'EXPENSE', 57263, ?, ?, 'NFC-e Sendas', ?, ?, 'MANUAL', 'CONFIRMED')`,
      [`${hoje}-21`, `${hoje}-21T08:00:00`, catFora.id, acc]
    );
    await db.runAsync(
      `INSERT INTO financial_moves
         (id, transaction_id, account_id, direction, amount_cents, effective_date, status)
       VALUES ('fm-nfce-1', 'tx-nfce-1', ?, 'DEBIT', 57263, ?, 'CONFIRMED')`,
      [acc, `${hoje}-21`]
    );
    // Gasto dentro do orçamento — R$ 11,05 pago (restante 388,95).
    await db.runAsync(
      `INSERT INTO transactions
         (id, kind, type, amount_cents, occurred_on, occurred_at, description, category_id, account_id, source_system, status)
       VALUES ('tx-gasto-1', 'SIMPLE', 'EXPENSE', 1105, ?, ?, 'Mercado item', ?, ?, 'MANUAL', 'CONFIRMED')`,
      [`${hoje}-15`, `${hoje}-15T08:00:00`, catOrc.id, acc]
    );
    await db.runAsync(
      `INSERT INTO financial_moves
         (id, transaction_id, account_id, direction, amount_cents, effective_date, status)
       VALUES ('fm-gasto-1', 'tx-gasto-1', ?, 'DEBIT', 1105, ?, 'CONFIRMED')`,
      [acc, `${hoje}-15`]
    );
    // Salário R$ 8.500,00 PENDENTE ("Não recebido") no dia-alvo 24 de NOV.
    await db.runAsync(
      `INSERT INTO transactions
         (id, kind, type, amount_cents, occurred_on, occurred_at, description, account_id, source_system, status)
       VALUES ('tx-salario-1', 'SIMPLE', 'INCOME', 850000, ?, ?, 'Salário Líquido', ?, 'MANUAL', 'PENDING')`,
      [`${hoje}-24`, `${hoje}-24T08:00:00`, acc]
    );
    // Salário R$ 8.500,00 PENDENTE no dia-alvo 24 de DEZ (mesma tela de dez).
    await db.runAsync(
      `INSERT INTO transactions
         (id, kind, type, amount_cents, occurred_on, occurred_at, description, account_id, source_system, status)
       VALUES ('tx-salario-2', 'SIMPLE', 'INCOME', 850000, ?, ?, 'Salário Líquido', ?, 'MANUAL', 'PENDING')`,
      [`${futuro}-24`, `${futuro}-24T08:00:00`, acc]
    );

    // Programação de Compra: item de Prioridade R$ 10.000,00, sem reserva.
    await services.wishlist.addItem({
      classificacao: 'PRIORIDADE',
      description: 'Prioridade',
      targetCents: 1_000_000,
    });

    // Dinheiro real no dia-alvo de nov: 1.000 − 572,63 − 11,05 = 416,32.
    const rowNov = await services.monthLedger.getMonthLedgerSummary(hoje);
    expect(rowNov).not.toBeNull();
    // o previsto aplica a hierarquia (orçamento → Programação) — permanece
    expect(rowNov!.balanceBeforeEfetCents).toBe(41_632);
    expect(rowNov!.wishlistAllocatedCents).toBe(852_737); // cabe 8.527,37
    expect(rowNov!.closingPrevCents).toBe(0);
    // v19: efetivado = saldo REAL (ANTES: −850.000 = −R$ 8.500,00)
    expect(rowNov!.closingEfetCents).toBe(41_632);

    // Dezembro: a falta que viajou (10.000 − 8.527,37 = 1.472,63) cabe
    // INTEIRA; o efetivado NÃO herda a dívida fantasma de novembro.
    const rowDez = await services.monthLedger.getMonthLedgerSummary(futuro);
    expect(rowDez).not.toBeNull();
    expect(rowDez!.wishlistAllocatedCents).toBe(147_263);
    expect(rowDez!.closingPrevCents).toBe(662_737);
    // v19: efetivado = saldo REAL (ANTES: −1.037.263 = −R$ 10.372,63)
    expect(rowDez!.closingEfetCents).toBe(41_632);
  });
});
