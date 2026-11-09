import { makeCtx, seedAccount, seedCard } from './helpers';
import { monthAdd, monthOf, todaySP } from '../lib/dates';
import { BANK_INSTITUTIONS } from '../lib/banks';

describe('Fluxos principais do app', () => {
  test('lançar receita e despesa atualiza Fluxo, painel e busca literal paginada', async () => {
    const { db, services } = await makeCtx();
    const accountId = await seedAccount(db, 'Conta principal', 100_000);
    const today = todaySP();
    const month = monthOf(today);

    await services.transactions.createAccountExpense({
      description: '100%_teste A',
      amountCents: 2_500,
      accountId,
      date: today,
    });
    await services.transactions.createAccountIncome({
      description: 'Salário',
      amountCents: 5_000,
      accountId,
      date: today,
    });
    await services.transactions.createAccountExpense({
      description: '100%_teste B',
      amountCents: 1_000,
      accountId,
      date: today,
    });
    await services.transactions.createAccountExpense({
      description: '100abc_teste',
      amountCents: 99_000,
      accountId,
      date: today,
    });
    await services.transactions.createAccountIncome({
      description: 'Compensação teste',
      amountCents: 99_000,
      accountId,
      date: today,
    });

    const matches = await services.search.searchTransactions('100%_teste', 1, 0);
    const nextPage = await services.search.searchTransactions('100%_teste', 1, 1);
    expect(matches).toHaveLength(1);
    expect(nextPage).toHaveLength(1);
    expect([...matches, ...nextPage].map((row) => row.description).sort()).toEqual([
      '100%_teste A',
      '100%_teste B',
    ]);

    const series = await services.dashboard.getMonthSeries(month);
    const lastDay = `${month}-${String(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate()).padStart(2, '0')}`;
    const finalDay = series.find((day) => day.date === lastDay);
    expect(series).toHaveLength(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate());
    expect(finalDay?.efetivado).toBe(101_500);
    expect(finalDay?.previsto).toBe(101_500);
    await expect(services.dashboard.getMonthTotals(month)).resolves.toMatchObject({
      dias: series.length,
      efetivadoFinal: 101_500,
      previstoFinal: 101_500,
    });
  });

  test('arquivar categoria pai preserva histórico e tira subcategorias das escolhas', async () => {
    const { db, services } = await makeCtx();
    const accountId = await seedAccount(db);
    const parent = await services.categories.create({ name: 'Moradia', direction: 'DEBIT' });
    const child = await services.categories.create({
      name: 'Aluguel',
      direction: 'DEBIT',
      parentId: parent.id,
    });
    const transaction = await services.transactions.createAccountExpense({
      description: 'Aluguel de novembro',
      amountCents: 80_000,
      accountId,
      categoryId: child.id,
      date: todaySP(),
    });

    await expect(services.categories.remove(parent.id)).rejects.toThrow('Categoria em uso');
    expect(await services.categories.setArchived(parent.id, true)).toBe(2);
    expect((await services.categories.listActive()).some((category) => category.id === child.id)).toBe(false);
    expect(await db.getFirstAsync<{ category_id: string }>(
      'SELECT category_id FROM transactions WHERE id = ?',
      [transaction.id]
    )).toEqual({ category_id: child.id });

    await services.categories.setArchived(parent.id, false);
    expect((await services.categories.listActive()).map((category) => category.id)).toContain(parent.id);
    expect((await services.categories.listActive()).map((category) => category.id)).not.toContain(child.id);
  });

  test('seletor bancário e lista de cartões mantêm os códigos e a próxima fatura correta', async () => {
    const { db, services } = await makeCtx();
    expect(BANK_INSTITUTIONS.map(({ code }) => code)).toEqual(['077', '341', '104']);
    expect(BANK_INSTITUTIONS.find(({ code }) => code === '104')?.name).toBe('Caixa Econômica Federal');

    const firstCardId = await seedCard(db, await seedAccount(db, 'Conta cartão 1'), 'Cartão 1');
    const secondCardId = await seedCard(db, await seedAccount(db, 'Conta cartão 2'), 'Cartão 2');
    const month = monthOf(todaySP());
    const oldestMonth = monthAdd(month, -2);
    const middleMonth = monthAdd(month, -1);
    const newestMonth = month;

    for (const referenceMonth of [oldestMonth, middleMonth, newestMonth]) {
      await services.invoices.ensureInvoice(firstCardId, referenceMonth);
    }
    await db.runAsync(
      "UPDATE invoices SET total_cents = 10000, status = 'OPEN' WHERE card_id = ? AND reference_month = ?",
      [firstCardId, oldestMonth]
    );
    await db.runAsync(
      "UPDATE invoices SET total_cents = 20000, status = 'OPEN' WHERE card_id = ? AND reference_month = ?",
      [firstCardId, newestMonth]
    );

    await services.invoices.ensureInvoice(secondCardId, oldestMonth);
    await services.invoices.ensureInvoice(secondCardId, newestMonth);
    await db.runAsync(
      "UPDATE invoices SET total_cents = 10000, paid_cents = 10000, status = 'PAID' WHERE card_id = ? AND reference_month = ?",
      [secondCardId, oldestMonth]
    );
    await db.runAsync(
      "UPDATE invoices SET total_cents = 7000, status = 'OPEN' WHERE card_id = ? AND reference_month = ?",
      [secondCardId, newestMonth]
    );

    const nextByCard = await services.invoices.getNextOpenInvoices([firstCardId, secondCardId]);
    expect(nextByCard.get(firstCardId)?.invoice.reference_month).toBe(oldestMonth);
    expect(nextByCard.get(firstCardId)?.dueCents).toBe(10_000);
    expect(nextByCard.get(secondCardId)?.invoice.reference_month).toBe(newestMonth);
    expect(nextByCard.get(secondCardId)?.dueCents).toBe(7_000);
    expect(await services.invoices.getNextOpenInvoices([])).toEqual(new Map());
  });
});
