/** Repositórios de recorrências, despensa (stock + ledger), NFC-e e OFX. */

import type { DbDriver, SqlValue } from '../db/types';

// ---------------- Recorrências ----------------

export interface RecurrenceRuleRow {
  id: string;
  description: string;
  type: 'INCOME' | 'EXPENSE';
  amount_cents: number;
  frequency: 'MONTHLY';
  day_of_month: number;
  start_date: string;
  end_date: string | null;
  account_id: string | null;
  card_id: string | null;
  is_active: number;
  /** v7.1: categoria escolhida no Lançamento > Fixo (migração v3). */
  category_id?: string | null;
  /** v11: grupo consolidado que originou a regra (linha Fixo do consolidado). */
  group_transaction_id?: string | null;
  /** v26: deslocamento (meses) do "mês da fatura" sobre a regra de corte (cartão). */
  invoice_month_offset?: number;
  /** v68 "Repetir": cadência — de quantos em quantos meses nasce a ocorrência
   *  (1=mensal, 2=bimestral, 3=trimestral, 6=semestral, 12=anual). */
  step_months?: number;
  /** v68 "Repetir": cadência em dias (7=semanal). NULL = usa step_months. */
  step_days?: number | null;
}

export class RecurrenceRepo {
  constructor(private db: DbDriver) {}

  getAll(): Promise<RecurrenceRuleRow[]> {
    return this.db.getAllAsync<RecurrenceRuleRow>('SELECT * FROM recurrence_rules ORDER BY description');
  }

  getActive(): Promise<RecurrenceRuleRow[]> {
    return this.db.getAllAsync<RecurrenceRuleRow>('SELECT * FROM recurrence_rules WHERE is_active = 1');
  }

  getById(id: string): Promise<RecurrenceRuleRow | null> {
    return this.db.getFirstAsync<RecurrenceRuleRow>('SELECT * FROM recurrence_rules WHERE id = ?', [id]);
  }

