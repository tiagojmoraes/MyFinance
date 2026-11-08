/**
 * OfxService — CONCILIAÇÃO OFX BATCH PROCESSING (v7).
 *
 * Algoritmo da spec (evita bloqueio de UI e N+1 queries):
 *  1. Parsear arquivo OFX inteiro em memória.
 *  2. Hash SHA-256 -> verificar uniqueness em ofx_imports (abortar se duplicado).
 *  3. Query SQL agregada (CTE com VALUES do lote) buscando TODOS os candidatos.
 *  4. Processar resultados em JS/TS: agrupar por FITID, heurística de desempate
 *     (memo similarity + date proximity), classificar MATCHED_AUTO / AMBIGUOUS / NEW_TX.
 *  5. Abrir UMA transação SQLite e gravar todos os inserts/updates do lote.
 *  6. Commit e refresh.
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { sha256Hex } from '../lib/hash';
import { nowIso, addDays } from '../lib/dates';
import { memoSimilarity, normalizeText } from '../lib/text';
import { parseOfx, dedupeByFitid } from '../parsers/ofx';
import { OfxImportRepo, OfxLineRepo } from '../repos/misc';
import { TransactionRepo, FinancialMoveRepo } from '../repos/finance';
import type { OfxStatementLineRow } from '../repos/misc';
import type { TransactionRow } from '../repos/finance';

export interface OfxImportSummary {
  importId: string;
  totalLines: number;
  matchedAuto: number;
  ambiguous: number;
  newTransactions: number;
  duplicatesInFile: number;
  errors: string[];
}

interface Candidate {
  fitid: string;
  ofxAmount: number;
  ofxDate: string;
  ofxMemo: string;
  txId: string;
  txAmount: number;
  txDate: string;
  txDescription: string | null;
}

const CHUNK_LINES = 200; // ~800 parâmetros por query (dentro do limite de variáveis do SQLite)

export class OfxService {
  private imports: OfxImportRepo;
  private lines: OfxLineRepo;
  private transactions: TransactionRepo;
  private moves: FinancialMoveRepo;

  constructor(private db: DbDriver) {
    this.imports = new OfxImportRepo(db);
    this.lines = new OfxLineRepo(db);
    this.transactions = new TransactionRepo(db);
    this.moves = new FinancialMoveRepo(db);
  }

  /** Fluxo principal — executa todo o algoritmo batch da spec v7. */
  async importOfx(accountId: string, fileContent: string): Promise<OfxImportSummary> {
    // (1) Parse em memória
    const parsed = parseOfx(fileContent);
    const { unique, duplicates } = dedupeByFitid(parsed.lines);
    if (!unique.length) {
      throw new Error(`Arquivo OFX sem linhas válidas. Erros: ${parsed.errors.slice(0, 3).join(' | ') || 'desconhecidos'}`);
    }

    // (2) Hash + uniqueness
    const hash = await sha256Hex(fileContent);
    const existing = await this.imports.findByHash(hash);
    if (existing) {
      throw new Error(`Arquivo já importado em ${existing.imported_at} (dedupe por SHA-256)`);
    }

    const importId = genId();
    await this.imports.insert({
      id: importId,
      content_hash_sha256: hash,
      account_id: accountId,
      imported_at: nowIso(),
      lines_processed: unique.length,
      errors_json: parsed.errors.length ? JSON.stringify(parsed.errors) : null,
    });

    // Persistir linhas UNPROCESSED
    for (const line of unique) {
      await this.lines.insert({
        id: genId(),
        import_id: importId,
        fitid: line.fitid,
        posted_on: line.postedOn,
        amount_cents: line.amountCents,
        memo: line.memo,
        matched_transaction_id: null,
        match_status: 'UNPROCESSED',
      });
    }

    // (3) Query agregada por chunks — TODOS os candidatos para TODO o lote.
     // Janela da spec = min/max do arquivo, com folga de ±10 dias para capturar
     // lançamentos manuais cuja data de compra difere da data bancária (clearing).
    const dates = unique.map((l) => l.postedOn).filter((d): d is string => d != null).sort();
    const minDate = dates[0] ? addDays(dates[0], -10) : null;
    const maxDate = dates[dates.length - 1] ? addDays(dates[dates.length - 1], 10) : null;

    const allCandidates: Candidate[] = [];
    for (let i = 0; i < unique.length; i += CHUNK_LINES) {
      const chunk = unique.slice(i, i + CHUNK_LINES).filter((l) => l.amountCents != null && l.postedOn);
      if (!chunk.length) continue;
      const valuesSql = chunk.map(() => '(?,?,?,?)').join(', ');
      const params: unknown[] = [];
      for (const line of chunk) {
        params.push(line.fitid, line.amountCents, line.postedOn, line.memo ?? '');
      }
      params.push(accountId, minDate, maxDate);
      const rows = await this.db.getAllAsync<Candidate>(
        `WITH batch(fitid, amount_cents, posted_on, memo) AS (VALUES ${valuesSql})
         SELECT b.fitid, b.amount_cents AS "ofxAmount", b.posted_on AS "ofxDate", b.memo AS "ofxMemo",
                t.id AS "txId", t.amount_cents AS "txAmount", t.occurred_on AS "txDate", t.description AS "txDescription"
           FROM batch b
           JOIN transactions t
             ON t.account_id = ?
            AND t.amount_cents = ABS(b.amount_cents)
            AND t.status = 'CONFIRMED'
            AND ((b.amount_cents > 0 AND t.type = 'INCOME') OR (b.amount_cents < 0 AND t.type IN ('EXPENSE','TRANSFER')))
            AND julianday(t.occurred_on) BETWEEN julianday(?) AND julianday(?)`,
        params as never
      );
      allCandidates.push(...rows);
    }
    if (process.env.DEBUG_OFX) {
      console.error('DEBUG_OFX candidates:', allCandidates.length, 'min:', minDate, 'max:', maxDate);
    }

    // (4) Classificação em JS (agrupando por FITID + heurística de desempate)
    const byFitid = new Map<string, Candidate[]>();
    for (const c of allCandidates) {
      const list = byFitid.get(c.fitid) ?? [];
      list.push(c);
      byFitid.set(c.fitid, list);
    }

    const decisions = new Map<string, { status: OfxStatementLineRow['match_status']; txId: string | null; candidates: Candidate[] }>();
    const consumedTx = new Set<string>();

    for (const line of unique) {
      const candidates = byFitid.get(line.fitid) ?? [];
      const usable = candidates.filter((c) => !consumedTx.has(c.txId));
      if (!usable.length) {
        decisions.set(line.fitid, { status: 'NEW_TX', txId: null, candidates: [] });
        continue;
      }
      const scored = usable
        .map((c) => ({
          ...c,
          score:
            memoSimilarity(line.memo, c.txDescription) +
            this.dateProximityScore(line.postedOn ?? c.ofxDate, c.txDate),
        }))
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      const second = scored[1];
      // Desempate claro: melhor score razoável e margem suficiente
      if (!second || best.score - second.score >= 0.1) {
        decisions.set(line.fitid, { status: 'MATCHED_AUTO', txId: best.txId, candidates: usable });
        consumedTx.add(best.txId);
      } else {
        decisions.set(line.fitid, { status: 'AMBIGUOUS', txId: null, candidates: usable });
      }
    }

    // (5) UMA transação SQLite para gravar o lote inteiro
    let matchedAuto = 0;
    let ambiguous = 0;
    let newTransactions = 0;

    await this.db.transactionAsync(async () => {
      for (const line of unique) {
        const decision = decisions.get(line.fitid);
        if (!decision) continue;
        const lineRow = await this.db.getFirstAsync<{ id: string }>(
          'SELECT id FROM ofx_statement_lines WHERE import_id = ? AND fitid = ?',
          [importId, line.fitid]
        );
        if (!lineRow) continue;

        if (decision.status === 'MATCHED_AUTO' && decision.txId) {
          await this.lines.setMatch(lineRow.id, 'MATCHED_AUTO', decision.txId);
          matchedAuto++;
          continue;
        }
        if (decision.status === 'AMBIGUOUS') {
          await this.lines.setMatch(lineRow.id, 'AMBIGUOUS', null);
          ambiguous++;
          continue;
        }

        // NEW_TX — checa idempotência por fitid re-importado em outro arquivo
        const refTx = await this.transactions.findByExternalRef('OFX_BANK', line.fitid);
        if (refTx) {
          await this.lines.setMatch(lineRow.id, 'MATCHED_AUTO', refTx.id);
          matchedAuto++;
          continue;
        }

        const amount = line.amountCents!;
        const txId = genId();
        const tx: TransactionRow = {
          id: txId,
          kind: 'SIMPLE',
          type: amount > 0 ? 'INCOME' : 'EXPENSE',
          amount_cents: Math.abs(amount),
          occurred_on: line.postedOn!,
          occurred_at: nowIso(),
          description: line.memo || `OFX ${line.fitid}`,
          category_id: null,
          account_id: accountId,
          transfer_account_id: null,
          card_id: null,
          source_system: 'OFX_BANK',
          external_ref_id: line.fitid,
          recurrence_rule_id: null,
          status: 'CONFIRMED',
        };
        await this.transactions.insert(tx);
        await this.moves.insert({
          id: genId(),
          transaction_id: txId,
          installment_id: null,
          invoice_payment_id: null,
          account_id: accountId,
          direction: amount > 0 ? 'CREDIT' : 'DEBIT',
          amount_cents: Math.abs(amount),
          effective_date: line.postedOn!,
          status: 'CONFIRMED',
        });
        await this.lines.setMatch(lineRow.id, 'NEW_TX', txId);
        newTransactions++;
      }
    });

    return {
      importId,
      totalLines: unique.length,
      matchedAuto,
      ambiguous,
      newTransactions,
      duplicatesInFile: duplicates,
      errors: parsed.errors,
    };
  }

  /** Vinculação manual de linha ambígua a uma transação. */
  async linkLine(lineId: string, transactionId: string): Promise<void> {
    const line = await this.lines.getById(lineId);
    if (!line) throw new Error('Linha não encontrada');
    const tx = await this.transactions.getById(transactionId);
    if (!tx) throw new Error('Transação não encontrada');
    await this.lines.setMatch(lineId, 'MATCHED_AUTO', transactionId);
  }

  /** Cria transação a partir de linha NEW_TX (revisão manual). */
  async createTransactionForLine(lineId: string): Promise<string> {
    const line = await this.lines.getById(lineId);
    if (!line || line.amount_cents == null || !line.posted_on) throw new Error('Linha inválida');
    const importRow = await this.imports.getById(line.import_id);
    if (!importRow) throw new Error('Importação não encontrada');
    const accountId = importRow.account_id;

    const refTx = await this.transactions.findByExternalRef('OFX_BANK', line.fitid);
    if (refTx) {
      await this.lines.setMatch(lineId, 'MATCHED_AUTO', refTx.id);
      return refTx.id;
    }

    const amount = line.amount_cents;
    return this.db.transactionAsync(async () => {
      const txId = genId();
      await this.transactions.insert({
        id: txId,
        kind: 'SIMPLE',
        type: amount > 0 ? 'INCOME' : 'EXPENSE',
        amount_cents: Math.abs(amount),
        occurred_on: line.posted_on!,
        occurred_at: nowIso(),
        description: line.memo || `OFX ${line.fitid}`,
        category_id: null,
        account_id: accountId,
        transfer_account_id: null,
        card_id: null,
        source_system: 'OFX_BANK',
        external_ref_id: line.fitid,
        recurrence_rule_id: null,
        status: 'CONFIRMED',
      });
      await this.moves.insert({
        id: genId(),
        transaction_id: txId,
        installment_id: null,
        invoice_payment_id: null,
        account_id: accountId,
        direction: amount > 0 ? 'CREDIT' : 'DEBIT',
        amount_cents: Math.abs(amount),
        effective_date: line.posted_on!,
        status: 'CONFIRMED',
      });
      await this.lines.setMatch(lineId, 'NEW_TX', txId);
      return txId;
    });
  }

  /** Candidatos recomputados para uma linha (tela de revisão de ambíguas). */
  async getLineCandidates(lineId: string): Promise<Array<{ id: string; description: string; occurred_on: string; amount_cents: number; category_name: string | null }>> {
    const line = await this.lines.getById(lineId);
    if (!line || line.amount_cents == null || !line.posted_on) return [];
    const importRow = await this.imports.getById(line.import_id);
    if (!importRow) return [];
    return this.db.getAllAsync(
      `SELECT t.*, c.name AS category_name
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.account_id = ?
          AND t.amount_cents = ?
          AND t.status = 'CONFIRMED'
          AND julianday(t.occurred_on) BETWEEN julianday(?) AND julianday(?)
        ORDER BY t.occurred_on`,
      [importRow.account_id, Math.abs(line.amount_cents), addDays(line.posted_on, -10), addDays(line.posted_on, 10)]
    );
  }

  /**
   * v42 — SUGESTÃO DE NFC-e (pedido do usuário): quando o casamento automático
   * não achou a NFC-e já lançada, a revisão do OFX mostra as notas recentes com
   * MESMO VALOR (±5 dias) para vincular com 1 toque — evita duplicidade.
   * A busca ignora a CONTA da nota (o erro comum é lançar a NF na conta errada,
   * ex.: Dinheiro, e pagar no débito da conta do extrato) e descarta notas
   * já vinculadas a outra linha OFX.
   */
  async findNfceSuggestions(lineId: string): Promise<Array<{
    id: string;
    description: string;
    occurred_on: string;
    amount_cents: number;
    account_id: string | null;
    account_name: string | null;
    store_name: string | null;
  }>> {
    const line = await this.lines.getById(lineId);
    if (!line || line.amount_cents == null || !line.posted_on) return [];
    return this.db.getAllAsync(
      `SELECT t.id, t.description, t.occurred_on, t.amount_cents, t.account_id,
              a.name AS account_name, d.store_name
         FROM transactions t
         LEFT JOIN accounts a ON a.id = t.account_id
         LEFT JOIN nfce_documents d ON d.access_key = t.external_ref_id
        WHERE t.source_system = 'NFCE'
          AND t.status = 'CONFIRMED' AND t.type = 'EXPENSE'
          AND t.amount_cents = ?
          AND julianday(t.occurred_on) BETWEEN julianday(?) AND julianday(?)
          AND NOT EXISTS (
            SELECT 1 FROM ofx_statement_lines o
             WHERE o.matched_transaction_id = t.id AND o.id != ?
          )
        ORDER BY ABS(julianday(t.occurred_on) - julianday(?))
        LIMIT 3`,
      [Math.abs(line.amount_cents), addDays(line.posted_on, -5), addDays(line.posted_on, 5), lineId, line.posted_on] as never
    );
  }

  /**
   * v42 — vincula a linha do OFX à NFC-e sugerida (1 toque). Se a nota foi
   * lançada em OUTRA conta, o lançamento MOVE para a conta do extrato (foi lá
   * que o dinheiro saiu de verdade) — transação + movimento financeiro.
   */
  async linkNfceSuggestion(lineId: string, transactionId: string): Promise<{ movedAccount: boolean }> {
    const line = await this.lines.getById(lineId);
    if (!line) throw new Error('Linha não encontrada');
    const tx = await this.transactions.getById(transactionId);
    if (!tx) throw new Error('Transação não encontrada');
    const importRow = await this.imports.getById(line.import_id);
    if (!importRow) throw new Error('Importação não encontrada');

    await this.db.transactionAsync(async () => {
      let movedAccount = false;
      if (tx.account_id && tx.account_id !== importRow.account_id) {
        await this.db.runAsync('UPDATE transactions SET account_id = ? WHERE id = ?', [
          importRow.account_id,
          transactionId,
        ]);
        await this.db.runAsync('UPDATE financial_moves SET account_id = ? WHERE transaction_id = ?', [
          importRow.account_id,
          transactionId,
        ]);
        movedAccount = true;
      }
      await this.lines.setMatch(lineId, 'MATCHED_AUTO', transactionId);
      return movedAccount;
    });
    return { movedAccount: tx.account_id != null && tx.account_id !== importRow.account_id };
  }

  async getImportDetail(importId: string) {
    const imp = await this.imports.getById(importId);
    if (!imp) return null;
    const lines = await this.lines.getByImport(importId);
    return { import: imp, lines };
  }

  async listImports() {
    return this.imports.getAll();
  }

  /** Proximidade de datas normalizada (0 = mesmo dia, decai 0.25/dia). */
  private dateProximityScore(ofxDate: string, txDate: string): number {
    const a = normalizeText(ofxDate);
    const b = normalizeText(txDate);
    if (a === b) return 0.5;
    const da = Date.parse(`${a}T12:00:00Z`);
    const db = Date.parse(`${b}T12:00:00Z`);
    if (Number.isNaN(da) || Number.isNaN(db)) return 0;
    const days = Math.abs(da - db) / 86_400_000;
    return Math.max(0, 0.5 - days * 0.25);
  }
}
