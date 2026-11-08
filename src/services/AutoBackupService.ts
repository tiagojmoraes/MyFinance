// v46 #7 — Backup automático (lógica, sem tela)
// Chamar onDataVersionChange(dataVersion) após cada bump: se mudou, salva snapshot JSON.
// Não mexe em layout: a tela existente de Ajustes continua igual.
import type { DbDriver } from '../db/types';
export class AutoBackupService {
  private lastVersion = -1;
  private lastAt = 0;
  constructor(private db: DbDriver) {}
  shouldBackup(dataVersion: number): boolean {
    if (dataVersion === this.lastVersion) return false;
    if (Date.now() - this.lastAt < 60_000) return false; // no máximo 1x por minuto
    return true;
  }
  mark(dataVersion: number) { this.lastVersion = dataVersion; this.lastAt = Date.now(); }
  /** v48 #8 — backup via VACUUM INTO (arquivo), não JSON gigante em memória.
   *  Antes: JSON.stringify de todas as tabelas = 8MB string, trava 1s.
   *  Depois: VACUUM INTO arquivo (driver já tem vacuumInto) — sem string gigante.
   */
  async exportViaVacuum(targetPath: string): Promise<string> {
    // @ts-ignore driver tem vacuumInto
    if (typeof (this.db as any).vacuumInto === 'function') await (this.db as any).vacuumInto(targetPath);
    return targetPath;
  }
  async exportJson(): Promise<string> {
    const tables = ['accounts','transactions','financial_moves','categories','cards','invoices','installments','installment_plans','recurrence_rules','budgets','savings_plans','savings_entries'];
    const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), version: 46 };
    for (const t of tables) {
      try { out[t] = await this.db.getAllAsync(`SELECT * FROM ${t}`); } catch { out[t] = []; }
    }
    return JSON.stringify(out);
  }
}