  insert(row: RecurrenceRuleRow): Promise<unknown> {
    return this.db.runAsync(
      `INSERT INTO recurrence_rules
        (id, description, type, amount_cents, frequency, day_of_month, start_date, end_date, account_id, card_id, is_active, category_id, group_transaction_id, invoice_month_offset, step_months, step_days)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.description, row.type, row.amount_cents, row.frequency, row.day_of_month,
        row.start_date, row.end_date, row.account_id, row.card_id, row.is_active,
        row.category_id ?? null, row.group_transaction_id ?? null, row.invoice_month_offset ?? 0,
        row.step_months ?? 1, row.step_days ?? null,
      ]
    );
  }

  setActive(id: string, active: boolean): Promise<unknown> {
    return this.db.runAsync('UPDATE recurrence_rules SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]);
  }

  /** Edita a regra — vale só para as competências geradas a partir de agora (v7.0.5). */
  updateRule(id: string, fields: { amount_cents?: number; day_of_month?: number; description?: string }): Promise<unknown> {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (fields.amount_cents != null) { sets.push('amount_cents = ?'); params.push(fields.amount_cents); }
    if (fields.day_of_month != null) { sets.push('day_of_month = ?'); params.push(fields.day_of_month); }
    if (fields.description != null) { sets.push('description = ?'); params.push(fields.description); }
    if (sets.length === 0) return Promise.resolve();
    params.push(id);
    return this.db.runAsync(`UPDATE recurrence_rules SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  /** Encerra a regra na data fim (exclusão "este e as próximas" — v7.0.6). */
  setEndDate(id: string, endDate: string | null): Promise<unknown> {
    return this.db.runAsync('UPDATE recurrence_rules SET end_date = ? WHERE id = ?', [endDate, id]);
  }
}

// ---------------- Despensa ----------------

export interface PantryStockRow {
  product_id: string;
  quantity_base: number;
  low_threshold_base: number | null;
  last_movement_at: string | null;
}

export interface PantryLedgerRow {
  id: string;
  product_id: string;
  delta_base: number;
  reason_code: 'PURCHASE_NFCE' | 'PURCHASE_MANUAL' | 'CONSUMPTION' | 'WASTE' | 'CORRECTION';
  nfce_item_id: string | null;
  transaction_id: string | null;
  created_at: string;
}

export class PantryStockRepo {
  constructor(private db: DbDriver) {}

  getByProduct(productId: string): Promise<PantryStockRow | null> {
    return this.db.getFirstAsync<PantryStockRow>('SELECT * FROM pantry_stock WHERE product_id = ?', [productId]);
  }

  /** Lista para a tela Despensa (cache + produto). */
  listWithProduct(): Promise<{
    product_id: string;
    name: string;
    ean: string | null;
    base_unit: 'G' | 'ML' | 'UN' | null;
    quantity_base: number;
    low_threshold_base: number | null;
    last_movement_at: string | null;
  }[]> {
    return this.db.getAllAsync(
      `SELECT ps.product_id, pc.name AS name, pc.ean AS ean, pc.base_unit AS base_unit,
              ps.quantity_base, ps.low_threshold_base, ps.last_movement_at
         FROM products_catalog pc
         JOIN pantry_stock ps ON ps.product_id = pc.id
        ORDER BY pc.name`
    );
  }

  upsert(productId: string, quantityBase: number, lowThreshold: number | null, nowIso: string): Promise<unknown> {
    return this.db.runAsync(
      `INSERT INTO pantry_stock (product_id, quantity_base, low_threshold_base, last_movement_at)
       VALUES (?,?,?,?)
       ON CONFLICT(product_id) DO UPDATE SET
         quantity_base = excluded.quantity_base,
         low_threshold_base = COALESCE(excluded.low_threshold_base, pantry_stock.low_threshold_base),
         last_movement_at = excluded.last_movement_at`,
      [productId, quantityBase, lowThreshold, nowIso]
    );
  }

  recomputeFromLedger(productId: string, nowIso: string): Promise<number> {
    return this.db.transactionAsync(async () => {
      const row = await this.db.getFirstAsync<{ total: number }>(
        'SELECT COALESCE(SUM(delta_base), 0) AS total FROM pantry_ledger WHERE product_id = ?',
        [productId]
      );
      const total = Math.max(0, row?.total ?? 0);
      await this.db.runAsync(
        `INSERT INTO pantry_stock (product_id, quantity_base, last_movement_at) VALUES (?,?,?)
         ON CONFLICT(product_id) DO UPDATE SET quantity_base = excluded.quantity_base`,
        [productId, total, nowIso]
      );
      return total;
    });
  }
}

export class PantryLedgerRepo {
  constructor(private db: DbDriver) {}

  insert(row: PantryLedgerRow): Promise<unknown> {
    return this.db.runAsync(
      `INSERT INTO pantry_ledger (id, product_id, delta_base, reason_code, nfce_item_id, transaction_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [row.id, row.product_id, row.delta_base, row.reason_code, row.nfce_item_id, row.transaction_id, row.created_at]
    );
  }

  /** Idempotência: um item de NFC-e vira no máximo um lançamento no ledger. */
  existsByNfceItem(nfceItemId: string): Promise<boolean> {
    return this.db
      .getFirstAsync<{ id: string }>('SELECT id FROM pantry_ledger WHERE nfce_item_id = ?', [nfceItemId])
      .then((r) => r != null);
  }

  listByProduct(productId: string, limit = 50): Promise<PantryLedgerRow[]> {
    return this.db.getAllAsync<PantryLedgerRow>(
      'SELECT * FROM pantry_ledger WHERE product_id = ? ORDER BY created_at DESC LIMIT ?',
      [productId, limit]
    );
  }
}

// ---------------- NFC-e ----------------

export interface NfceDocumentRow {
  access_key: string;
  store_name: string | null;
  /** v18: CNPJ do estabelecimento (exigência da extração do QR Code). */
  cnpj: string | null;
  issued_at: string | null;
  amount_paid_cents: number | null;
  gross_total_cents: number | null;
  discount_cents: number;
  parse_status: 'PENDING' | 'HEADER_ONLY' | 'PARTIAL' | 'COMPLETE' | 'FAILED';
  needs_review: number;
  transaction_id: string | null;
  /** v18: URL ORIGINAL do QR Code (reprocessamento usa o mesmo link). */
  source_url: string | null;
}

export interface NfceItemRow {
  id: string;
  access_key: string;
  line_number: number;
  description: string | null;
  ean_extracted: string | null;
  store_product_code: string | null;
  qty: number | null;
  unit_original: string | null;
  total_cents: number | null;
  product_id: string | null;
  status: 'PARSED' | 'ERROR' | 'IGNORED';
  stock_applied: number;
  /** v37 — LOG DA DECISÃO: como este item foi ligado ao produto da verdade. */
  match_type?: 'EAN' | 'ALIAS' | 'FUZZY' | 'MANUAL' | 'NEW' | null;
  /** v37: score do fuzzy (0..1) — 1.0 em EAN/ALIAS/MANUAL; null sem match. */
  match_score?: number | null;
}

export class NfceDocumentRepo {
  constructor(private db: DbDriver) {}

  getById(accessKey: string): Promise<NfceDocumentRow | null> {
    return this.db.getFirstAsync<NfceDocumentRow>('SELECT * FROM nfce_documents WHERE access_key = ?', [accessKey]);
  }

  getAll(): Promise<(NfceDocumentRow & { tx_description: string | null })[]> {
    return this.db.getAllAsync(
      `SELECT nd.*, t.description AS tx_description
         FROM nfce_documents nd
         LEFT JOIN transactions t ON t.id = nd.transaction_id
        ORDER BY nd.issued_at DESC`
    );
  }

  insert(row: NfceDocumentRow): Promise<unknown> {
    return this.db.runAsync(
      `INSERT INTO nfce_documents
        (access_key, store_name, cnpj, issued_at, amount_paid_cents, gross_total_cents, discount_cents, parse_status, needs_review, transaction_id, source_url)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.access_key, row.store_name, row.cnpj ?? null, row.issued_at, row.amount_paid_cents,
        row.gross_total_cents, row.discount_cents, row.parse_status, row.needs_review, row.transaction_id,
        row.source_url ?? null,
      ]
    );
  }

  updateHeader(accessKey: string, patch: Partial<Pick<NfceDocumentRow, 'store_name' | 'cnpj' | 'issued_at' | 'amount_paid_cents' | 'gross_total_cents' | 'discount_cents' | 'parse_status' | 'needs_review' | 'transaction_id' | 'source_url'>>): Promise<unknown> {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      sets.push(`${key} = ?`);
      params.push(value);
    }
    if (!sets.length) return Promise.resolve({ changes: 0 });
    params.push(accessKey);
    return this.db.runAsync(`UPDATE nfce_documents SET ${sets.join(', ')} WHERE access_key = ?`, params as never);
  }
}

