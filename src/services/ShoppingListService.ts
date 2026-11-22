/**
 * ShoppingListService (v104) — LISTA DE COMPRA COM VÁRIAS LISTAS SALVAS.
 *
 * O carrinho único do v72 (despensa_lista_compra em app_settings) virou
 * `shopping_lists` + `shopping_list_items`. Cada lista tem nome, datas e
 * itens com quantidade na UNIDADE BASE (g, ml, un). A persistência é
 * definitiva — o usuário perde a lista SÓ se apagar o banco (Ajustes › Dados).
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { nowIso } from '../lib/dates';

export type ShoppingListStatus = 'OPEN' | 'CLOSED';

export interface ShoppingListRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  status: ShoppingListStatus;
}

export interface ShoppingListItemRow {
  id: string;
  list_id: string;
  product_id: string;
  /** Quantidade na UNIDADE BASE do produto (g, ml, un). */
  qty_base: number;
}

export interface ShoppingListItemWithProduct extends ShoppingListItemRow {
  name: string;
  base_unit: 'G' | 'ML' | 'UN' | null;
  category_id: string | null;
  category_name: string | null;
  parent_name: string | null;
}

export interface ShoppingListSummary extends ShoppingListRow {
  itemCount: number;
  /** Total estimado em CENTAVOS (soma de qty × melhor preço entre lojas). */
  estimatedTotalCents: number;
}

export class ShoppingListService {
  constructor(private db: DbDriver) {}

  // ---------------- CRUD ----------------

  async create(name: string, items: Array<{ productId: string; qtyBase: number }>): Promise<string> {
    const trimmed = name.trim() || 'Lista de Compra';
    const id = genId();
    const now = nowIso();
    await this.db.transactionAsync(async () => {
      await this.db.runAsync(
        `INSERT INTO shopping_lists (id, name, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, 'OPEN')`,
        [id, trimmed, now, now]
      );
      for (const item of items) {
        if (!item.productId || !Number.isInteger(item.qtyBase) || item.qtyBase <= 0) continue;
        await this.db.runAsync(
          `INSERT OR REPLACE INTO shopping_list_items (id, list_id, product_id, qty_base)
           VALUES (?, ?, ?, ?)`,
          [genId(), id, item.productId, item.qtyBase]
        );
      }
    });
    return id;
  }

  async rename(listId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Informe o nome da lista');
    await this.db.runAsync(
      'UPDATE shopping_lists SET name = ?, updated_at = ? WHERE id = ?',
      [trimmed, nowIso(), listId]
    );
  }

  async delete(listId: string): Promise<void> {
    await this.db.transactionAsync(async () => {
      await this.db.runAsync('DELETE FROM shopping_list_items WHERE list_id = ?', [listId]);
      await this.db.runAsync('DELETE FROM shopping_lists WHERE id = ?', [listId]);
    });
  }

  // ---------------- LISTAGEM ----------------

  /**
   * v104 — listas salvas com nº de itens e total estimado (soma do melhor
   * preço entre lojas × quantidade da lista). Itens SEM PREÇO em nenhuma NF
   * contam como 0 — a lista aparece normalmente.
   */
  async listSummaries(): Promise<ShoppingListSummary[]> {
    const lists = await this.db.getAllAsync<ShoppingListRow>(
      'SELECT id, name, created_at, updated_at, status FROM shopping_lists ORDER BY updated_at DESC'
    );
    if (lists.length === 0) return [];
    const items = await this.db.getAllAsync<ShoppingListItemRow>(
      'SELECT id, list_id, product_id, qty_base FROM shopping_list_items'
    );
    const priceRows = await this.db.getAllAsync<{
      product_id: string;
      qty: number | null;
      unit_original: string | null;
      total_cents: number | null;
      unit_price_cents: number | null;
      base_unit: 'G' | 'ML' | 'UN' | null;
    }>(
      `SELECT ni.product_id, ni.qty, ni.unit_original, ni.total_cents, ni.unit_price_cents, pc.base_unit
         FROM nfce_items ni
         JOIN products_catalog pc ON pc.id = ni.product_id
         JOIN nfce_documents d ON d.access_key = ni.access_key
        WHERE ni.status = 'PARSED' AND ni.qty > 0 AND ni.total_cents > 0
          AND d.issued_at IS NOT NULL
        ORDER BY ni.product_id, d.issued_at DESC, ni.line_number ASC`
    );
    // Para cada produto, mapa de CNPJ/loja → preço em REAL (R$/g · R$/ml · R$/un = cent/base).
    // 'Melhor' = menor preço entre lojas.
    const bestByProduct = computeBestPerProduct(priceRows);
    const byList = new Map<string, ShoppingListItemRow[]>();
    for (const it of items) {
      const arr = byList.get(it.list_id) ?? [];
      arr.push(it);
      byList.set(it.list_id, arr);
    }
    return lists.map((l) => {
      const arr = byList.get(l.id) ?? [];
      let totalCents = 0;
      for (const it of arr) {
        const best = bestByProduct.get(it.product_id);
        if (best == null) continue;
        totalCents += it.qty_base * best.unitPriceBaseCents;
      }
      return { ...l, itemCount: arr.length, estimatedTotalCents: roundedCents(totalCents) };
    });
  }

