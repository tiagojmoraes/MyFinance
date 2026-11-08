/**
 * Setup compartilhado dos testes: driver better-sqlite3 em memória com migrações aplicadas.
 */

import { BetterSQLiteDriver } from '../db/BetterSQLiteDriver';
import { runMigrations } from '../db/migrations';
import { buildServices } from '../services';
import type { DbDriver } from '../db/types';

export interface TestCtx {
  db: DbDriver;
  services: ReturnType<typeof buildServices>;
}

export async function makeCtx(): Promise<TestCtx> {
  const db = BetterSQLiteDriver.memory();
  await runMigrations(db);
  const services = buildServices(db);
  return { db, services };
}

/** Cria conta de teste. */
export async function seedAccount(db: DbDriver, name = 'Conta Principal', initial = 0): Promise<string> {
  const id = `acc-${name}-${Math.random().toString(36).slice(2, 8)}`;
  await db.runAsync(
    'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?,?,?,1)',
    [id, name, 'CHECKING', initial]
  );
  return id;
}

export async function seedCard(db: DbDriver, accountId: string, name = 'Cartão Teste', closingDay = 15, dueDay = 10): Promise<string> {
  const id = `card-${name}-${Math.random().toString(36).slice(2, 8)}`;
  await db.runAsync(
    'INSERT INTO cards (id, name, last_four_digits, closing_day, due_day, linked_account_id) VALUES (?,?,?,?,?,?)',
    [id, name, '1234', closingDay, dueDay, accountId]
  );
  return id;
}

export async function getAccountBalance(db: DbDriver, accountId: string): Promise<number> {
  const row = await db.getFirstAsync<{ bal: number }>(
    `SELECT a.initial_balance_cents
       + COALESCE((SELECT SUM(CASE WHEN fm.direction='CREDIT' THEN fm.amount_cents ELSE -fm.amount_cents END)
                    FROM financial_moves fm
                   WHERE fm.account_id = a.id AND fm.effective_date <= '2100-12-31' AND fm.status = 'CONFIRMED'), 0) AS bal
       FROM accounts a WHERE a.id = ?`,
    [accountId]
  );
  return row?.bal ?? 0;
}

/**
 * Asserção determinística de rejeição (contorna inconsistências do matcher
 * expect().rejects com better-sqlite3 no Node 24).
 */
export async function expectRejects(fn: () => Promise<unknown>, pattern?: RegExp | string): Promise<Error> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  if (!caught) {
    throw new Error(`Esperava rejeição, mas a função resolveu. Pattern: ${String(pattern ?? '')}`);
  }
  const err = caught instanceof Error ? caught : new Error(String(caught));
  if (pattern) {
    const ok = pattern instanceof RegExp ? pattern.test(err.message) : err.message.includes(pattern);
    if (!ok) throw new Error(`Mensagem "${err.message}" não casa com ${String(pattern)}`);
  }
  return err;
}
