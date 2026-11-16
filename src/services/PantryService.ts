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

  // ------------------------------------------------------ lista de compra ----

  /**
   * v72 — LISTA DE COMPRA (pedido do usuário): para cada produto da lista,
   * de ONDE comprar mais barato, com base no HISTÓRICO das notas lidas —
   * sem tabela nova: tudo nasce de nfce_items × nfce_documents.
   *
   * Regras (confirmadas pelo usuário):
   *  · preço unitário = valor do item ÷ quantidade (na nota);
   *  · POR LOJA, POR PRODUTO: vale a COMPRA MAIS RECENTE (issued_at da nota);
   *  · GUARDA DE DIMENSÃO (KG ≠ UN): só comparam entre si entradas da MESMA
   *    dimensão da unidade-base do produto (g↔kg e ml↔L são convertidos para
   *    a base; UN nunca mistura com peso/volume);
   *  · preço devolvido POR UNIDADE-BASE (centavos/g, centavos/ml, centavos/un)
   *    — a tela formata por kg/L/unidade.
   */
  async getListaCompraData(productIds: string[]): Promise<ListaCompraProduct[]> {
    if (productIds.length === 0) return [];
    const marks = productIds.map(() => '?').join(',');

    // cadastro de TODOS os produtos pedidos (mesmo os sem nota — seguem na lista)
    const prods = await this.db.getAllAsync<{
      id: string; name: string; base_unit: 'G' | 'ML' | 'UN' | null; category_id: string | null;
      category_name: string | null; parent_name: string | null;
    }>(
      `SELECT pc.id, pc.name, pc.base_unit, pc.category_id,
              c.name AS category_name, p.name AS parent_name
         FROM products_catalog pc
         LEFT JOIN categories c ON c.id = pc.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
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
      });
    }

    // compras (uma linha por item de nota) — mais recente primeiro
    const rows = await this.db.getAllAsync<{
      product_id: string; qty: number | null; unit_original: string | null; total_cents: number | null;
      store_name: string | null; issued_at: string | null; access_key: string;
    }>(
      `SELECT ni.product_id, ni.qty, ni.unit_original, ni.total_cents,
              d.store_name, d.issued_at, d.access_key
         FROM nfce_items ni
         JOIN nfce_documents d ON d.access_key = ni.access_key
        WHERE ni.product_id IN (${marks})
          AND ni.status = 'PARSED' AND ni.qty > 0 AND ni.total_cents > 0
          AND d.issued_at IS NOT NULL
        ORDER BY ni.product_id, d.issued_at DESC, ni.line_number ASC`,
      [...productIds] as never
    );

    // POR PRODUTO: primeira entrada VÁLIDA define a dimensão (base do produto
    // ou a da compra mais recente); por loja vale a compra mais recente válida.
    const seenStore = new Map<string, Set<string>>(); // productId -> lojas já tomadas
    for (const r of rows) {
      const entry = byProduct.get(r.product_id);
      if (!entry) continue;
      const conv = convertToBaseUnit(r.qty ?? 0, r.unit_original);
      if (!conv || conv.deltaBase <= 0) continue;
      // guarda de dimensão: a referência do produto é a base declarada ou,
      // sem base, a dimensão da compra mais recente válida
      const dim = entry.baseUnit ?? entry.dim;
      if (dim && conv.baseUnit !== dim) continue; // KG ≠ UN — nunca mistura
      if (!entry.dim) entry.dim = conv.baseUnit;
      const lojas = seenStore.get(r.product_id) ?? new Set<string>();
      const loja = r.store_name ?? 'Loja não identificada';
      if (lojas.has(loja)) continue; // já vale a mais recente desta loja
      lojas.add(loja);
      seenStore.set(r.product_id, lojas);
      entry.offers.push({
        storeName: loja,
        date: (r.issued_at ?? '').slice(0, 10),
        accessKey: r.access_key,
        unitPriceBaseCents: Math.round((r.total_cents ?? 0) / conv.deltaBase * 1000) / 1000,
        dim: conv.baseUnit,
      });
    }
    // produtos pedidos que nunca apareceram em nota seguem na lista, sem oferta
    return productIds.map((pid) => byProduct.get(pid)!);
  }

  /** Histórico do produto. */
  async history(productId: string) {
    return this.ledger.listByProduct(productId);
  }
}

export interface ListaCompraOffer {
  /** Loja da compra (store_name da nota; null vira "Loja não identificada"). */
  storeName: string;
  /** Data da compra (YYYY-MM-DD da emissão da nota) — a MAIS RECENTE da loja. */
  date: string;
  accessKey: string;
  /** Preço por unidade-base (ex.: centavos por grama). Multiplicado por 1000 = preço por kg/L. */
  unitPriceBaseCents: number;
  dim: 'G' | 'ML' | 'UN';
}

export interface ListaCompraProduct {
  productId: string;
  name: string;
  baseUnit: 'G' | 'ML' | 'UN' | null;
  categoryId: string | null;
  categoryName: string | null;
  parentCategoryName: string | null;
  /** Dimensão efetiva das comparações (base do produto ou da 1ª compra válida). */
  dim: 'G' | 'ML' | 'UN' | null;
  /** Uma oferta POR LOJA — sempre a compra mais recente de cada uma. */
  offers: ListaCompraOffer[];
}
