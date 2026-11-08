/**
 * Testes v8 — regra geral de dados (mock persistido) + ciclo de vida de contas/cartões.
 */

import { makeCtx, expectRejects } from './helpers';
import { ensureMockData, clearLancamentos } from '../db/seed';

describe('Dados iniciais (v10) — apenas CADASTROS BASE, sem lançamentos', () => {
  test('ensureMockData popula SÓ contas e cartões; movimentações começam ZERADAS', async () => {
    const { db } = await makeCtx();

    const created = await ensureMockData(db);
    expect(created).toBe(true);

    // Cadastros base preservados
    const accounts = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM accounts');
    expect(accounts?.n).toBeGreaterThanOrEqual(4);

    const cards = await db.getAllAsync<{ limit_cents: number | null; archived_at: string | null }>('SELECT limit_cents, archived_at FROM cards');
    expect(cards.length).toBeGreaterThanOrEqual(2);
    for (const c of cards) expect(c.limit_cents).not.toBeNull();

    // v10 (Req 1): NENHUM lançamento/movimentação no banco novo
    const txs = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(txs?.n).toBe(0);
    const moves = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM financial_moves');
    expect(moves?.n).toBe(0);
    const rules = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM recurrence_rules');
    expect(rules?.n).toBe(0);
    const plans = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM installment_plans');
    expect(plans?.n).toBe(0);
    const invoices = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM invoices');
    expect(invoices?.n).toBe(0);
    const products = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM products_catalog');
    expect(products?.n).toBe(0);
  });

  test('ensureMockData é idempotente: não popula duas vezes', async () => {
    const { db } = await makeCtx();
    expect(await ensureMockData(db)).toBe(true);
    expect(await ensureMockData(db)).toBe(false);
  });

  test('clearLancamentos zera movimentações e MANTÉM cadastros base (Cartões/Contas/Categorias)', async () => {
    const { db, services } = await makeCtx();
    await ensureMockData(db);

    // Cria movimentações de verdade: despesa, recorrência e fatura paga
    await services.transactions.createAccountExpense({
      description: 'Mercado', amountCents: 12_345, accountId: 'acc-mock-itau',
    });
    await services.recurrences.createRule({
      description: 'Aluguel', type: 'EXPENSE', amountCents: 100_000, dayOfMonth: 10,
      startDate: '2026-01-10', accountId: 'acc-mock-itau',
    });
    await services.recurrences.runDueRecurrences();
    await services.db.runAsync(
      "INSERT INTO nfce_documents (access_key, store_name, issued_at, amount_paid_cents, gross_total_cents, discount_cents, parse_status, needs_review, transaction_id) VALUES ('12345678901234567890123456789012345678901234', 'Loja Real', NULL, 1500, 1500, 0, 'HEADER_ONLY', 1, NULL)"
    );

    const before = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(before?.n).toBeGreaterThan(0);

    await clearLancamentos(db);

    // Movimentações ZERADAS
    const txs = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(txs?.n).toBe(0);
    const moves = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM financial_moves');
    expect(moves?.n).toBe(0);
    const rules = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM recurrence_rules');
    expect(rules?.n).toBe(0);
    const invoices = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM invoices');
    expect(invoices?.n).toBe(0);
    const ofx = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM ofx_imports');
    expect(ofx?.n).toBe(0);

    // Cadastros base INTOCADOS
    const accounts = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM accounts');
    expect(accounts?.n).toBe(4);
    const cards = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM cards');
    expect(cards?.n).toBe(2);
    const cats = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM categories');
    expect(cats?.n).toBeGreaterThanOrEqual(13);
    // NFC-e salvas TAMBÉM SAEM (v19 — pedido do usuário: limpar tudo)
    const docs = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM nfce_documents');
    expect(docs?.n).toBe(0);
    const nfceItems = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM nfce_items');
    expect(nfceItems?.n).toBe(0);
  });
});

