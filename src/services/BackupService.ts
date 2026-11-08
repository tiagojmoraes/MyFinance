/**
 * BackupService — Fase 6: backup seguro via VACUUM INTO + restauração.
 * No device usa expo-file-system/expo-sharing; a lógica VACUUM é do driver.
 */

import type { DbDriver } from '../db/types';

export interface BackupServiceDeps {
  /** Caminho absoluto do arquivo do banco (ex.: documentDirectory + 'SQLite/myfinance.db'). */
  databasePath: string;
  /** Diretório de destino dos backups. */
  backupsDir: string;
  vacuumInto: (targetPath: string) => Promise<void>;
  listFiles?: (dir: string) => Promise<string[]>;
  copyFile?: (from: string, to: string) => Promise<void>;
  deleteFile?: (path: string) => Promise<void>;
  ensureDir?: (dir: string) => Promise<void>;
}

export class BackupService {
  constructor(private db: DbDriver, private deps: BackupServiceDeps) {}

  /** Cria backup físico consistente (VACUUM INTO grava cópia limpa e compactada). */
  async createBackup(filename?: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = filename ?? `myfinance-backup-${stamp}.db`;
    if (this.deps.ensureDir) await this.deps.ensureDir(this.deps.backupsDir);
    const target = `${this.deps.backupsDir}${name}`;
    await this.deps.vacuumInto(target.replace('file://', ''));
    return target;
  }

  async listBackups(): Promise<string[]> {
    if (!this.deps.listFiles) return [];
    try {
      return (await this.deps.listFiles(this.deps.backupsDir)).filter((f) => f.endsWith('.db')).sort().reverse();
    } catch {
      return [];
    }
  }

  /** Restaura a partir de um arquivo .db (URI local). Requer reinício do app. */
  async restoreFrom(sourceUri: string): Promise<{ ok: boolean; needsRestart: true }> {
    if (!this.deps.copyFile) throw new Error('Filesystem não configurado para restore');
    await this.db.closeAsync();
    if (this.deps.deleteFile) {
      try {
        await this.deps.deleteFile(this.deps.databasePath);
      } catch {
        // arquivo pode não existir
      }
    }
    await this.deps.copyFile(sourceUri, this.deps.databasePath);
    return { ok: true, needsRestart: true };
  }
}
