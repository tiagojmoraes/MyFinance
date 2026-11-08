/**
 * Adapter better-sqlite3 — SOMENTE para testes Jest (suíte da Fase 1).
 * Mesma semântica de transação reentrante do driver Expo.
 */

import Database from 'better-sqlite3';
import type { DbDriver, RunResult, SqlValue } from './types';

export class BetterSQLiteDriver implements DbDriver {
  private db: Database.Database;
  private txDepth = 0;

  constructor(db: Database.Database, opts: { enableForeignKeys?: boolean; enableWal?: boolean } = {}) {
    this.db = db;
    if (opts.enableForeignKeys !== false) {
      this.db.pragma('foreign_keys = ON');
    }
    if (opts.enableWal) {
      try {
        this.db.pragma('journal_mode = WAL');
      } catch {
        // ':memory:' não suporta WAL — irrelevante para testes
      }
    }
    this.db.pragma('busy_timeout = 5000');
  }

  /** Banco em memória (padrão dos testes). */
  static memory(): BetterSQLiteDriver {
    return new BetterSQLiteDriver(new Database(':memory:'), { enableWal: false });
  }

  /** Banco em arquivo temporário (para testes de WAL/backup). */
  static file(path: string): BetterSQLiteDriver {
    return new BetterSQLiteDriver(new Database(path), { enableWal: true });
  }

  async execAsync(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async runAsync(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    const stmt = this.db.prepare(sql);
    const res = stmt.run(...params);
    return { changes: res.changes };
  }

  async getAllAsync<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async getFirstAsync<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    const row = this.db.prepare(sql).get(...params) as T | undefined;
    return row ?? null;
  }

  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.txDepth++;
    try {
      if (this.txDepth === 1) {
        this.db.exec('BEGIN IMMEDIATE');
      } else {
        this.db.exec(`SAVEPOINT sp_${this.txDepth}`);
      }
      const result = await fn();
      if (this.txDepth === 1) {
        this.db.exec('COMMIT');
      } else {
        this.db.exec(`RELEASE SAVEPOINT sp_${this.txDepth}`);
      }
      return result;
    } catch (err) {
      try {
        if (this.txDepth === 1) {
          this.db.exec('ROLLBACK');
        } else {
          this.db.exec(`ROLLBACK TO SAVEPOINT sp_${this.txDepth}`);
          this.db.exec(`RELEASE SAVEPOINT sp_${this.txDepth}`);
        }
      } catch {
        // segue com o erro original
      }
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  async closeAsync(): Promise<void> {
    this.db.close();
  }

  async vacuumInto(targetPath: string): Promise<void> {
    this.db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  }
}
