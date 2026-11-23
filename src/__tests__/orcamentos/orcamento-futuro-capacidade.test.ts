/**
 * v18 — CAPACIDADE DA PROGRAMAÇÃO DE COMPRA NOS MESES FUTUROS.
 *
 * Bug do relato do usuário: no mês corrente tudo certo; quando a falta da
 * Programação era MAIOR que o saldo disponível, o mês seguinte mostrava
 * "cabe R$ 0,00" em vez da DIFERENÇA que faltava; o Saldo do dia-alvo não
 * batia; e o primeiro dia com lançamento do mês subsequente não vinha
 * zerado (dívida fantasma no closing).
 *
 * Causa: em mês futuro o restante do orçamento só abatia a fixa SIMPLE
 * pendente (a parcela conta no mês da COMPRA — âncora v72 — e a fatura não
 * abatia nada). O orçamento ficava praticamente inteiro POR CIMA de um
 * saldo previsto que JÁ descontava as pendências daquele mês → capacidade
 * da cascade = 0.
 *
 * Correção: `BudgetService.getFutureDueCommitmentCents` (parcelas em conta
 * + faturas pelo VENCIMENTO, parte das categorias orçadas, compras de
 * meses ANTERIORES) passa a abater o restante do orçamento em
 * `MonthLedgerService.computeMonth` para meses > corrente.
 *
 * Cenário do 1º teste (R$): saldo 7.000 · orçado 2.300/mês · compra
 * parcelada 2× 500 (âncora no mês corrente) · fixa 800 no mês futuro ·
 * salário 5.000 previsto no mês futuro · item Prioridade 6.000.
 * Mês corrente cabe 5.200, falta 800 viaja. Mês seguinte: saldo previsto
 * 3.700 → ANTES restante 1.500 → cabe 0 e closing −200 (dívida fantasma);
 * AGORA restante 1.000 → cabe 800 (a diferença INTEIRA) e closing +1.900.
 */
import { makeCtx, seedAccount, seedCard } from '../helpers';
import { todaySP, monthAdd, monthOf } from '../../lib/dates';

let ctx: Awaited<ReturnType<typeof makeCtx>>;

beforeEach(async () => {
  ctx = await makeCtx();
});

