/** Repositórios de categories, products_catalog e product_aliases (v100). */

import type { DbDriver } from '../db/types';

export interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  color_hex: string | null;
}

export interface ProductRow {
  id: string;
  ean: string | null;
  name: string;
  brand: string | null;
  category_id: string | null;
  base_unit: 'G' | 'ML' | 'UN' | null;
  origin: 'USER' | 'NFCE';
  pantry_policy?: 'ALWAYS' | 'ASK' | 'NEVER' | null;
  /** v100: 1 = produto entra na Despensa e na Lista de Compra; 0 = só Catálogo. */
  stock_control?: number | null;
  /** v100: ATIVO | INATIVO. Inativo só vale para produto já cadastrado. */
  status?: 'ATIVO' | 'INATIVO' | null;
}

/**
 * v100 — TABELA DA VERDADE: alias é a LINHA que liga CNPJ+código a um
 * produto canônico. Só essa chave importa (UNIQUE(cnpj, store_product_code)
 * criada na migração v60). Loja fica como reserva para notas sem CNPJ.
 */
export interface ProductAliasRow {
  id: string;
  product_id: string;
  alias_text: string | null;
  store_name: string | null;
  store_product_code: string | null;
  cnpj: string | null;
  match_count: number;
  last_matched_at: string | null;
}

export class CategoryRepo {
  constructor(private db: DbDriver) {}
  getAll(): Promise<CategoryRow[]> {
    return this.db.getAllAsync<CategoryRow>('SELECT * FROM categories ORDER BY name');
  }
  getById(id: string): Promise<CategoryRow | null> {
    return this.db.getFirstAsync<CategoryRow>('SELECT * FROM categories WHERE id = ?', [id]);
  }
}

export class ProductRepo {
  constructor(private db: DbDriver) {}
  getById(id: string): Promise<ProductRow | null> {
    return this.db.getFirstAsync<ProductRow>('SELECT * FROM products_catalog WHERE id = ?', [id]);
  }
  getByEan(ean: string): Promise<ProductRow | null> {
    return this.db.getFirstAsync<ProductRow>('SELECT * FROM products_catalog WHERE ean = ? LIMIT 1', [ean]);
  }
  getAll(limit = 500): Promise<ProductRow[]> {
    return this.db.getAllAsync<ProductRow>(
      `SELECT * FROM products_catalog ORDER BY status ASC, name LIMIT ?`,
      [limit]
    );
  }
  insert(row: ProductRow): Promise<unknown> {
    return this.db.runAsync(
      `INSERT INTO products_catalog
         (id, ean, name, brand, category_id, base_unit, origin, pantry_policy, stock_control, status)
       VALUES (?,?,?,?,?,?,?,?,COALESCE(?,0),COALESCE(?,'ATIVO'))`,
      [
        row.id, row.ean, row.name, row.brand, row.category_id, row.base_unit,
        row.origin, row.pantry_policy ?? 'ASK',
        row.stock_control ?? null, row.status ?? null,
      ] as never
    );
  }
  update(id: string, patch: Partial<Omit<ProductRow, 'id'>>): Promise<unknown> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.ean !== undefined) { sets.push('ean = ?'); params.push(patch.ean); }
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
    if (patch.brand !== undefined) { sets.push('brand = ?'); params.push(patch.brand); }
    if (patch.category_id !== undefined) { sets.push('category_id = ?'); params.push(patch.category_id); }
    if (patch.base_unit !== undefined) { sets.push('base_unit = ?'); params.push(patch.base_unit); }
    if ((patch as any).pantry_policy !== undefined) { sets.push('pantry_policy = ?'); params.push((patch as any).pantry_policy); }
    if ((patch as any).stock_control !== undefined) { sets.push('stock_control = ?'); params.push(((patch as any).stock_control ? 1 : 0)); }
    if ((patch as any).status !== undefined) { sets.push('status = ?'); params.push((patch as any).status); }
    if (!sets.length) return Promise.resolve({ changes: 0 });
    params.push(id);
    return this.db.runAsync(`UPDATE products_catalog SET ${sets.join(', ')} WHERE id = ?`, params as never);
  }
}

