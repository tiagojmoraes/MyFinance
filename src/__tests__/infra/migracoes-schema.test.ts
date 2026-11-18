/** Fase 1 — Migrações, WAL, FK e constraints do schema v7. */

import { runMigrations, MIGRATIONS } from '../../db/migrations';
import { PRESET_CATEGORIES } from '../../db/schema';
import { BetterSQLiteDriver } from '../../db/BetterSQLiteDriver';
import { makeCtx, expectRejects } from '../helpers';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

describe('Migrações (sistema user_version)', () => {
  test('aplica todas as migrações em banco novo', async () => {
    const db = BetterSQLiteDriver.memory();
    const { applied, current } = await runMigrations(db);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.version));
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(row?.user_version).toBe(current);
  });

  test('é idempotente (reexecução não reaplica)', async () => {
    const db = BetterSQLiteDriver.memory();
    await runMigrations(db);
    const { applied } = await runMigrations(db);
    expect(applied).toEqual([]);
  });

  test('v88: banco novo NÃO nasce com categorias padrão (o app não cria nenhuma)', async () => {
    const { db } = await makeCtx();
    const row = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM categories');
    expect(row?.count).toBe(0);
  });

  test('v88: a migração 57 tira as categorias do seed INTACTAS e sem uso (e preserva as demais)', async () => {
    const db = BetterSQLiteDriver.memory();
    await runMigrations(db);
    // simula a base ANTIGA: as 13 categorias do seed + uma categoria do usuário
    for (const c of PRESET_CATEGORIES) {
      await db.runAsync('INSERT INTO categories (id, name, color_hex) VALUES (?,?,?)', [c.id, c.name, c.colorHex]);
    }
    await db.runAsync('INSERT INTO categories (id, name, color_hex) VALUES (?,?,?)', ['cat-minha', 'Minha', '#123456']);
    // uma do seed com MOVIMENTO (não pode sair — quebraria o dado)
    await db.runAsync(
      "INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES ('acc-x','Conta','CHECKING',0,1)"
    );
    await db.runAsync(
      `INSERT INTO transactions (id, kind, type, amount_cents, occurred_on, occurred_at, description, category_id, account_id, source_system, status)
       VALUES ('tx-x','SIMPLE','EXPENSE',100,'2026-11-10','2026-11-10T12:00:00.000Z','Compra','cat-mercado','acc-x','MANUAL','CONFIRMED')`
    );
    // uma do seed RENOMEADA pelo usuário (id igual, nome diferente) — fica
    await db.runAsync("UPDATE categories SET name = 'Meu Transporte' WHERE id = 'cat-transporte'");

    const m57 = MIGRATIONS.find((m) => m.version === 57);
    expect(m57).toBeDefined();
    await m57!.fn!(db);

    const restantes = await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM categories ORDER BY id');
    const ids = restantes.map((c) => c.id);
    // a que tem movimento continua
    expect(ids).toContain('cat-mercado');
    // a que o usuário renomeou continua
    expect(ids).toContain('cat-transporte');
    // a categoria do usuário continua
    expect(ids).toContain('cat-minha');
    // as do seed, intactas e sem uso, saíram
    expect(ids).not.toContain('cat-lazer');
    expect(ids).not.toContain('cat-servicos');
    expect(ids).not.toContain('cat-outros');
    // e o nome renomeado foi preservado
    expect(restantes.find((c) => c.id === 'cat-transporte')?.name).toBe('Meu Transporte');
  });

  test('WAL ativado em banco em arquivo (crítico da Fase 1)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfm-'));
    const dbPath = path.join(dir, 'test.db');
    const db = BetterSQLiteDriver.file(dbPath);
    await runMigrations(db);
    const row = await db.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(row?.journal_mode.toLowerCase()).toBe('wal');
    await db.closeAsync();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('foreign_keys ON (ARQ-005)', async () => {
    const { db } = await makeCtx();
    const row = await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(row?.foreign_keys).toBe(1);
  });

  test('v87: transactions tem a coluna payment_hold (marcador de "Não Pago" do usuário)', async () => {
    const { db } = await makeCtx();
    const cols = (await db.getAllAsync<{ name: string }>("PRAGMA table_info('transactions')")).map((c) => c.name);
    expect(cols).toContain('payment_hold');
  });

  test('v87: migração 56 vem depois da 55 (v86_indices_performance)', () => {
    const v55 = MIGRATIONS.find((m) => m.version === 55)?.name;
    const v56 = MIGRATIONS.find((m) => m.version === 56)?.name;
    expect(v55).toBe('v86_indices_performance');
    expect(v56).toBe('v87_nao_pago_manual');
    // ordem importa: as 56 só referencia a tabela que já existe (transactions)
    const idx55 = MIGRATIONS.findIndex((m) => m.version === 55);
    const idx56 = MIGRATIONS.findIndex((m) => m.version === 56);
    expect(idx56).toBe(idx55 + 1);
  });

  test('v94: migração 58 normaliza contas POUPANÇA para fora do saldo geral', async () => {
    const db = BetterSQLiteDriver.memory();
    await runMigrations(db);
    // base antiga: poupança marcada como SIM (bug), corrente marcada como SIM (ok).
    await db.runAsync(
      "INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES ('acc-sav','Minha Poupança','SAVINGS',0,1)"
    );
    await db.runAsync(
      "INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES ('acc-chk','Conta','CHECKING',0,1)"
    );
    await db.runAsync(
      "INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES ('acc-cash','Dinheiro','CASH',0,1)"
    );
    // aplica migração 58
    const m58 = MIGRATIONS.find((m) => m.version === 58);
    expect(m58).toBeDefined();
    expect(m58!.name).toBe('v94_poupanca_fora_saldo');
    await db.runAsync(m58!.sql);
    const rows = await db.getAllAsync<{ id: string; include_in_general_balance: number }>(
      'SELECT id, include_in_general_balance FROM accounts ORDER BY id'
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.include_in_general_balance]));
    // SAVINGS sempre 0
    expect(byId['acc-sav']).toBe(0);
    // CHECKING e CASH continuam como estavam
    expect(byId['acc-chk']).toBe(1);
    expect(byId['acc-cash']).toBe(1);
    // idempotente: rodar de novo não faz nada
    await db.runAsync(m58!.sql);
    const after = await db.getFirstAsync<{ include_in_general_balance: number }>(
      "SELECT include_in_general_balance FROM accounts WHERE id = 'acc-sav'"
    );
    expect(after?.include_in_general_balance).toBe(0);
  });
});

