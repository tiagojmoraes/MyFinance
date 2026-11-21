/**
 * v101 — REGRA: "só após a definição do Catálogo".
 *
 *  1. AUTO-NFCE (origin='NFCE') NUNCA entra na Despensa automaticamente,
 *     mesmo que alguém ligue stock_control=1 por fora — o filtro de
 *     PantryService.applyNfceItems exige origin='USER'.
 *  2. Decisão do usuário (decideImport.catalog=true / linkItemToProduct /
 *     confirmItemProduct / classifyPendingBatch) vira o produto em
 *     origin='USER' — a partir daí, COM controle entra em Despensa Estoque,
 *     SEM controle entra só na Lista de Compra.
 *  3. listClassifiedActive traz todos os USER ativos (Com ou Sem controle).
 */
import { makeCtx, seedAccount } from '../helpers';

describe('v101 — Despensa: AUTO-NFCE não entra até o usuário decidir', () => {
  test('applyNfceItems ignora produto AUTO-NFCE mesmo com stock_control=1 forçado', async () => {
    const { services, db } = await makeCtx();
    const acc = await seedAccount(db);
    // Força um produto AUTO-NFCE com stock_control=1 (simula o override antigo).
    const p = await services.products.createManualProduct({
      name: 'Mamão AUTO', baseUnit: 'G',
    });
    await db.runAsync(
      "UPDATE products_catalog SET origin = 'NFCE', stock_control = 1 WHERE id = ?",
      [p.id]
    );
    // Semeia nfce_document e um item PARSED apontando para esse produto.
    const KEY = '1'.repeat(44);
    await db.runAsync(
      `INSERT INTO nfce_documents (access_key, store_name, issued_at, amount_paid_cents, parse_status, needs_review)
       VALUES (?, 'Loja', '2026-11-15T12:00:00.000Z', 1500, 'COMPLETE', 0)`,
      [KEY]
    );
    const itemId = 'it-mamao-001';
    await db.runAsync(
      `INSERT INTO nfce_items (id, access_key, line_number, description, qty, unit_original, total_cents, product_id, status, stock_applied)
       VALUES (?, ?, 1, 'MAMAO', 2, 'KG', 1500, ?, 'PARSED', 0)`,
      [itemId, KEY, p.id]
    );
    const tx = await services.transactions.createAccountExpense({
      description: 'NFC-e', amountCents: 1500, date: '2026-11-15',
      categoryId: null, accountId: acc,
    });
    const out = await services.nfce.attachToTransaction(KEY, tx.id, null);
    // Bloqueado: AUTO-NFCE não entra, mesmo com controle.
    expect(out.applied).toBe(0);
    const stock = await db.getFirstAsync<{ q: number | null }>(
      'SELECT quantity_base AS q FROM pantry_stock WHERE product_id = ?',
      [p.id]
    );
    expect(stock?.q ?? 0).toBe(0);
  });

  test('decideImport(catalog: true, stockControl: true) vira USER e aplica estoque', async () => {
    const { services, db } = await makeCtx();
    const acc = await seedAccount(db);
    const p = await services.products.createManualProduct({
      name: 'Mamão MANUAL', baseUnit: 'G',
    });
    await db.runAsync(
      "UPDATE products_catalog SET origin = 'NFCE', stock_control = 0 WHERE id = ?",
      [p.id]
    );
    const KEY = '2'.repeat(44);
    await db.runAsync(
      `INSERT INTO nfce_documents (access_key, store_name, issued_at, amount_paid_cents, parse_status, needs_review)
       VALUES (?, 'Loja', '2026-11-15T12:00:00.000Z', 1500, 'COMPLETE', 0)`,
      [KEY]
    );
    const itemId = 'it-decide-002';
    await db.runAsync(
      `INSERT INTO nfce_items (id, access_key, line_number, description, qty, unit_original, total_cents, product_id, status, stock_applied)
       VALUES (?, ?, 1, 'MAMAO', 2, 'KG', 1500, ?, 'PARSED', 0)`,
      [itemId, KEY, p.id]
    );
    const tx = await services.transactions.createAccountExpense({
      description: 'NFC-e', amountCents: 1500, date: '2026-11-15',
      categoryId: null, accountId: acc,
    });
    await services.nfce.attachToTransaction(KEY, tx.id, null);
    // decideImport.catalog=true CRIA um novo produto USER e rebinda o item
    // para esse novo produto (decisão do usuário).
    await services.nfce.decideImport(itemId, { catalog: true, stockControl: true, neverAgain: false });
    const newProd = await db.getFirstAsync<{ product_id: string | null }>(
      'SELECT product_id FROM nfce_items WHERE id = ?',
      [itemId]
    );
    const prodRow = await db.getFirstAsync<{ origin: string; stock_control: number }>(
      'SELECT origin, stock_control FROM products_catalog WHERE id = ?',
      [newProd?.product_id!]
    );
    expect(newProd?.product_id).not.toBe(p.id);
    expect(prodRow?.origin).toBe('USER');
    expect(prodRow?.stock_control).toBe(1);
  });
});

describe('v101 — listClassifiedActive: USER ativos com e sem controle', () => {
  test('lista USER ativos (Com/Sem controle); AUTO-NFCE sai fora', async () => {
    const { services, db } = await makeCtx();
    const userCom = await services.products.createManualProduct({
      name: 'Arroz USER com controle', baseUnit: 'G', stockControl: 1,
    });
    const userSem = await services.products.createManualProduct({
      name: 'Sabonete USER sem controle', baseUnit: 'UN', stockControl: 0,
    });
    const autoFora = await services.products.createManualProduct({
      name: 'Mamão AUTO com controle', baseUnit: 'G', stockControl: 1,
    });
    await db.runAsync("UPDATE products_catalog SET origin = 'NFCE' WHERE id = ?", [autoFora.id]);
    // Inativo — também sumir da lista.
    const userInativo = await services.products.createManualProduct({
      name: 'Farinha USER inativa', baseUnit: 'G', stockControl: 1,
    });
    await db.runAsync("UPDATE products_catalog SET status = 'INATIVO' WHERE id = ?", [userInativo.id]);
    const list = await services.pantry.listClassifiedActive();
    const ids = list.map((r) => r.product_id);
    expect(ids).toContain(userCom.id);
    expect(ids).toContain(userSem.id);
    expect(ids).not.toContain(autoFora.id);
    expect(ids).not.toContain(userInativo.id);
  });
});