export class NfceItemRepo {
  constructor(private db: DbDriver) {}

  getByDocument(accessKey: string): Promise<(NfceItemRow & { product_name: string | null; product_base_unit?: 'G' | 'ML' | 'UN' | null })[]> {
    return this.db.getAllAsync(
      `SELECT ni.*, pc.name AS product_name, pc.base_unit AS product_base_unit
         FROM nfce_items ni
         LEFT JOIN products_catalog pc ON pc.id = ni.product_id
        WHERE ni.access_key = ?
        ORDER BY ni.line_number`,
      [accessKey]
    );
  }

  getById(id: string): Promise<NfceItemRow | null> {
    return this.db.getFirstAsync<NfceItemRow>('SELECT * FROM nfce_items WHERE id = ?', [id]);
  }

  insert(row: NfceItemRow): Promise<unknown> {
    return this.db.runAsync(
      `INSERT INTO nfce_items
        (id, access_key, line_number, description, ean_extracted, store_product_code, qty, unit_original, total_cents, product_id, status, stock_applied, match_type, match_score)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.access_key, row.line_number, row.description, row.ean_extracted,
        row.store_product_code, row.qty, row.unit_original, row.total_cents,
        row.product_id, row.status, row.stock_applied,
        row.match_type ?? null, row.match_score ?? null,
      ]
    );
  }

  setProductId(id: string, productId: string | null): Promise<unknown> {
    return this.db.runAsync('UPDATE nfce_items SET product_id = ? WHERE id = ?', [productId, id]);
  }

  /** v37: registra COMO o item foi ligado (log da decisão — aprendizado). */
  setMatch(id: string, matchType: NonNullable<NfceItemRow['match_type']>, score: number | null): Promise<unknown> {
    return this.db.runAsync('UPDATE nfce_items SET match_type = ?, match_score = ? WHERE id = ?', [
      matchType, score, id,
    ]);
  }

  setStatus(id: string, status: NfceItemRow['status']): Promise<unknown> {
    return this.db.runAsync('UPDATE nfce_items SET status = ? WHERE id = ?', [status, id]);
  }

  markStockApplied(id: string): Promise<unknown> {
    return this.db.runAsync('UPDATE nfce_items SET stock_applied = 1 WHERE id = ?', [id]);
  }

  countByStatus(accessKey: string): Promise<{ parsed: number; error: number; ignored: number }> {
    return this.db
      .getFirstAsync<{ parsed: number; error: number; ignored: number }>(
        `SELECT
           SUM(CASE WHEN status = 'PARSED' THEN 1 ELSE 0 END) AS parsed,
           SUM(CASE WHEN status = 'ERROR' THEN 1 ELSE 0 END) AS error,
           SUM(CASE WHEN status = 'IGNORED' THEN 1 ELSE 0 END) AS ignored
          FROM nfce_items WHERE access_key = ?`,
        [accessKey]
      )
      .then((r) => ({ parsed: r?.parsed ?? 0, error: r?.error ?? 0, ignored: r?.ignored ?? 0 }));
  }
}

// ---------------- OFX ----------------

export interface OfxImportRow {
  id: string;
  content_hash_sha256: string;
  account_id: string;
  imported_at: string;
  lines_processed: number;
  errors_json: string | null;
}

export interface OfxStatementLineRow {
  id: string;
  import_id: string;
  fitid: string;
  posted_on: string | null;
  amount_cents: number | null;
  memo: string | null;
  matched_transaction_id: string | null;
  match_status: 'UNPROCESSED' | 'MATCHED_AUTO' | 'AMBIGUOUS' | 'NEW_TX';
}

export class OfxImportRepo {
  constructor(private db: DbDriver) {}

  getById(id: string): Promise<(OfxImportRow & { account_name: string | null }) | null> {
    return this.db.getFirstAsync(
      `SELECT oi.*, a.name AS account_name
         FROM ofx_imports oi LEFT JOIN accounts a ON a.id = oi.account_id
        WHERE oi.id = ?`,
      [id]
    );
  }

  findByHash(hash: string): Promise<OfxImportRow | null> {
    return this.db.getFirstAsync<OfxImportRow>(
      'SELECT * FROM ofx_imports WHERE content_hash_sha256 = ?',
      [hash]
    );
  }

  getAll(): Promise<(OfxImportRow & { account_name: string | null })[]> {
    return this.db.getAllAsync(
      `SELECT oi.*, a.name AS account_name
         FROM ofx_imports oi LEFT JOIN accounts a ON a.id = oi.account_id
        ORDER BY oi.imported_at DESC`
    );
  }

  insert(row: OfxImportRow): Promise<unknown> {
    return this.db.runAsync(
      'INSERT INTO ofx_imports (id, content_hash_sha256, account_id, imported_at, lines_processed, errors_json) VALUES (?,?,?,?,?,?)',
      [row.id, row.content_hash_sha256, row.account_id, row.imported_at, row.lines_processed, row.errors_json]
    );
  }
}

export class OfxLineRepo {
  constructor(private db: DbDriver) {}

  getByImport(importId: string): Promise<OfxStatementLineRow[]> {
    return this.db.getAllAsync<OfxStatementLineRow>(
      'SELECT * FROM ofx_statement_lines WHERE import_id = ? ORDER BY posted_on, fitid',
      [importId]
    );
  }

  getById(id: string): Promise<OfxStatementLineRow | null> {
    return this.db.getFirstAsync<OfxStatementLineRow>('SELECT * FROM ofx_statement_lines WHERE id = ?', [id]);
  }

  insert(row: OfxStatementLineRow): Promise<unknown> {
    return this.db.runAsync(
      `INSERT INTO ofx_statement_lines
        (id, import_id, fitid, posted_on, amount_cents, memo, matched_transaction_id, match_status)
       VALUES (?,?,?,?,?,?,?,?)`,
      [row.id, row.import_id, row.fitid, row.posted_on, row.amount_cents, row.memo, row.matched_transaction_id, row.match_status]
    );
  }

  setMatch(id: string, status: OfxStatementLineRow['match_status'], matchedTransactionId: string | null): Promise<unknown> {
    return this.db.runAsync(
      'UPDATE ofx_statement_lines SET match_status = ?, matched_transaction_id = ? WHERE id = ?',
      [status, matchedTransactionId, id]
    );
  }
}
