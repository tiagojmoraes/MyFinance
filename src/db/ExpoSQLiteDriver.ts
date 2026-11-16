/**
 * Adapter expo-sqlite (runtime Android) — implementa DbDriver com transações
 * reentrantes (BEGIN IMMEDIATE externo, SAVEPOINT aninhado) — ARQ-004.
 */

import * as SQLite from 'expo-sqlite';
import type { DbDriver, RunResult, SqlValue } from './types';

export class ExpoSQLiteDriver implements DbDriver {
  private db: SQLite.SQLiteDatabase;
  private txDepth = 0;
  /**
   * v87 (BUG MÉDIA): fila das transações de TOPO. Antes, duas transações de
   * topo que começavam juntas se misturavam: a segunda via SAVEPOINT dentro da
   * primeira e, se a primeira falhasse, o ROLLBACK dela levava junto o trabalho
   * da segunda (já "confirmado"). Agora as transações de topo rodam uma por
   * vez; as ANINHADAS (chamadas de dentro do corpo de outra transação)
   * continuam usando SAVEPOINT, como sempre.
   */
  private filaTop: Promise<unknown> = Promise.resolve();

  private constructor(db: SQLite.SQLiteDatabase) {
    this.db = db;
  }

  /** Abre o banco com WAL + FK ON (crítico da Fase 1). */
  static async open(databaseName = 'myfinance.db'): Promise<ExpoSQLiteDriver> {
    const db = await SQLite.openDatabaseAsync(databaseName);
    await db.execAsync(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
    `);
    return new ExpoSQLiteDriver(db);
  }

  /** Caminho físico do arquivo do banco (para backup/restore). */
  get path(): string | null {
    return this.db.databasePath ?? null;
  }

  async execAsync(sql: string): Promise<void> {
    await this.db.execAsync(sql);
  }

  async runAsync(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    const res = await this.db.runAsync(sql, params);
    return { changes: res.changes };
  }

  async getAllAsync<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, params);
  }

  async getFirstAsync<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return this.db.getFirstAsync<T>(sql, params);
  }

  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    // NESTADA (depth > 0): SAVEPOINT — como sempre.
    if (this.txDepth > 0) return this.execTransaction(fn);
    // TOPO: entra na FILA (uma por vez) — v87.
    const anterior = this.filaTop;
    let liberar!: () => void;
    this.filaTop = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    await anterior;
    try {
      return await this.execTransaction(fn);
    } finally {
      liberar();
    }
  }

  /** Execução da transação (BEGIN/SAVEPOINT … COMMIT/ROLLBACK). */
  private async execTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this.txDepth++;
    try {
      if (this.txDepth === 1) {
        await this.db.execAsync('BEGIN IMMEDIATE');
      } else {
        await this.db.execAsync(`SAVEPOINT sp_${this.txDepth}`);
      }
      const result = await fn();
      if (this.txDepth === 1) {
        await this.db.execAsync('COMMIT');
      } else {
        await this.db.execAsync(`RELEASE SAVEPOINT sp_${this.txDepth}`);
      }
      return result;
    } catch (err) {
      try {
        if (this.txDepth === 1) {
          await this.db.execAsync('ROLLBACK');
        } else {
          await this.db.execAsync(`ROLLBACK TO SAVEPOINT sp_${this.txDepth}`);
          await this.db.execAsync(`RELEASE SAVEPOINT sp_${this.txDepth}`);
        }
      } catch {
        // rollback já efetivado ou conexão abortada — segue com erro original
      }
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  async closeAsync(): Promise<void> {
    await this.db.closeAsync();
  }

  /** VACUUM INTO para backup seguro (Fase 6). */
  async vacuumInto(targetPath: string): Promise<void> {
    await this.db.execAsync(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  }
}
