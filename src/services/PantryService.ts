/**
 * PantryService — despensa com CACHE ATÔMICO (spec v7):
 * pantry_ledger é append-only (fonte da verdade); pantry_stock é cache
 * atualizado NA MESMA TRANSAÇÃO do ledger (nunca diverge).
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { nowIso } from '../lib/dates';
import { convertToBaseUnit } from '../parsers/nfce';
import { PantryStockRepo, PantryLedgerRepo } from '../repos/misc';
import type { PantryLedgerRow } from '../repos/misc';

export type MovementReason = PantryLedgerRow['reason_code'];

export class PantryService {
  private stock: PantryStockRepo;
  private ledger: PantryLedgerRepo;

  constructor(private db: DbDriver) {
    this.stock = new PantryStockRepo(db);
    this.ledger = new PantryLedgerRepo(db);
  }

  /**
   * Movimento manual (CONSUMPTION/WASTE/CORRECTION/PURCHASE_MANUAL).
   * Atômico: valida estoque >= 0, grava ledger e atualiza cache juntos.
   */
  async registerManualMovement(input: {
    productId: string;
    deltaBase: number;
    reason: Exclude<MovementReason, 'PURCHASE_NFCE'>;
  }): Promise<void> {
    if (!Number.isInteger(input.deltaBase) || input.deltaBase === 0) {
      throw new Error('Delta deve ser inteiro diferente de zero');
    }
    await this.db.transactionAsync(async () => {
      const current = await this.stock.getByProduct(input.productId);
      const newQty = (current?.quantity_base ?? 0) + input.deltaBase;
      if (newQty < 0) {
        throw new Error('Movimento deixaria o estoque negativo — ajuste com CORRECTION');
      }
      await this.ledger.insert({
        id: genId(),
        product_id: input.productId,
        delta_base: input.deltaBase,
        reason_code: input.reason,
        nfce_item_id: null,
        transaction_id: null,
        created_at: nowIso(),
      });
      await this.stock.upsert(input.productId, newQty, current?.low_threshold_base ?? null, nowIso());
    });
  }

  /** Aplica itens de NFC-e ao estoque (lista específica ou todos os elegíveis). Idempotente. */
  async applyNfceItems(accessKey: string, itemIds?: string[]): Promise<number> {
    return this.db.transactionAsync(async () => {
      // v37: JOIN com a unidade-base do produto — GUARDA DE DIMENSÃO: item em
      // KG só entra em produto cuja base é G (nunca mistura g com UN/ML).
      const eligible = await this.db.getAllAsync<{
        id: string; product_id: string; qty: number | null; unit_original: string | null; base_unit: 'G' | 'ML' | 'UN' | null;
      }>(
        `SELECT ni.id, ni.product_id, ni.qty, ni.unit_original, pc.base_unit
           FROM nfce_items ni
           JOIN products_catalog pc ON pc.id = ni.product_id
          WHERE ni.access_key = ? AND ni.status = 'PARSED' AND ni.stock_applied = 0 AND ni.product_id IS NOT NULL`,
        [accessKey]
      );
      const toApply = itemIds ? eligible.filter((i) => itemIds.includes(i.id)) : eligible;
      let applied = 0;
      for (const item of toApply) {
        const conv = convertToBaseUnit(item.qty ?? 0, item.unit_original);
        if (item.qty == null || !conv) continue;
        // v37: dimensão do item ≠ unidade-base do produto → NÃO aplica
        // (contabilização por unidade fica no histórico da nota, sem poluir estoque)
        if (item.base_unit && conv.baseUnit !== item.base_unit) continue;
        const delta = conv.deltaBase;
        const already = await this.ledger.existsByNfceItem(item.id);
        if (already) continue;

        const current = await this.stock.getByProduct(item.product_id);
        const newQty = (current?.quantity_base ?? 0) + delta;
        await this.ledger.insert({
          id: genId(),
          product_id: item.product_id,
          delta_base: delta,
          reason_code: 'PURCHASE_NFCE',
          nfce_item_id: item.id,
          transaction_id: null,
          created_at: nowIso(),
        });
        await this.stock.upsert(item.product_id, newQty, current?.low_threshold_base ?? null, nowIso());
        await this.db.runAsync('UPDATE nfce_items SET stock_applied = 1 WHERE id = ?', [item.id]);
        applied++;
      }
      return applied;
    });
  }

  /** Aplica um único item (confirmação de fuzzy/review). Idempotente. */
  async applySingleNfceItem(_accessKey: string, itemId: string, productId: string, deltaBase: number): Promise<void> {
    await this.db.transactionAsync(async () => {
      const already = await this.ledger.existsByNfceItem(itemId);
      if (already) return;
      const current = await this.stock.getByProduct(productId);
      const newQty = (current?.quantity_base ?? 0) + deltaBase;
      await this.ledger.insert({
        id: genId(),
        product_id: productId,
        delta_base: deltaBase,
        reason_code: 'PURCHASE_NFCE',
        nfce_item_id: itemId,
        transaction_id: null,
        created_at: nowIso(),
      });
      await this.stock.upsert(productId, newQty, current?.low_threshold_base ?? null, nowIso());
      await this.db.runAsync('UPDATE nfce_items SET stock_applied = 1 WHERE id = ?', [itemId]);
    });
  }

  /** Reparo do cache a partir do ledger (útil após migrations/restores). */
  async recomputeProduct(productId: string): Promise<number> {
    return this.stock.recomputeFromLedger(productId, nowIso());
  }

  async setLowThreshold(productId: string, thresholdBase: number | null): Promise<void> {
    const current = await this.stock.getByProduct(productId);
    await this.stock.upsert(productId, current?.quantity_base ?? 0, thresholdBase, nowIso());
  }

  /** Lista da despensa com flag de estoque baixo. */
  async listPantry() {
    const rows = await this.stock.listWithProduct();
    return rows.map((row) => ({
      ...row,
      isLow: row.low_threshold_base != null && row.quantity_base <= (row.low_threshold_base ?? 0),
    }));
  }

  /** Histórico do produto. */
  async history(productId: string) {
    return this.ledger.listByProduct(productId);
  }
}