  async getList(listId: string): Promise<ShoppingListRow | null> {
    return this.db.getFirstAsync<ShoppingListRow>(
      'SELECT id, name, created_at, updated_at, status FROM shopping_lists WHERE id = ?',
      [listId]
    );
  }

  async getItems(listId: string): Promise<ShoppingListItemWithProduct[]> {
    return this.db.getAllAsync<ShoppingListItemWithProduct>(
      `SELECT sli.id, sli.list_id, sli.product_id, sli.qty_base,
              pc.name AS name, pc.base_unit AS base_unit, pc.category_id AS category_id,
              c.name AS category_name, p.name AS parent_name
         FROM shopping_list_items sli
         JOIN products_catalog pc ON pc.id = sli.product_id
         LEFT JOIN categories c ON c.id = pc.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
        WHERE sli.list_id = ?
        ORDER BY pc.name`,
      [listId]
    );
  }

  // ---------------- EDIÇÃO DE ITENS ----------------

  async setItemQty(listId: string, productId: string, qtyBase: number): Promise<void> {
    const qty = Math.max(1, Math.round(qtyBase));
    const existing = await this.db.getFirstAsync<{ id: string }>(
      'SELECT id FROM shopping_list_items WHERE list_id = ? AND product_id = ?',
      [listId, productId]
    );
    if (existing) {
      await this.db.runAsync(
        'UPDATE shopping_list_items SET qty_base = ? WHERE id = ?',
        [qty, existing.id]
      );
    } else {
      await this.db.runAsync(
        `INSERT INTO shopping_list_items (id, list_id, product_id, qty_base)
         VALUES (?, ?, ?, ?)`,
        [genId(), listId, productId, qty]
      );
    }
    await this.touch(listId);
  }

  async removeItem(listId: string, productId: string): Promise<void> {
    await this.db.runAsync(
      'DELETE FROM shopping_list_items WHERE list_id = ? AND product_id = ?',
      [listId, productId]
    );
    await this.touch(listId);
  }

  async touch(listId: string): Promise<void> {
    await this.db.runAsync('UPDATE shopping_lists SET updated_at = ? WHERE id = ?', [nowIso(), listId]);
  }
}

/**
 * v104 — MELHOR PREÇO POR PRODUTO.
 * Reaproveita o reader das NFs já existente: filtra por UNIDADE compatível com
 * o base_unit do produto (KG nunca mistura com UN — guarda de dimensão).
 * Preço por kg (NfceItemRow.unit_price_cents) tem prioridade sobre total/qty
 * quando está preenchido — alinha com a regra do cálculo da lista.
 * 'Melhor entre lojas' = o MENOR preço unitário (base).
 */