describe('v18 — orçamento futuro abate parcelas/faturas pelo vencimento', () => {
  test('mês seguinte passa a cobrir a DIFERENÇA da falta (não mais zero) e o closing não vira dívida', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 700_000);
    const cat = await services.categories.create({ name: 'Mercado', direction: 'DEBIT' });

    await services.settings.set('orcamentos_ativado', '1');
    await services.settings.set('wishlist_na_home', '1');
    await services.budgets.save(cat.id, 230_000);

    const hoje = monthOf(todaySP());
    const futuro = monthAdd(hoje, 1);

    // Parcela EM CONTA: compra no mês corrente (âncora), 1ª parcela vence no
    // mês corrente e a 2ª no mês futuro — o dual desconta no futuro e o
    // orçamento futuro precisa abater (o plano já foi gasto na âncora).
    await services.installments.createPlan({
      description: 'Parcelado',
      mode: 'FIXED_PER_MONTH',
      fixedAmountCents: 50_000,
      totalInstallments: 2,
      firstDueDate: `${hoje}-15`,
      accountId: acc,
      categoryId: cat.id,
    });

    // Fixa SIMPLE pendente no mês futuro (categoria orçada) — abate pelo
    // previstoCents do summary, NÃO pelo compromisso de vencimento.
    await db.runAsync(
      `INSERT INTO transactions
         (id, kind, type, amount_cents, occurred_on, occurred_at, description, category_id, account_id, source_system, status)
       VALUES ('tx-fixa-1', 'SIMPLE', 'EXPENSE', 80000, ?, ?, 'Fixa mercado', ?, ?, 'RECURRENCE', 'PENDING')`,
      [`${futuro}-10`, `${futuro}-10T08:00:00`, cat.id, acc]
    );

    // Salário previsto no mês futuro (entra no saldo previsto do dia-alvo).
    await db.runAsync(
      `INSERT INTO transactions
         (id, kind, type, amount_cents, occurred_on, occurred_at, description, account_id, source_system, status)
       VALUES ('tx-salario-1', 'SIMPLE', 'INCOME', 500000, ?, ?, 'Salário', ?, 'MANUAL', 'PENDING')`,
      [`${futuro}-05`, `${futuro}-05T08:00:00`, acc]
    );

    // Item de Prioridade maior que o saldo disponível do mês corrente:
    // a diferença VIAJA para o mês futuro (shortage_end → shortage_start).
    await services.wishlist.addItem({
      classificacao: 'PRIORIDADE',
      description: 'Notebook',
      targetCents: 600_000,
    });

    // Compromisso de vencimento do mês futuro: só a parcela (a fixa é
    // previstoCents — não pode entrar aqui, senão contaria duas vezes).
    const commitment = await services.budgets.getFutureDueCommitmentCents(futuro);
    expect(commitment).toBe(50_000);

    const rowFut = await services.monthLedger.getMonthLedgerSummary(futuro);
    expect(rowFut).not.toBeNull();
    // restante do orçamento futuro = 2.300 − 800 (fixa) − 500 (parcela) = 1.000
    expect(rowFut!.budgetRemainingCents).toBe(100_000);
    // saldo previsto no dia-alvo = 5.000 − 800 − 500 = 3.700; capacidade =
    // 3.700 − 1.000 = 2.700 → a DIFERENÇA que viajou (800) é coberta INTEIRA
    // (antes: restante 1.500 → cabe 0)
    expect(rowFut!.wishlistAllocatedCents).toBe(80_000);
    // closing SEM dívida fantasma (antes seria 3.700 − 1.500 − 0 = +2.200 —
    // e nos números do usuário, negativo)
    expect(rowFut!.closingPrevCents).toBe(190_000);
  });

  test('fatura de cartão vencendo no mês futuro abate a parte das categorias orçadas', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 700_000);
    const cat = await services.categories.create({ name: 'Mercado', direction: 'DEBIT' });

    await services.settings.set('orcamentos_ativado', '1');
    await services.budgets.save(cat.id, 230_000);

    const hoje = monthOf(todaySP());
    const futuro = monthAdd(hoje, 1);

    // Cartão com fechamento 15 / vencimento 10: compra no dia 10 do mês
    // corrente (ANTES do fechamento) entra na fatura que vence no dia 10 do
    // mês FUTURO.
    const card = await seedCard(db, acc, 'Cartão', 15, 10);
    await services.transactions.createCardExpense({
      description: 'Compra cartão',
      amountCents: 30_000,
      cardId: card,
      date: `${hoje}-10`,
      categoryId: cat.id,
    });

    const commitment = await services.budgets.getFutureDueCommitmentCents(futuro);
    expect(commitment).toBe(30_000);

    const rowFut = await services.monthLedger.getMonthLedgerSummary(futuro);
    expect(rowFut).not.toBeNull();
    // restante futuro = 2.300 − 0 (nada previsto no mês futuro) − 300 (fatura) = 2.000
    expect(rowFut!.budgetRemainingCents).toBe(200_000);
  });

  test('mês CORRENTE mantém a regra v72 da âncora; plano ancorado no próprio mês futuro não abate duas vezes', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta', 700_000);
    const cat = await services.categories.create({ name: 'Mercado', direction: 'DEBIT' });

    await services.settings.set('orcamentos_ativado', '1');
    await services.budgets.save(cat.id, 230_000);

    const hoje = monthOf(todaySP());
    const futuro = monthAdd(hoje, 1);

    // Parcela comprada agora, 1ª vencendo no mês FUTURO: no mês corrente o
    // restante continua pela âncora (o plano INTEIRO somou agora) — o
    // compromisso de vencimento do mês corrente é zero.
    await services.installments.createPlan({
      description: 'Parcelado',
      mode: 'FIXED_PER_MONTH',
      fixedAmountCents: 50_000,
      totalInstallments: 2,
      firstDueDate: `${futuro}-15`,
      accountId: acc,
      categoryId: cat.id,
    });

    const commitmentHoje = await services.budgets.getFutureDueCommitmentCents(hoje);
    expect(commitmentHoje).toBe(0);

    // Âncora datada no PRÓPRIO mês futuro (a 1ª parcela nasce lá): o plano
    // INTEIRO já contou no gasto daquele mês pela âncora — o compromisso de
    // vencimento NÃO abate de novo (sem dupla contagem).
    const commitmentFuturo = await services.budgets.getFutureDueCommitmentCents(futuro);
    expect(commitmentFuturo).toBe(0);
  });
});