describe('Constraints do schema v7', () => {
  test('FK RESTRICT impede DELETE de transação com move (ARQ-005)', async () => {
    const { db, services } = await makeCtx();
    const acc = `acc-${Math.random().toString(36).slice(2, 8)}`;
    await db.runAsync(
      "INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?, 'CHECKING', 0, 1)",
      [acc, 'Conta FK']
    );
    await services.transactions.createAccountExpense({
      description: 'Café', amountCents: 500, accountId: acc,
    });
    const tx = await db.getFirstAsync<{ id: string }>('SELECT id FROM transactions LIMIT 1');
    // eslint-disable-next-line no-console
    console.error('FK_DEBUG tx=', tx, 'sameDbAsCtx=', db === services.db);
    try {
      await db.runAsync('DELETE FROM transactions WHERE id = ?', [tx!.id]);
      // eslint-disable-next-line no-console
      console.error('FK_DEBUG: DELETE passou sem erro!');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('FK_DEBUG: DELETE falhou com:', (e as Error).message);
    }
    await expectRejects(async () => {
      await db.runAsync('DELETE FROM transactions WHERE id = ?', [tx!.id])
    });
  });

  test('CHECK de tipo inválido é rejeitado', async () => {
    const { db } = await makeCtx();
    await expectRejects(async () => {
      await db.runAsync(
        "INSERT INTO transactions (id, kind, type, amount_cents, occurred_on, occurred_at, description, source_system, status) VALUES ('x','SIMPLE','PIX',100,'2026-01-01','2026-01-01T12:00:00Z','t','MANUAL','CONFIRMED')"
      )
    });
  });

  test('financial_moves exige exatamente UMA origem (XOR)', async () => {
    const { db } = await makeCtx();
    await expectRejects(async () => {
      await db.runAsync(
        "INSERT INTO financial_moves (id, account_id, direction, amount_cents, effective_date, status) VALUES ('m1','a','DEBIT',100,'2026-01-01','CONFIRMED')"
      )
    });
  });

  test('UNIQUE(source_system, external_ref_id) garante idempotência (ARQ-003)', async () => {
    const { db } = await makeCtx();
    const insert = () =>
      db.runAsync(
        "INSERT INTO transactions (id, kind, type, amount_cents, occurred_on, occurred_at, description, source_system, external_ref_id, status) VALUES (?,?,?,?,?,?,?,?,?,'CONFIRMED')",
        [`t${Math.random()}`, 'SIMPLE', 'EXPENSE', 100, '2026-01-01', '2026-01-01T12:00:00Z', 'd', 'OFX_BANK', 'fitid-1']
      );
    await insert();
    await expectRejects(async () => {
      await insert();
    });
  });

  test('CHECK de valor positivo em transactions', async () => {
    const { db } = await makeCtx();
    await expectRejects(async () => {
      await db.runAsync(
        "INSERT INTO transactions (id, kind, type, amount_cents, occurred_on, occurred_at, description, source_system, status) VALUES ('y','SIMPLE','EXPENSE',0,'2026-01-01','2026-01-01T12:00:00Z','d','MANUAL','CONFIRMED')"
      )
    });
  });

  test('pantry_stock não aceita negativo', async () => {
    const { db } = await makeCtx();
    await db.runAsync(
      "INSERT INTO products_catalog (id, name, origin) VALUES ('p1','Arroz','USER')"
    );
    await expectRejects(async () => {
      await db.runAsync(
        "INSERT INTO pantry_stock (product_id, quantity_base) VALUES ('p1', -5)"
      )
    });
  });

  test('nfce_documents exige chave de 44 dígitos', async () => {
    const { db } = await makeCtx();
    await expectRejects(async () => {
      await db.runAsync(
        "INSERT INTO nfce_documents (access_key, parse_status) VALUES ('123', 'PENDING')"
      )
    });
  });

  test('installment_plans exige cartão XOR conta', async () => {
    const { db } = await makeCtx();
    await expectRejects(async () => {
      await db.runAsync(
        "INSERT INTO installment_plans (id, total_installments, mode, first_due_date) VALUES ('pl',2,'DIVIDE_TOTAL','2026-01-10')"
      )
    });
  });
});
