/**
 * Interface de driver de banco — permite o mesmo SQL rodar em expo-sqlite (device)
 * e better-sqlite3 (testes Jest), mantendo os services 100% testáveis.
 */

export type SqlValue = string | number | null | Uint8Array;

export interface RunResult {
  changes: number;
}

export interface DbDriver {
  /** Executa SQL bruto multi-statement (DDL, PRAGMA, BEGIN/COMMIT). */
  execAsync(sql: string): Promise<void>;
  /** Executa statement parametrizado. */
  runAsync(sql: string, params?: SqlValue[]): Promise<RunResult>;
  /** Retorna todas as linhas. */
  getAllAsync<T = unknown>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** Retorna a primeira linha ou null. */
  getFirstAsync<T = unknown>(sql: string, params?: SqlValue[]): Promise<T | null>;
  /**
   * Transação reentrante: no nível externo usa BEGIN IMMEDIATE (ARQ-004);
   * níveis internos usam SAVEPOINTs. All-or-nothing.
   */
  transactionAsync<T>(fn: () => Promise<T>): Promise<T>;
  /** Fecha a conexão (usado antes do restore de backup). */
  closeAsync(): Promise<void>;
}
