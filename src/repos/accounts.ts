/** Repositórios de accounts e cards. */

import type { DbDriver } from '../db/types';

export interface AccountRow {
  id: string;
  name: string;
  type: 'CHECKING' | 'SAVINGS' | 'CASH';
  initial_balance_cents: number;
  /** v20: data âncora do saldo inicial (NULL = vale "desde sempre"). */
  initial_balance_date: string | null;
  include_in_general_balance: number;
}

export interface CardRow {
  id: string;
  name: string;
  last_four_digits: string | null;
  closing_day: number;
  due_day: number;
  linked_account_id: string | null;
}

export class AccountRepo {
  constructor(private db: DbDriver) {}

  getAll(): Promise<AccountRow[]> {
    return this.db.getAllAsync<AccountRow>('SELECT * FROM accounts ORDER BY name');
  }

  getById(id: string): Promise<AccountRow | null> {
    return this.db.getFirstAsync<AccountRow>('SELECT * FROM accounts WHERE id = ?', [id]);
  }

  insert(row: AccountRow): Promise<unknown> {
    return this.db.runAsync(
      'INSERT INTO accounts (id, name, type, initial_balance_cents, initial_balance_date, include_in_general_balance) VALUES (?,?,?,?,?,?)',
      [row.id, row.name, row.type, row.initial_balance_cents, row.initial_balance_date, row.include_in_general_balance]
    );
  }

  update(id: string, patch: Partial<Omit<AccountRow, 'id'>>): Promise<unknown> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
    if (patch.type !== undefined) { sets.push('type = ?'); params.push(patch.type); }
    if (patch.initial_balance_cents !== undefined) { sets.push('initial_balance_cents = ?'); params.push(patch.initial_balance_cents); }
    if (patch.initial_balance_date !== undefined) { sets.push('initial_balance_date = ?'); params.push(patch.initial_balance_date); }
    if (patch.include_in_general_balance !== undefined) { sets.push('include_in_general_balance = ?'); params.push(patch.include_in_general_balance); }
    if (!sets.length) return Promise.resolve({ changes: 0 });
    params.push(id);
    return this.db.runAsync(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, params as never);
  }
}

export class CardRepo {
  constructor(private db: DbDriver) {}

  getAll(): Promise<CardRow[]> {
    return this.db.getAllAsync<CardRow>('SELECT * FROM cards ORDER BY name');
  }

  getById(id: string): Promise<CardRow | null> {
    return this.db.getFirstAsync<CardRow>('SELECT * FROM cards WHERE id = ?', [id]);
  }

  insert(row: CardRow): Promise<unknown> {
    return this.db.runAsync(
      'INSERT INTO cards (id, name, last_four_digits, closing_day, due_day, linked_account_id) VALUES (?,?,?,?,?,?)',
      [row.id, row.name, row.last_four_digits, row.closing_day, row.due_day, row.linked_account_id]
    );
  }

  update(id: string, patch: Partial<Omit<CardRow, 'id'>>): Promise<unknown> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
    if (patch.last_four_digits !== undefined) { sets.push('last_four_digits = ?'); params.push(patch.last_four_digits); }
    if (patch.closing_day !== undefined) { sets.push('closing_day = ?'); params.push(patch.closing_day); }
    if (patch.due_day !== undefined) { sets.push('due_day = ?'); params.push(patch.due_day); }
    if (patch.linked_account_id !== undefined) { sets.push('linked_account_id = ?'); params.push(patch.linked_account_id); }
    if (!sets.length) return Promise.resolve({ changes: 0 });
    params.push(id);
    return this.db.runAsync(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`, params as never);
  }
}