export class ProductAliasRepo {
  constructor(private db: DbDriver) {}
  /** v37: legado — match por loja+código (só quando o doc NÃO tem CNPJ). */
  async ensureStoreCodeAlias(product_id: string, storeName: string, storeProductCode: string): Promise<void> {
    // v31: código vazio NÃO vira alias (ligaria todo item sem código da loja ao mesmo produto)
    if (!storeProductCode || !storeProductCode.trim()) return;
    const existing = await this.findByStoreCode(storeName, storeProductCode);
    if (existing) {
      if (existing.product_id !== product_id) {
        await this.db.runAsync('UPDATE product_aliases SET product_id = ? WHERE id = ?', [product_id, existing.id]);
      }
      return;
    }
    const { genId } = require('../lib/id') as typeof import('../lib/id');
    await this.insert({ id: genId(), product_id, alias_text: null, store_name: storeName, store_product_code: storeProductCode, cnpj: null });
  }
  /** v37: legado — match por loja+código (só quando o doc NÃO tem CNPJ). */
  findByStoreCode(storeName: string, storeProductCode: string): Promise<{ id: string; product_id: string } | null> {
    if (!storeProductCode || !storeProductCode.trim()) return Promise.resolve(null);
    return this.db.getFirstAsync(
      `SELECT pa.id, pa.product_id
         FROM product_aliases pa
         JOIN products_catalog pc ON pa.product_id = pc.id
        WHERE pa.store_name = ? AND pa.store_product_code = ?
        LIMIT 1`,
      [storeName, storeProductCode]
    );
  }
  /** v100 — CAMINHO OURO da TABELA DA VERDADE: CNPJ (digits) + código. */
  findByCnpjCode(cnpj: string, storeProductCode: string): Promise<{ id: string; product_id: string } | null> {
    if (!storeProductCode || !storeProductCode.trim()) return Promise.resolve(null);
    const digits = cnpj.replace(/\D/g, '');
    return this.db.getFirstAsync(
      `SELECT pa.id, pa.product_id
         FROM product_aliases pa
         JOIN products_catalog pc ON pa.product_id = pc.id
        WHERE REPLACE(REPLACE(REPLACE(REPLACE(pa.cnpj, '.', ''), '/', ''), '-', ''), ' ', '') = ?
          AND pa.store_product_code = ?
        LIMIT 1`,
      [digits, storeProductCode]
    );
  }
  async noteAliasHit(aliasId: string): Promise<void> {
    await this.db.runAsync(
      'UPDATE product_aliases SET match_count = COALESCE(match_count, 0) + 1, last_matched_at = ? WHERE id = ?',
      [new Date().toISOString(), aliasId]
    );
  }
  getAllWithProduct(): Promise<(ProductAliasRow & { product_name: string })[]> {
    return this.db.getAllAsync(
      `SELECT pa.*, pc.name AS product_name
         FROM product_aliases pa
         JOIN products_catalog pc ON pa.product_id = pc.id`
    );
  }
  insert(row: Omit<ProductAliasRow, 'match_count' | 'last_matched_at'> & Partial<Pick<ProductAliasRow, 'match_count' | 'last_matched_at'>>): Promise<unknown> {
    const r = row as ProductAliasRow;
    return this.db.runAsync(
      `INSERT INTO product_aliases
         (id, product_id, alias_text, store_name, store_product_code, cnpj, match_count, last_matched_at)
       VALUES (?,?,?,?,?,?,COALESCE(?, 0),?)`,
      [r.id, r.product_id, r.alias_text, r.store_name, r.store_product_code,
       r.cnpj ?? null, r.match_count ?? 0, r.last_matched_at ?? null]
    );
  }

  /**
   * v100 — TABELA DA VERDADE: garante o alias (CNPJ, código) apontando para o
   * produto canônico. NÃO cria mais do que 1 linha por (cnpj, código) — índice
   * único (idempotente após v60), reaponta se a decisão manual pedir.
   * Mesmo (loja, código) legado é mantido para notas SEM CNPJ.
   */
  async ensureCnpjCodeAlias(product_id: string, cnpj: string | null | undefined, storeProductCode: string, storeName?: string | null, aliasText?: string | null): Promise<void> {
    // v31: código vazio NÃO vira alias
    if (!storeProductCode || !storeProductCode.trim()) return;
    const { genId } = require('../lib/id') as typeof import('../lib/id');
    const cnpjDigits = cnpj ? cnpj.replace(/\D/g, '') || null : null;
    if (cnpjDigits) {
      const existing = await this.findByCnpjCode(cnpjDigits, storeProductCode);
      if (!existing) {
        await this.insert({
          id: genId(), product_id,
          alias_text: aliasText ?? null,
          store_name: storeName ?? null,
          store_product_code: storeProductCode,
          cnpj: cnpjDigits,
        });
      } else if (existing.product_id !== product_id) {
        // decisão manual CORRIGE a tabela da verdade
        await this.db.runAsync('UPDATE product_aliases SET product_id = ? WHERE id = ?', [product_id, existing.id]);
      }
    } else if (storeName) {
      // nota SEM cnpj → cai no legado
      const existing = await this.findByStoreCode(storeName, storeProductCode);
      if (!existing) {
        await this.insert({
          id: genId(), product_id,
          alias_text: aliasText ?? null,
          store_name: storeName, store_product_code: storeProductCode, cnpj: null,
        });
      } else if (existing.product_id !== product_id) {
        await this.db.runAsync('UPDATE product_aliases SET product_id = ? WHERE id = ?', [product_id, existing.id]);
      }
    }
  }

  /** Lista todos os códigos amarrados em um produto (para a tela do Catálogo). */
  async listForProduct(productId: string): Promise<ProductAliasRow[]> {
    return this.db.getAllAsync<ProductAliasRow>(
      `SELECT * FROM product_aliases WHERE product_id = ? ORDER BY match_count DESC, cnpj, store_name`,
      [productId]
    );
  }
}
