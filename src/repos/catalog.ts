/** Repositórios de categories, products_catalog e product_aliases. */

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
  unit_measure?: 'UN' | 'KG' | 'G';
  origin: 'USER' | 'NFCE';
  pantry_policy?: 'ALWAYS' | 'ASK' | 'NEVER' | null;
}

/**
 * v37 — TABELA DA VERDADE: alias é a LINHA da tabela que liga um código de
 * loja (por CNPJ!) a um produto canônico. CNPJ > store_name porque o nome
 * da loja varia ("SENDAS DISTRIBUIDORA", "Assaí", "ASSAI ATACADISTA") e o
 * CNPJ fiscal NÃO — é a identidade estável do estabelecimento na nota.
 */
export interface ProductAliasRow {
  id: string;
  product_id: string;
  alias_text: string | null;
  store_name: string | null;
  store_product_code: string | null;
  /** v37: CNPJ do estabelecimento dono do código (chave da tabela da verdade). */
  cnpj?: string | null;
  /** v37: telemetria de acerto — quantas notas já resolveu e quando foi a última. */
  match_count?: number;
  last_matched_at?: string | null;
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
    // Passo 1 da hierarquia v7 — usa índice UNIQUE(ean)
    return this.db.getFirstAsync<ProductRow>('SELECT * FROM products_catalog WHERE ean = ? LIMIT 1', [ean]);
  }

  getAll(limit = 500): Promise<ProductRow[]> {
    return this.db.getAllAsync<ProductRow>('SELECT * FROM products_catalog ORDER BY name LIMIT ?', [limit]);
  }

  insert(row: ProductRow): Promise<unknown> {
    return this.db.runAsync(
      'INSERT INTO products_catalog (id, ean, name, brand, category_id, base_unit, unit_measure, origin, pantry_policy) VALUES (?,?,?,?,?,?,?,?,?)',
      [row.id, row.ean, row.name, row.brand, row.category_id, row.base_unit, row.unit_measure ?? 'UN', row.origin, row.pantry_policy ?? 'ASK']
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
    if (patch.unit_measure !== undefined) { sets.push('unit_measure = ?'); params.push(patch.unit_measure); }
    if ((patch as any).pantry_policy !== undefined) { sets.push('pantry_policy = ?'); params.push((patch as any).pantry_policy); }
    if (!sets.length) return Promise.resolve({ changes: 0 });
    params.push(id);
    return this.db.runAsync(`UPDATE products_catalog SET ${sets.join(', ')} WHERE id = ?`, params as never);
  }
}

export class ProductAliasRepo {
  constructor(private db: DbDriver) {}

  /** Passo 2 da hierarquia v7 — match exato por código interno da loja. */
  findByStoreCode(storeName: string, storeProductCode: string): Promise<{ id: string; product_id: string } | null> {
    return this.db.getFirstAsync(
      `SELECT pa.id, pa.product_id
         FROM product_aliases pa
         JOIN products_catalog pc ON pa.product_id = pc.id
        WHERE pa.store_name = ? AND pa.store_product_code = ?
        LIMIT 1`,
      [storeName, storeProductCode]
    );
  }

  /**
   * v37 — Passo 2 da TABELA DA VERDADE: match exato por (CNPJ, código).
   * É o caminho Ouro do aprendizado: a mesma gôndola, nota após nota.
   * O CNPJ é normalizado para DÍGITOS por dentro — a chave da verdade é
   * canônica, venha o chamador com "06.057.223/0508-61" ou "06057223050861".
   */
  findByCnpjCode(cnpj: string, storeProductCode: string): Promise<{ id: string; product_id: string } | null> {
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

  /** v37: soma um acerto no alias (telemetria da tabela da verdade). */
  async noteAliasHit(aliasId: string): Promise<void> {
    await this.db.runAsync(
      'UPDATE product_aliases SET match_count = COALESCE(match_count, 0) + 1, last_matched_at = ? WHERE id = ?',
      [new Date().toISOString(), aliasId]
    );
  }

  /** Base para fuzzy por nome (alias_text indexado em memória pelo service). */
  getAllWithProduct(): Promise<(ProductAliasRow & { product_name: string })[]> {
    return this.db.getAllAsync(
      `SELECT pa.*, pc.name AS product_name
         FROM product_aliases pa
         JOIN products_catalog pc ON pa.product_id = pc.id`
    );
  }

  insert(row: ProductAliasRow): Promise<unknown> {
    return this.db.runAsync(
      `INSERT INTO product_aliases
        (id, product_id, alias_text, store_name, store_product_code, cnpj, match_count, last_matched_at)
       VALUES (?,?,?,?,?,?,COALESCE(?, 0),?)`,
      [
        row.id, row.product_id, row.alias_text, row.store_name, row.store_product_code,
        row.cnpj ?? null, row.match_count ?? 0, row.last_matched_at ?? null,
      ]
    );
  }

  /** Adiciona alias se ainda não existir (ação do passo 2 da hierarquia). */
  async ensureStoreCodeAlias(product_id: string, storeName: string, storeProductCode: string): Promise<void> {
    const existing = await this.findByStoreCode(storeName, storeProductCode);
    if (existing) {
      // v37: a DECISÃO MANUAL vence — se o mesmo (loja, código) apontava para
      // outro produto, REAPONTA (a tabela da verdade é corrigível).
      if (existing.product_id !== product_id) {
        await this.db.runAsync('UPDATE product_aliases SET product_id = ? WHERE id = ?', [product_id, existing.id]);
      }
      return;
    }
    const { genId } = require('../lib/id') as typeof import('../lib/id');
    await this.insert({ id: genId(), product_id, alias_text: null, store_name: storeName, store_product_code: storeProductCode });
  }

  /**
   * v37 — aprendizado da TABELA DA VERDADE: garante o alias (CNPJ, código)
   * e o legado (store_name, código) apontando para o produto canônico.
   * Chamado no acerto automático E na decisão manual do usuário — é isso que
   * faz a PRÓXIMA nota da mesma loja resolver sem perguntar.
   */
  async ensureCnpjCodeAlias(product_id: string, cnpj: string | null | undefined, storeProductCode: string, storeName?: string | null): Promise<void> {
    const { genId } = require('../lib/id') as typeof import('../lib/id');
    // v37: guarda SEMPRE em DÍGITOS (chave canônica da verdade)
    const cnpjDigits = cnpj ? cnpj.replace(/\D/g, '') || null : null;
    if (cnpjDigits) {
      const existing = await this.findByCnpjCode(cnpjDigits, storeProductCode);
      if (!existing) {
        await this.insert({
          id: genId(), product_id, alias_text: null,
          store_name: storeName ?? null, store_product_code: storeProductCode, cnpj: cnpjDigits,
        });
      } else if (existing.product_id !== product_id) {
        // v37: decisão manual CORRIGE a tabela da verdade (reaponta o código).
        await this.db.runAsync('UPDATE product_aliases SET product_id = ? WHERE id = ?', [product_id, existing.id]);
      }
    }
    if (storeName) await this.ensureStoreCodeAlias(product_id, storeName, storeProductCode);
  }
}
