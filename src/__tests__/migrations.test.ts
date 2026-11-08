/** Fase 1 — Migrações, WAL, FK e constraints do schema v7. */

import { runMigrations, MIGRATIONS } from '../db/migrations';
import { BetterSQLiteDriver } from '../db/BetterSQLiteDriver';
import { makeCtx, expectRejects } from './helpers';
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

  test('seed de categorias presente', async () => {
    const { db } = await makeCtx();
    const row = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM categories');
    expect(row?.count).toBeGreaterThanOrEqual(13);
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
