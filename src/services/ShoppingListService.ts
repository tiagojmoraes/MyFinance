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
import { PantryService } from './PantryService';

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
  private pantry: PantryService;

  constructor(private db: DbDriver, pantry?: PantryService) {
    // v29: o total estimado usa a MESMA regra do detalhe da lista
    // (PantryService.getListaCompraData): último preço de cada loja e,
    // entre as lojas, o menor.
    this.pantry = pantry ?? new PantryService(db);
  }

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
    // v29 — REGRA ÚNICA (igual ao detalhe da lista): para cada produto, o ÚLTIMO
    // preço de cada loja; o 'melhor' é o MENOR entre essas lojas.
    const productIds = [...new Set(items.map((it) => it.product_id))];
    const data = await this.pantry.getListaCompraData(productIds.map((productId) => ({ productId, qtyBase: 0 })));
    const bestByProduct = new Map<string, number>();
    for (const p of data) {
      if (p.offers.length === 0) continue;
      bestByProduct.set(p.productId, Math.min(...p.offers.map((o) => o.unitPriceBaseCents)));
    }
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
        totalCents += it.qty_base * best;
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
