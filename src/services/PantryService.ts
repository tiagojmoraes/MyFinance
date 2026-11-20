/**
 * PantryService — despensa com CACHE ATÔMICO (spec v7):
 * pantry_ledger é append-only (fonte da verdade); pantry_stock é cache
 * atualizado NA MESMA TRANSAÇÃO do ledger (nunca diverge).
 *
 * v100 — Despensa mostra SÓ classificados + Com controle + Ativos.
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

  /** Movimento manual (CONSUMPTION/WASTE/CORRECTION/PURCHASE_MANUAL). */
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

  /** Aplica itens de NFC-e ao estoque (lista específica ou todos os elegíveis).
   *  v100: filtra também por products_catalog.stock_control = 1. */
  async applyNfceItems(accessKey: string, itemIds?: string[] | null): Promise<number> {
    return this.db.transactionAsync(async () => {
      const eligible = await this.db.getAllAsync<{
        id: string; product_id: string; qty: number | null; unit_original: string | null; base_unit: 'G' | 'ML' | 'UN' | null;
      }>(
        `SELECT ni.id, ni.product_id, ni.qty, ni.unit_original, pc.base_unit
           FROM nfce_items ni
           JOIN products_catalog pc ON pc.id = ni.product_id
          WHERE ni.access_key = ? AND ni.status = 'PARSED' AND ni.stock_applied = 0
            AND ni.product_id IS NOT NULL
            AND COALESCE(pc.stock_control, 0) = 1`,
        [accessKey]
      );
      const toApply = itemIds ? eligible.filter((i) => itemIds.includes(i.id)) : eligible;
      let applied = 0;
      for (const item of toApply) {
        const conv = convertToBaseUnit(item.qty ?? 0, item.unit_original);
        if (item.qty == null || !conv) continue;
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

  /** Aplica um único item (confirmação tardia do Catálogo). Idempotente. */
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

  /** Reparo do cache a partir do ledger. */
  async recomputeProduct(productId: string): Promise<number> {
    return this.stock.recomputeFromLedger(productId, nowIso());
  }

  async setLowThreshold(productId: string, thresholdBase: number | null): Promise<void> {
    const current = await this.stock.getByProduct(productId);
    await this.stock.upsert(productId, current?.quantity_base ?? 0, thresholdBase, nowIso());
  }

  /** Lista da despensa (cache + produto; v100: filtra Com controle + Ativo). */
  async listPantry() {
    const rows = await this.stock.listWithProduct();
    return rows.map((row) => ({
      ...row,
      quantity_base: row.quantity_base ?? 0,
      isLow: row.low_threshold_base != null && (row.quantity_base ?? 0) <= (row.low_threshold_base ?? 0),
    }));
  }

  // ------------------------------------------------------ lista de compra ----

  /** v100 — LISTA DE COMPRA: nasce de produtos controláveis, com oferta
   *  (última + média), atual e mínimo. Visões Por CNPJ / Por Categoria. */
  async getListaCompraData(productIds: string[]): Promise<ListaCompraProduct[]> {
    if (productIds.length === 0) return [];
    const marks = productIds.map(() => '?').join(',');
    const prods = await this.db.getAllAsync<{
      id: string; name: string; base_unit: 'G' | 'ML' | 'UN' | null; category_id: string | null;
      category_name: string | null; parent_name: string | null;
      quantity_base: number | null; low_threshold_base: number | null;
    }>(
      `SELECT pc.id, pc.name, pc.base_unit, pc.category_id,
              c.name AS category_name, p.name AS parent_name,
              ps.quantity_base AS quantity_base,
              ps.low_threshold_base AS low_threshold_base
         FROM products_catalog pc
         LEFT JOIN categories c ON c.id = pc.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
         LEFT JOIN pantry_stock ps ON ps.product_id = pc.id
        WHERE pc.id IN (${marks})`,
      [...productIds] as never
    );
    const byProduct = new Map<string, ListaCompraProduct>();
    for (const pid of productIds) {
      const cat = prods.find((p) => p.id === pid);
      byProduct.set(pid, {
        productId: pid,
        name: cat?.name ?? 'Produto',
        baseUnit: cat?.base_unit ?? null,
        categoryId: cat?.category_id ?? null,
        categoryName: cat?.category_name ?? null,
        parentCategoryName: cat?.parent_name ?? null,
        dim: null,
        offers: [],
        currentBase: cat?.quantity_base ?? 0,
        minBase: cat?.low_threshold_base ?? null,
        aggregate: null,
      });
    }

    const rows = await this.db.getAllAsync<{
      product_id: string; qty: number | null; unit_original: string | null; total_cents: number | null;
      store_name: string | null; issued_at: string | null; access_key: string;
      doc_cnpj: string | null;
    }>(
      `SELECT ni.product_id, ni.qty, ni.unit_original, ni.total_cents,
              d.store_name, d.issued_at, d.access_key, d.cnpj AS doc_cnpj
         FROM nfce_items ni
         JOIN nfce_documents d ON d.access_key = ni.access_key
        WHERE ni.product_id IN (${marks})
          AND ni.status = 'PARSED' AND ni.qty > 0 AND ni.total_cents > 0
          AND d.issued_at IS NOT NULL
        ORDER BY ni.product_id, d.issued_at DESC, ni.line_number ASC`,
      [...productIds] as never
    );

    const seenStore = new Map<string, Set<string>>();
    for (const r of rows) {
      const entry = byProduct.get(r.product_id);
      if (!entry) continue;
      const conv = convertToBaseUnit(r.qty ?? 0, r.unit_original);
      if (!conv || conv.deltaBase <= 0) continue;
      const dim = entry.baseUnit ?? entry.dim;
      if (dim && conv.baseUnit !== dim) continue;
      if (!entry.dim) entry.dim = conv.baseUnit;
      const loja = r.store_name ?? 'Loja não identificada';
      const storeKey = `${r.doc_cnpj ?? '_'}::${loja}`;
      const lojas = seenStore.get(r.product_id) ?? new Set<string>();
      if (lojas.has(storeKey)) continue;
      lojas.add(storeKey);
      seenStore.set(r.product_id, lojas);
      entry.offers.push({
        storeName: loja,
        cnpj: r.doc_cnpj,
        date: (r.issued_at ?? '').slice(0, 10),
        accessKey: r.access_key,
        unitPriceBaseCents: Math.round((r.total_cents ?? 0) / conv.deltaBase * 1000) / 1000,
        dim: conv.baseUnit,
      });
    }
    for (const entry of byProduct.values()) {
      if (entry.offers.length === 0) continue;
      const prices = entry.offers.map((o) => o.unitPriceBaseCents);
      const minB = Math.min(...prices);
      const maxB = Math.max(...prices);
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      const last = entry.offers.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      entry.aggregate = {
        last, averageBaseCents: avg, minBaseCents: minB, maxBaseCents: maxB,
        storeCount: new Set(entry.offers.map((o) => o.cnpj ?? o.storeName)).size,
      };
    }
    return productIds.map((pid) => byProduct.get(pid)!);
  }

  /** Histórico do produto. */
  async history(productId: string) {
    return this.ledger.listByProduct(productId);
  }
}

export interface ListaCompraOffer {
  storeName: string;
  cnpj: string | null;
  date: string;
  accessKey: string;
  unitPriceBaseCents: number;
  dim: 'G' | 'ML' | 'UN';
}

export interface OfferAggregate {
  last: ListaCompraOffer;
  averageBaseCents: number;
  minBaseCents: number;
  maxBaseCents: number;
  storeCount: number;
}

export interface ListaCompraProduct {
  productId: string;
  name: string;
  baseUnit: 'G' | 'ML' | 'UN' | null;
  categoryId: string | null;
  categoryName: string | null;
  parentCategoryName: string | null;
  dim: 'G' | 'ML' | 'UN' | null;
  currentBase: number;
  minBase: number | null;
  aggregate: OfferAggregate | null;
  offers: ListaCompraOffer[];
}
