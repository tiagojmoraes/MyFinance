/** Testes v7.1 — Lançamento Consolidado (grupo com créditos + débitos) e NFC-e sem valor. */

import { makeCtx, seedAccount, getAccountBalance } from './helpers';
import type { TestCtx } from './helpers';

let ctx: TestCtx;

beforeEach(async () => {
  ctx = await makeCtx();
});

describe('TransactionService — grupos consolidados (v7.1)', () => {
  test('cria cabeçalho + filhos com moves; saldo = créditos − débitos', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Grupo');

    const parent = await services.transactions.createConsolidatedGroup({
      description: 'Feira + farmácia',
      date: '2026-03-10',
      accountId: accId,
      lines: [
        { direction: 'DEBIT', description: 'Feira', amountCents: 50_00 },
        { direction: 'CREDIT', description: 'Troco devolvido', amountCents: 5_00 },
        { direction: 'DEBIT', description: 'Farmácia', amountCents: 30_00 },
      ],
    });

    expect(parent).not.toBeNull();
    expect(parent!.kind).toBe('CONSOLIDATED');
    // Cabeçalho não tem conta/move — não afeta saldo
    const moves = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM financial_moves WHERE transaction_id = ?',
      [parent!.id]
    );
    expect(moves?.n).toBe(0);

    const children = await db.getAllAsync<{ id: string; type: string; amount_cents: number; parent_transaction_id: string; description: string }>(
      'SELECT id, type, amount_cents, parent_transaction_id, description FROM transactions WHERE parent_transaction_id = ? ORDER BY description',
      [parent!.id]
    );
    expect(children.length).toBe(3);
    for (const ch of children) {
      expect(ch.parent_transaction_id).toBe(parent!.id);
    }
    expect(children.find((c) => c.description === 'Farmácia')?.type).toBe('EXPENSE');
    expect(children.find((c) => c.description === 'Troco devolvido')?.type).toBe('INCOME');

    // Saldo: -5000 + +500 - 3000... = -7500? 50,00 + 30,00 débitos; 5,00 crédito => -7500
    expect(await getAccountBalance(db, accId)).toBe(-(50_00 + 30_00) + 5_00);
  });

  test('listFlow: cabeçalho com child_count e agregados; filhos fora da lista raiz', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Fluxo');

    const parent = await services.transactions.createConsolidatedGroup({
      description: 'Grupo do mês',
      date: '2026-03-05',
      accountId: accId,
      lines: [
        { direction: 'DEBIT', description: 'A', amountCents: 10_00 },
        { direction: 'CREDIT', description: 'B', amountCents: 4_00 },
      ],
    });

    const rows = (await services.transactions.listFlow('2026-03')) as unknown as Array<{
      id: string; child_count: number; group_debits_cents: number; group_credits_cents: number;
    }>;
    const header = rows.find((r) => r.id === parent!.id);
    expect(header).toBeDefined();
    expect(header!.child_count).toBe(2);
    expect(header!.group_debits_cents).toBe(10_00);
    expect(header!.group_credits_cents).toBe(4_00);
    // Filhos não aparecem na raiz
    expect(rows.filter((r) => r.id !== parent!.id).length).toBe(0);

    const children = await services.transactions.listChildren(parent!.id);
    expect(children.length).toBe(2);
  });

  test('excluir o cabeçalho APAGA os filhos FISICAMENTE (saldo volta ao original — v10)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Cascade', 100_00);

    const parent = await services.transactions.createConsolidatedGroup({
      description: 'Grupo cascata',
      date: '2026-03-05',
      accountId: accId,
      lines: [
        { direction: 'DEBIT', description: 'X', amountCents: 20_00 },
        { direction: 'CREDIT', description: 'Y', amountCents: 8_00 },
      ],
    });
    expect(await getAccountBalance(db, accId)).toBe(100_00 - 20_00 + 8_00);

    await services.transactions.deleteTransaction(parent!.id);

    // Exclusão física: cabeçalho E filhos saem do banco; movimentos também
    const parentRow = await db.getFirstAsync('SELECT id FROM transactions WHERE id = ?', [parent!.id]);
    expect(parentRow).toBeNull();
    const children = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM transactions WHERE parent_transaction_id = ?',
      [parent!.id]
    );
    expect(children?.n).toBe(0);
    const moves = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM financial_moves WHERE transaction_id NOT IN (SELECT id FROM transactions)'
    );
    expect(moves?.n).toBe(0);
    expect(await getAccountBalance(db, accId)).toBe(100_00);
  });

  test('excluir a ÚLTIMA linha apaga também o cabeçalho (v10 — física)', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Último');

    const parent = await services.transactions.createConsolidatedGroup({
      description: 'Grupo último',
      date: '2026-03-05',
      accountId: accId,
      lines: [
        { direction: 'DEBIT', description: 'Único', amountCents: 12_00 },
        { direction: 'CREDIT', description: 'Desconto', amountCents: 2_00 },
      ],
    });

    const children = await db.getAllAsync<{ id: string; type: string }>(
      'SELECT id, type FROM transactions WHERE parent_transaction_id = ?',
      [parent!.id]
    );
    for (const ch of children) {
      await services.transactions.deleteTransaction(ch.id);
    }
    const header = await db.getFirstAsync('SELECT id FROM transactions WHERE id = ?', [parent!.id]);
    expect(header).toBeNull();
    expect(await getAccountBalance(db, accId)).toBe(0);
  });
});

