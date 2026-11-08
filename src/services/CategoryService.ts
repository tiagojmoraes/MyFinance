/**
 * CategoryService — cadastro de categorias/subcategorias (v7.1, migração v3).
 *  - direction: DEBIT (débito/despesa) | CREDIT (crédito/receita) | BOTH.
 *  - icon: pictograma (emoji) do mapa único — tela Cadastro > Categorias.
 *  - parent_id: subcategorias (1 nível).
 * v17 (melhoria 5) — regra de ciclo de vida:
 *  - COM movimentação vinculada (lançamento, produto, conta fixa ou
 *    subcategoria): a categoria só pode ser ARQUIVADA (setArchived) — sai das
 *    escolhas de novo lançamento; o histórico fica preservado. Arquivar uma
 *    pai ARQUIVA em cascata as subcategorias; desarquivar vale só para ela.
 *  - SEM nenhuma movimentação: pode ser EXCLUÍDA definitivamente (remove).
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { nowIso } from '../lib/dates';
import type { CategoryDirection } from '../theme/icons';

export interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  color_hex: string | null;
  icon: string | null;
  direction: CategoryDirection;
  /** v17 (melhoria 5): data de arquivamento (null = ativa). */
  archived_at: string | null;
}

export interface CreateCategoryInput {
  name: string;
  direction: CategoryDirection;
  icon?: string | null;
  parentId?: string | null;
}

export class CategoryService {
  constructor(private db: DbDriver) {}

  list(): Promise<CategoryRow[]> {
    return this.db.getAllAsync<CategoryRow>(
      'SELECT id, name, parent_id, color_hex, icon, direction, archived_at FROM categories ORDER BY name'
    );
  }

  async getById(id: string): Promise<CategoryRow | null> {
    return this.db.getFirstAsync<CategoryRow>(
      'SELECT id, name, parent_id, color_hex, icon, direction, archived_at FROM categories WHERE id = ?',
      [id]
    );
  }

  /** v17 (melhoria 5): lista das categorias ATIVAS (para escolhas de lançamento). */
  listActive(): Promise<CategoryRow[]> {
    return this.db.getAllAsync<CategoryRow>(
      'SELECT id, name, parent_id, color_hex, icon, direction, archived_at FROM categories WHERE archived_at IS NULL ORDER BY name'
    );
  }

  async create(input: CreateCategoryInput): Promise<CategoryRow> {
    const name = input.name?.trim();
    if (!name) throw new Error('Informe o nome da categoria');
    const dir = input.direction ?? 'BOTH';
    if (!['DEBIT', 'CREDIT', 'BOTH'].includes(dir)) throw new Error('Direção inválida');

    let parentId: string | null = null;
    if (input.parentId) {
      const parent = await this.getById(input.parentId);
      if (!parent) throw new Error('Categoria pai não encontrada');
      if (parent.parent_id) throw new Error('Subcategoria não pode ter outra subcategoria como pai');
      parentId = parent.id;
    }

    const id = genId();
    await this.db.runAsync(
      'INSERT INTO categories (id, name, parent_id, color_hex, icon, direction) VALUES (?,?,?,?,?,?)',
      [id, name, parentId, null, input.icon ?? null, dir]
    );
    const created = await this.getById(id);
    if (!created) throw new Error('Falha ao criar categoria');
    return created;
  }

  async update(id: string, input: { name?: string; direction?: CategoryDirection; icon?: string | null; parentId?: string | null }): Promise<void> {
    const current = await this.getById(id);
    if (!current) throw new Error('Categoria não encontrada');

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name != null) {
      const name = input.name.trim();
      if (!name) throw new Error('Informe o nome da categoria');
      sets.push('name = ?');
      params.push(name);
    }
    if (input.direction != null) {
      if (!['DEBIT', 'CREDIT', 'BOTH'].includes(input.direction)) throw new Error('Direção inválida');
      sets.push('direction = ?');
      params.push(input.direction);
    }
    if (input.icon !== undefined) {
      sets.push('icon = ?');
      params.push(input.icon);
    }
    if (input.parentId !== undefined) {
      if (input.parentId === id) throw new Error('Uma categoria não pode ser pai dela mesma');
      if (input.parentId) {
        const parent = await this.getById(input.parentId);
        if (!parent) throw new Error('Categoria pai não encontrada');
        if (parent.parent_id) throw new Error('Subcategoria não pode ter outra subcategoria como pai');
      }
      sets.push('parent_id = ?');
      params.push(input.parentId);
    }
    if (!sets.length) return;
    params.push(id);
    await this.db.runAsync(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`, params as never);
  }

  /** Quantos registros usam a categoria (impede exclusão em uso). */
  async usageCount(id: string): Promise<{ total: number; transactions: number; products: number; subcategories: number; recurrences: number }> {
    const tx = await this.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', [id]);
    const prod = await this.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM products_catalog WHERE category_id = ?', [id]);
    const subs = await this.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM categories WHERE parent_id = ?', [id]);
    const rec = await this.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM recurrence_rules WHERE category_id = ?', [id]);
    return {
      transactions: tx?.n ?? 0,
      products: prod?.n ?? 0,
      subcategories: subs?.n ?? 0,
      recurrences: rec?.n ?? 0,
      total: (tx?.n ?? 0) + (prod?.n ?? 0) + (subs?.n ?? 0) + (rec?.n ?? 0),
    };
  }

  async remove(id: string): Promise<void> {
    const current = await this.getById(id);
    if (!current) throw new Error('Categoria não encontrada');
    const usage = await this.usageCount(id);
    if (usage.total > 0) {
      throw new Error(
        `Categoria em uso: ${usage.transactions} lançamento(s), ${usage.products} produto(s), ` +
        `${usage.subcategories} subcategoria(s), ${usage.recurrences} conta(s) fixa(s). ` +
        'Não é possível excluir enquanto houver uso — ARQUIVE em vez de excluir.'
      );
    }
    await this.db.runAsync('DELETE FROM categories WHERE id = ?', [id]);
  }

  /**
   * v17 (melhoria 5): ARQUIVAR/DESARQUIVAR categoria.
   *  - Arquivar um PAI arquiva em cascata as subcategorias (elas nunca aparecem
   *    órfãs nas escolhas).
   *  - Desarquivar vale APENAS para a categoria escolhida (as subcategorias
   *    seguem arquivadas até serem desarquivadas uma a uma).
   *  Retorna quantas categorias foram afetadas.
   */
  async setArchived(id: string, archived: boolean): Promise<number> {
    const current = await this.getById(id);
    if (!current) throw new Error('Categoria não encontrada');
    if (archived) {
      const subs = await this.db.getAllAsync<{ id: string }>(
        'SELECT id FROM categories WHERE parent_id = ?',
        [id]
      );
      const stamp = nowIso();
      await this.db.runAsync('UPDATE categories SET archived_at = ? WHERE id = ?', [stamp, id]);
      for (const s of subs) {
        await this.db.runAsync('UPDATE categories SET archived_at = ? WHERE id = ?', [stamp, s.id]);
      }
      return 1 + subs.length;
    }
    await this.db.runAsync('UPDATE categories SET archived_at = NULL WHERE id = ?', [id]);
    return 1;
  }
}