describe('Ciclo de vida de contas/cartões (v8)', () => {
  test('colunas novas existem: archived_at (accounts/cards) e limit_cents (cards)', async () => {
    const { db } = await makeCtx();
    const accCols = await db.getAllAsync<{ name: string }>("PRAGMA table_info('accounts')");
    expect(accCols.map((c) => c.name)).toContain('archived_at');
    const cardCols = await db.getAllAsync<{ name: string }>("PRAGMA table_info('cards')");
    expect(cardCols.map((c) => c.name)).toContain('archived_at');
    expect(cardCols.map((c) => c.name)).toContain('limit_cents');
  });

  test('conta ARQUIVADA sai do saldo geral e da lista da Home; desarquivar volta', async () => {
    const { db, services } = await makeCtx();
    await db.runAsync(
      'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance, archived_at) VALUES (?,?,?,?,?,NULL)',
      ['acc-a', 'Ativa', 'CHECKING', 10_000, 1]
    );
    await db.runAsync(
      'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance, archived_at) VALUES (?,?,?,?,?,NULL)',
      ['acc-b', 'Arquivável', 'CHECKING', 50_000, 1]
    );
    expect(await services.balance.getGeneralBalance()).toBe(60_000);

    await db.runAsync("UPDATE accounts SET archived_at = '2026-01-01T00:00:00.000Z' WHERE id = 'acc-b'");
    expect(await services.balance.getGeneralBalance()).toBe(10_000);
    const list = await services.balance.listAccountBalances();
    expect(list.map((a) => a.accountId)).toEqual(['acc-a']);

    await db.runAsync("UPDATE accounts SET archived_at = NULL WHERE id = 'acc-b'");
    expect(await services.balance.getGeneralBalance()).toBe(60_000);
  });

  test('consolidado salva SEM categoria (grupo opcional de verdade) e com categoria por linha', async () => {
    const { db, services } = await makeCtx();
    // conta de teste
    await db.runAsync(
      'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?,?,?,1)',
      ['acc-conso', 'Conta Consol', 'CHECKING', 0]
    );

    // SEM categoria de grupo e SEM categoria nas linhas — não pode lançar erro
    const parent = await services.transactions.createConsolidatedGroup({
      description: 'Grupo sem categoria',
      accountId: 'acc-conso',
      lines: [
        { direction: 'DEBIT', description: 'Débito 1', amountCents: 10_00 },
        { direction: 'CREDIT', description: 'Crédito 1', amountCents: 4_00 },
      ],
    });
    expect(parent).not.toBeNull();
    expect(parent!.kind).toBe('CONSOLIDATED');
    expect(parent!.category_id).toBeNull();

    // Com categoria POR LINHA (fallback = categoria do grupo)
    const parent2 = await services.transactions.createConsolidatedGroup({
      description: 'Grupo com categorias por linha',
      categoryId: 'cat-mercado',
      accountId: 'acc-conso',
      lines: [
        { direction: 'DEBIT', description: 'Feira', amountCents: 5_00, categoryId: 'cat-transporte' },
        { direction: 'DEBIT', description: 'Sem categoria própria', amountCents: 2_00 },
      ],
    });
    const kids = await db.getAllAsync<{ description: string; category_id: string | null }>(
      'SELECT description, category_id FROM transactions WHERE parent_transaction_id = ? ORDER BY description',
      [parent2!.id]
    );
    expect(kids.find((k) => k.description === 'Feira')?.category_id).toBe('cat-transporte');
    expect(kids.find((k) => k.description === 'Sem categoria própria')?.category_id).toBe('cat-mercado');
  });

  test('linhas com valor 0 são filtradas: sem linhas válidas, NENHUM grupo é criado (v10)', async () => {
    const { db, services } = await makeCtx();
    await db.runAsync(
      'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?,?,?,1)',
      ['acc-x', 'Conta X', 'CHECKING', 0]
    );
    const parent = await services.transactions.createConsolidatedGroup({
      description: 'Inválido',
      accountId: 'acc-x',
      lines: [{ direction: 'DEBIT', description: 'Zero', amountCents: 0 }],
    });
    expect(parent).toBeNull();
    await expectRejects(
      () =>
        services.transactions.createConsolidatedGroup({
          description: 'Sem conta',
          accountId: '',
          lines: [{ direction: 'DEBIT', description: 'X', amountCents: 1_00 }],
        }),
      /conta/i
    );
  });

  test('v10 — grupo SEM linhas à vista não é mais bloqueado: retorna null (sem cabeçalho)', async () => {
    const { db, services } = await makeCtx();
    await db.runAsync(
      'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?,?,?,1)',
      ['acc-y', 'Conta Y', 'CHECKING', 0]
    );
    // Serviço: sem linhas -> nenhum cabeçalho (a tela cria só as fixas/parceladas)
    const parent = await services.transactions.createConsolidatedGroup({
      description: 'Só parcelado',
      accountId: 'acc-y',
      lines: [],
    });
    expect(parent).toBeNull();
    const headers = await db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM transactions WHERE kind = 'CONSOLIDATED'"
    );
    expect(headers?.n).toBe(0);
  });
});