function computeBestPerProduct(
  rows: Array<{
    product_id: string;
    qty: number | null;
    unit_original: string | null;
    total_cents: number | null;
    unit_price_cents: number | null;
    base_unit: 'G' | 'ML' | 'UN' | null;
  }>
): Map<string, { unitPriceBaseCents: number; dim: 'G' | 'ML' | 'UN' }> {
  // Calcula preços na UNIDADE BASE (R$/g, R$/ml, R$/un) POR produto.
  // Para KG/ML: se nfce_items.unit_price_cents veio preenchido (em R$/kg ou R$/L),
  // converte dividindo por 1000; senão usa total_cents ÷ (qty × fator p/ base).
  const factorMap: Record<string, { factor: number; base: 'G' | 'ML' | 'UN' }> = {
    G: { factor: 1, base: 'G' },
    GR: { factor: 1, base: 'G' },
    GRAMAS: { factor: 1, base: 'G' },
    KG: { factor: 1000, base: 'G' },
    KGS: { factor: 1000, base: 'G' },
    QUILO: { factor: 1000, base: 'G' },
    QUILOS: { factor: 1000, base: 'G' },
    ML: { factor: 1, base: 'ML' },
    MILILITRO: { factor: 1, base: 'ML' },
    MILILITROS: { factor: 1, base: 'ML' },
    L: { factor: 1000, base: 'ML' },
    LT: { factor: 1000, base: 'ML' },
    LITRO: { factor: 1000, base: 'ML' },
    LITROS: { factor: 1000, base: 'ML' },
    UN: { factor: 1, base: 'UN' },
    UND: { factor: 1, base: 'UN' },
    UNIDADE: { factor: 1, base: 'UN' },
    UNIDADES: { factor: 1, base: 'UN' },
    CX: { factor: 1, base: 'UN' },
    PC: { factor: 1, base: 'UN' },
  };
  const calcBase = (
    qty: number | null,
    unitOrig: string | null,
    totalCents: number | null,
    unitPriceCents: number | null,
    baseUnit: 'G' | 'ML' | 'UN' | null
  ): { deltaBase: number; base: 'G' | 'ML' | 'UN' | null; unitPriceBaseCents: number | null } => {
    if (qty == null || totalCents == null || totalCents <= 0 || qty <= 0) return { deltaBase: 0, base: null, unitPriceBaseCents: null };
    const unit = (unitOrig || 'UN').trim().toUpperCase();
    const entry = factorMap[unit];
    if (!entry) return { deltaBase: 0, base: null, unitPriceBaseCents: null };
    const delta = Math.round(qty * entry.factor);
    if (baseUnit && entry.base !== baseUnit) return { deltaBase: 0, base: null, unitPriceBaseCents: null };
    // v104: nfce_items.unit_price_cents é em REAL/UNIDADE-DA-NOTA (R$/kg ou R$/L
    // ou R$/un). Para KG/ML → divide por 1000 para cair em R$/g ou R$/ml
    // (preço por BASE). Para UN → já é preço direto por unidade.
    if (unitPriceCents != null && unitPriceCents > 0) {
      const perBase = entry.base === 'UN' ? unitPriceCents : unitPriceCents / 1000;
      return { deltaBase: delta, base: entry.base, unitPriceBaseCents: perBase };
    }
    // Fallback: total / deltaBase (regra antiga).
    const perBase = totalCents / delta;
    return { deltaBase: delta, base: entry.base, unitPriceBaseCents: perBase };
  };

  const out = new Map<string, { unitPriceBaseCents: number; dim: 'G' | 'ML' | 'UN' }>();
  for (const r of rows) {
    const { base, unitPriceBaseCents } = calcBase(r.qty, r.unit_original, r.total_cents, r.unit_price_cents, r.base_unit);
    if (base == null || unitPriceBaseCents == null) continue;
    const cur = out.get(r.product_id);
    if (!cur || unitPriceBaseCents < cur.unitPriceBaseCents) {
      out.set(r.product_id, { unitPriceBaseCents, dim: base });
    }
  }
  // 'Melhor entre lojas' = o MENOR preço unitário (base) observado na história
  // toda — um valor mais alto nunca vence. A regra já existia no v72, então a
  // lista nova mantém (não recalculamos a cada NF para não criar inconsistência).
  return out;
}

function roundedCents(c: number): number {
  return Math.round(c * 100) / 100;
}

/** Conveniência: rótulo de unidade (não expor 'ML' na entrada do app; só em
 *  produtos legados já cadastrados). */
export function unitLabel(u: 'G' | 'ML' | 'UN' | null | undefined): string {
  if (u === 'G') return 'kg';
  if (u === 'ML') return 'ml';
  return 'un';
}

/** Rótulo curto para o botão ＋ da Despensa. */
export const DEFAULT_LIST_NAME_HINT = 'Lista de Compra';
