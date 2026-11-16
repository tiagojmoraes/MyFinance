/**
 * Testes v8 — regra geral de dados (mock persistido) + ciclo de vida de contas/cartões.
 */

import { makeCtx, expectRejects, seedAccount, seedCategory } from '../helpers';
import { clearAllUserData, clearLancamentos } from '../../db/seed';

describe('Dados iniciais e limpeza completa', () => {
  test('banco novo não recebe contas, cartões nem saldos de demonstração', async () => {
    const { db, services } = await makeCtx();
    const accounts = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM accounts');
    const cards = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM cards');
    expect(accounts?.n).toBe(0);
    expect(cards?.n).toBe(0);
    expect(await services.balance.getGeneralBalance()).toBe(0);
  });

  test('limpeza completa remove todos os dados e preserva schema/migrações', async () => {
    const { db, services } = await makeCtx();
    const accountId = await seedAccount(db, 'Conta temporária', 10_000);
    // v88: o app não cria mais categorias de seed — o teste cria a sua
    await seedCategory(db, 'Mercado', 'cat-mercado');
    await services.transactions.createAccountExpense({
      description: 'Movimento temporário',
      amountCents: 500,
      accountId,
      categoryId: 'cat-mercado',
    });
    await services.products.createManualProduct({ name: 'Produto temporário', baseUnit: 'UN' });
    await services.settings.set('preferencia_temporaria', '1');
    const before = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');

    await clearAllUserData(db);

    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'android_%'"
    );
    for (const table of tables) {
      const count = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table.name}"`);
      expect(count?.n).toBe(0);
    }
    const after = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(after?.user_version).toBe(before?.user_version);
    expect(await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys')).toMatchObject({ foreign_keys: 1 });
    await db.runAsync(
      'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?,?,?,1)',
      ['acc-after-cleanup', 'Depois da limpeza', 'CHECKING', 0]
    );
    expect(await db.getFirstAsync('SELECT id FROM accounts WHERE id = ?', ['acc-after-cleanup'])).not.toBeNull();
  });

  test('clearLancamentos zera movimentações e MANTÉM cadastros base (Cartões/Contas/Categorias)', async () => {
    const { db, services } = await makeCtx();
    const accountId = await seedAccount(db, 'Conta preservada');

    // Cria movimentações de verdade: despesa, recorrência e fatura paga
    await services.transactions.createAccountExpense({
      description: 'Mercado', amountCents: 12_345, accountId,
    });
    await services.recurrences.createRule({
      description: 'Aluguel', type: 'EXPENSE', amountCents: 100_000, dayOfMonth: 10,
      startDate: '2026-01-10', accountId,
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
    expect(accounts?.n).toBe(1);
    const cards = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM cards');
    expect(cards?.n).toBe(0);
    const cats = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM categories');
    // v88: o app não cria mais categorias de seed — quem usa, cadastra.
    expect(cats?.n).toBe(0);
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
    // v88: as categorias do teste são criadas por ele (o app não cria mais)
    await seedCategory(db, 'Mercado', 'cat-mercado');
    await seedCategory(db, 'Transporte', 'cat-transporte');
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