describe('Grupo consolidado — regras v10', () => {
  test('updateGroupHeader altera descrição/data e repassa para linhas e movimentos', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Header');

    const parent = await services.transactions.createConsolidatedGroup({
      description: 'Nome antigo do grupo',
      date: '2026-03-10',
      accountId: accId,
      lines: [{ direction: 'DEBIT', description: 'Linha A', amountCents: 30_00 }],
    });
    expect(parent).not.toBeNull();

    await services.transactions.updateGroupHeader(parent!.id, {
      description: 'Descrição do Grupo Geral digitada',
      date: '2026-03-12',
    });

    const header = await db.getFirstAsync<{ description: string; occurred_on: string }>(
      'SELECT description, occurred_on FROM transactions WHERE id = ?',
      [parent!.id]
    );
    expect(header?.description).toBe('Descrição do Grupo Geral digitada');
    expect(header?.occurred_on).toBe('2026-03-12');

    const child = await db.getFirstAsync<{ occurred_on: string }>(
      'SELECT occurred_on FROM transactions WHERE parent_transaction_id = ?',
      [parent!.id]
    );
    expect(child?.occurred_on).toBe('2026-03-12');

    const move = await db.getFirstAsync<{ effective_date: string }>(
      'SELECT effective_date FROM financial_moves WHERE transaction_id = (SELECT id FROM transactions WHERE parent_transaction_id = ?)',
      [parent!.id]
    );
    expect(move?.effective_date).toBe('2026-03-12');
  });

  test('linhas com categoria própria (débito E crédito) são gravadas nos filhos', async () => {
    const { db, services } = ctx;
    const accId = await seedAccount(db, 'Conta Cat');

    const parent = await services.transactions.createConsolidatedGroup({
      description: 'Grupo com categorias',
      date: '2026-03-10',
      accountId: accId,
      lines: [
        { direction: 'DEBIT', description: 'Feira', amountCents: 10_00, categoryId: 'cat-mercado' },
        { direction: 'CREDIT', description: 'Devolução', amountCents: 3_00, categoryId: 'cat-receitas-outros' },
      ],
    });
    expect(parent).not.toBeNull();

    const kids = await db.getAllAsync<{ description: string; category_id: string | null }>(
      'SELECT description, category_id FROM transactions WHERE parent_transaction_id = ?',
      [parent!.id]
    );
    expect(kids.find((k) => k.description === 'Feira')?.category_id).toBe('cat-mercado');
    expect(kids.find((k) => k.description === 'Devolução')?.category_id).toBe('cat-receitas-outros');
  });
});

describe('NfceService — nota sem valor legível (v7.1)', () => {
  test('NÃO cria transação quando o total não é lido (fix CHECK amount_cents)', async () => {
    const { services } = ctx;
    const KEY = '35260514214169000187650010000099991234567890';
    const html = '<html><body><span class="label">Nome de Fantasia</span><span class="text">LOJA SEM TOTAL</span></body></html>';
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(html, { status: 200 }));
    try {
      const res = await services.nfce.ingestFromQrOrKey(KEY);
      expect(res.created).toBe(false);
      expect(res.needsAmount).toBe(true);
      const tx = await services.db.getFirstAsync<{ id: string }>(
        'SELECT id FROM transactions WHERE source_system = ? AND external_ref_id = ?',
        ['NFCE', KEY]
      );
      expect(tx).toBeNull(); // sem transação com amount 0 — CHECK respeitado
      const doc = await services.db.getFirstAsync<{ parse_status: string; needs_review: number }>(
        'SELECT parse_status, needs_review FROM nfce_documents WHERE access_key = ?',
        [KEY]
      );
      expect(doc?.parse_status).toBe('HEADER_ONLY');
      expect(doc?.needs_review).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
