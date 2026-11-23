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
  /**
   * v87 (BUG ALTA): valida um arquivo .db candidato à restauração.
   * Deve lançar (ou devolver false) quando o arquivo NÃO for um SQLite íntegro
   * com as tabelas do MyFinance. Sem esta validação, restaurar um PDF
   * escolhido por engano apagava o banco e deixava o arquivo inválido no lugar.
   */
  validateFile?: (path: string) => Promise<boolean>;
  /** Alternativa barata de validação: assinatura "SQLite format 3". */
  readSignature?: (path: string) => Promise<string>;
}

export interface RestoreResult {
  ok: boolean;
  needsRestart: true;
  /** v87: cópia de segurança do banco ANTERIOR (o app não apaga nada sem rede). */
  safetyCopy?: string;
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

  /**
   * Restaura a partir de um arquivo .db (URI local). Requer reinício do app.
   *
   * v87 (BUG ALTA — perda total de dados): a versão anterior APAGAVA o banco
   * ANTES de copiar o arquivo escolhido e não validava nada — um PDF/foto
   * escolhido por engano deixava o app sem banco e sem volta. Agora:
   *   1) copia o escolhido para um TEMPORÁRIO (o banco atual fica intacto);
   *   2) VALIDA o temporário (SQLite íntegro + tabelas do MyFinance);
   *   3) só então tira um snapshot de segurança do banco atual (VACUUM INTO);
   *   4) fecha o banco, apaga o .db antigo (+ -wal/-shm) e troca o arquivo.
   * Qualquer falha antes do passo 4 deixa o banco do usuário intacto.
   *
   * v16: marca o livro-razão para recalcular do zero (`ledger_dirty_from =
   * '0000-00'`) ANTES do swap. O month_ledger não sai no backup como
   * export (é cache derivado), e qualquer pequena diferença de versão /
   * timestamp / estado entre lançamentos e cache justifica o recálculo.
   * Feito aqui porque o banco AINDA está aberto neste ponto (o swap
   * só ocorre no passo 4).
   */
  async restoreFrom(sourceUri: string): Promise<RestoreResult> {
    if (!this.deps.copyFile) throw new Error('Filesystem não configurado para restore');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tmpPath = `${this.deps.backupsDir}restore-tmp-${stamp}.db`;
    const safetyPath = `${this.deps.backupsDir}pre-restore-${stamp}.db`;

    if (this.deps.ensureDir) await this.deps.ensureDir(this.deps.backupsDir);

    // 1) cópia temporária — o banco de produção NÃO é tocado ainda
    await this.deps.copyFile(sourceUri, tmpPath);
    let valid = false;
    try {
      if (this.deps.validateFile) {
        valid = (await this.deps.validateFile(tmpPath)) === true;
      } else if (this.deps.readSignature) {
        const sig = await this.deps.readSignature(tmpPath);
        valid = typeof sig === 'string' && sig.startsWith('SQLite format 3');
      }
      if (!valid) {
        throw new Error('Arquivo inválido: não é um banco de dados do MyFinance. Nada foi alterado.');
      }

      // 3) snapshot de segurança do banco ATUAL (antes da troca)
      let safetyCopy: string | undefined;
      try {
        await this.deps.vacuumInto(safetyPath.replace('file://', ''));
        safetyCopy = safetyPath;
      } catch {
        // sem VACUUM INTO não há snapshot — a troca continua, mas avisa
        safetyCopy = undefined;
      }

      // v16 (livro-razão): marca para recálculo total ANTES de fechar o
      // banco. O cache do ledger NÃO vai no backup (é derivativo) e a
      // versão das regras pode ter mudado.
      try {
        await this.db.runAsync(
          `INSERT INTO app_settings (key, value) VALUES ('ledger_dirty_from', '0000-00')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        );
        await this.db.runAsync('DELETE FROM month_ledger_wishlist;');
        await this.db.runAsync('DELETE FROM month_ledger;');
      } catch {
        // sem tabelas do livro (backup de versão < v16) — segue; a própria
        // migração 62 ao reabrir vai seedar a chave com '0000-00' default.
      }

      // 4) troca do banco
      await this.db.closeAsync();
      await this.deps.deleteFile?.(this.deps.databasePath);
      // v87: o banco roda em WAL — sem apagar o -wal/-shm, o WAL antigo é
      // reaplicado por cima do arquivo restaurado (corrupção clássica).
      await this.deps.deleteFile?.(`${this.deps.databasePath}-wal`);
      await this.deps.deleteFile?.(`${this.deps.databasePath}-shm`);
      await this.deps.copyFile(tmpPath, this.deps.databasePath);
      return { ok: true, needsRestart: true, safetyCopy };
    } finally {
      // o temporário nunca fica pendurado no dispositivo
      try {
        await this.deps.deleteFile?.(tmpPath);
      } catch {
        // best effort
      }
    }
  }
}
