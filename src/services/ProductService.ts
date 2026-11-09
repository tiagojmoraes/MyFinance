/**
 * ProductService — RESOLUÇÃO DE PRODUTOS
 *
 * v7  (hierarquia clássica):  EAN > alias(loja, código) > fuzzy(nome) > novo.
 * v37 (TABELA DA VERDADE — pedido do usuário):
 *
 *   1. EAN exato (global — vale em qualquer loja);
 *   2. alias por (CNPJ, código interno) — A CHAVE DA VERDADE: o mesmo código
 *      na mesma loja é sempre o mesmo produto, nota após nota;
 *   2b. alias por (store_name, código) — reserva para notas sem CNPJ;
 *   3. FUZZY por tokens de produto (productSimilarity — lib/text):
 *        · score >= 0.94 -> UNIFICA SOZINHO e GRAVA a decisão
 *          (alias de código + textual) — "itens iguais entram na despensa";
 *        · score >= 0.84 -> PERGUNTA (candidato sugerido na revisão);
 *        · abaixo        -> produto NOVO — "só pergunta dos novos";
 *   4. NOVO produto (origin='NFCE') TAMBÉM PERGUNTA — classificar 1ª vez
 *      (categoria/subitem); a decisão grava alias e a PRÓXIMA nota daquele
 *      CNPJ+codigo resolve sozinha no passo 2.
 *
 * A decisão do usuário (vincular/criar) passa por recordDecision() e
 * REAPONTA aliases antigos que estiverem errados — a tabela da verdade é
 * corrigível, e a última decisão manual sempre vence.
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import {
  normalizeText,
  productSimilarity,
  FUZZY_AUTO_THRESHOLD,
  FUZZY_ASK_THRESHOLD,
} from '../lib/text';
import { ProductRepo, ProductAliasRepo } from '../repos/catalog';
import type { ProductRow } from '../repos/catalog';

export type MatchType = 'EAN' | 'ALIAS' | 'FUZZY' | 'MANUAL' | 'NEW';

export interface ResolutionResult {
  product: ProductRow | null;
  matchType: MatchType;
  /** true = item vai para a fila de revisão ("pergunta") na UI. */
  needsReview: boolean;
  /** v37: score do match em [0,1] (1.0 para EAN/ALIAS/MANUAL). */
  score?: number;
}

/** v37: contexto do documento — o CNPJ é a chave da tabela da verdade. */
export interface ResolveCtx {
  cnpj?: string | null;
}

export type ProductUnitMeasure = 'UN' | 'KG' | 'G';

export function productUnitMeasureFromNfce(unitOriginal: string | null | undefined): ProductUnitMeasure {
  const unit = (unitOriginal ?? '').trim().toUpperCase();
  if (['G', 'GR', 'GRAMAS'].includes(unit)) return 'G';
  if (['KG', 'KGS', 'QUILO', 'QUILOS'].includes(unit)) return 'KG';
  return 'UN';
}

export class ProductService {
  private products: ProductRepo;
  private aliases: ProductAliasRepo;

  constructor(private db: DbDriver) {
    this.products = new ProductRepo(db);
    this.aliases = new ProductAliasRepo(db);
  }

  /** Passo 1: match exato por EAN. */
  private async resolveByEan(ean: string | null | undefined): Promise<ProductRow | null> {
    if (!ean) return null;
    return this.products.getByEan(ean);
  }

  /**
   * Passo 2 da TABELA DA VERDADE (v37): (CNPJ, código) primeiro — é o par
   * estável da nota; (store_name, código) fica como reserva legada.
   */
  private async resolveByCode(
    storeName: string | null | undefined,
    code: string | null | undefined,
    ctx?: ResolveCtx
  ): Promise<{ product: ProductRow; aliasId: string } | null> {
    if (!code) return null;
    if (ctx?.cnpj) {
      const hit = await this.aliases.findByCnpjCode(ctx.cnpj, code);
      if (hit) {
        const product = await this.products.getById(hit.product_id);
        if (product) return { product, aliasId: hit.id };
      }
    }
    if (storeName) {
      const hit = await this.aliases.findByStoreCode(storeName, code);
      if (hit) {
        const product = await this.products.getById(hit.product_id);
        if (product) return { product, aliasId: hit.id };
      }
    }
    return null;
  }

  /**
   * Passo 3 v37 — fuzzy por TOKENS contra catálogo + aliases.
   * Retorna o MELHOR candidato com o score composto (productSimilarity).
   */
  private async resolveFuzzy(name: string): Promise<{ product: ProductRow; score: number } | null> {
    let best: { id: string; score: number } | null = null;

    const catalog = await this.db.getAllAsync<{ id: string; name: string }>(
      'SELECT id, name FROM products_catalog'
    );
    for (const row of catalog) {
      const score = productSimilarity(name, row.name);
      if (!best || score > best.score) best = { id: row.id, score };
    }

    // Aliases textuais também participam (histórico de nomes já vistos)
    const aliasRows = await this.aliases.getAllWithProduct();
    for (const alias of aliasRows) {
      if (!alias.alias_text) continue;
      const score = productSimilarity(name, alias.alias_text);
      if (!best || score > best.score) best = { id: alias.product_id, score };
    }

    if (!best) return null;
    const product = await this.products.getById(best.id);
    return product ? { product, score: best.score } : null;
  }

  /**
   * Hierarquia completa (somente leitura): decide match sem gravar nada.
   */
  async resolve(storeName: string | null | undefined, input: {
    ean?: string | null;
    storeProductCode?: string | null;
    name: string;
  }, ctx?: ResolveCtx): Promise<Omit<ResolutionResult, 'product'> & { candidates?: ProductRow[] }> {
    const byEan = await this.resolveByEan(input.ean);
    if (byEan) return { matchType: 'EAN', needsReview: false, score: 1 };

    const byCode = await this.resolveByCode(storeName, input.storeProductCode, ctx);
    if (byCode) return { matchType: 'ALIAS', needsReview: false, score: 1 };

    const fuzzy = await this.resolveFuzzy(input.name);
    if (fuzzy && fuzzy.score >= FUZZY_ASK_THRESHOLD) {
      return { matchType: 'FUZZY', needsReview: fuzzy.score < FUZZY_AUTO_THRESHOLD, score: fuzzy.score };
    }
    return { matchType: 'NEW', needsReview: true, score: fuzzy?.score };
  }

  /**
   * Hierarquia completa COM persistência (v37 — TABELA DA VERDADE):
   *  · todo acerto soma telemetria no alias (noteAliasHit);
   *  · FUZZY automático (score >= 0.94) GRAVA o aprendizado: alias de código
   *    (CNPJ + código) e textual — a próxima nota resolve no passo 2;
   *  · NOVO produto PERGUNTA (needsReview true) — classificar uma vez;
   *    a decisão manual grava o alias e as próximas resolvem sozinhas.
   */
  async resolveOrRegister(storeName: string | null | undefined, input: {
    ean?: string | null;
    storeProductCode?: string | null;
    name: string;
    unitBase?: 'G' | 'ML' | 'UN' | null;
    unitMeasure?: ProductUnitMeasure;
  }, ctx?: ResolveCtx): Promise<ResolutionResult> {
    const cnpj = ctx?.cnpj ?? null;

    // Passo 1 — EAN (global)
    const byEan = await this.resolveByEan(input.ean);
    if (byEan) {
      // Aprende o código da loja para o produto já conhecido (de graça)
      if (input.storeProductCode) {
        await this.aliases.ensureCnpjCodeAlias(byEan.id, cnpj, input.storeProductCode, storeName ?? null);
      }
      return { product: byEan, matchType: 'EAN', needsReview: false, score: 1 };
    }

    // Passo 2 — (CNPJ, código) / (loja, código)
    const byCode = await this.resolveByCode(storeName, input.storeProductCode, ctx);
    if (byCode) {
      if (input.storeProductCode) {
        await this.aliases.ensureCnpjCodeAlias(byCode.product.id, cnpj, input.storeProductCode, storeName ?? null);
      }
      await this.aliases.noteAliasHit(byCode.aliasId);
      return { product: byCode.product, matchType: 'ALIAS', needsReview: false, score: 1 };
    }

    // Passo 3 — FUZZY por tokens (v57/v59: SÓ SUGERE, nunca unifica sozinho).
    // Mesmo com 100% de parecença, a decisão é do usuário DURANTE a NF
    // (tela de revisão: "É esse / É outro / + Produto novo"). Não grava alias aqui.
    const fuzzy = await this.resolveFuzzy(input.name);
    if (fuzzy && fuzzy.score >= FUZZY_ASK_THRESHOLD) {
      return { product: fuzzy.product, matchType: 'FUZZY', needsReview: true, score: fuzzy.score };
    }

    // Passo 4 — NOVO: cria e PERGUNTA (classificar categoria/subitem 1ª vez).
    // O alias (CNPJ, código) já fica gravado: a decisão do usuário (ou o
    // próprio aceite) faz a PRÓXIMA nota resolver no passo 2, sem perguntar.
    const newProduct: ProductRow = {
      id: genId(),
      ean: input.ean ?? null,
      name: input.name,
      brand: null,
      category_id: null,
      base_unit: input.unitBase ?? null,
      unit_measure: input.unitMeasure ?? (input.unitBase === 'G' ? 'G' : 'UN'),
      origin: 'NFCE',
    };
    await this.products.insert(newProduct);
    if (input.storeProductCode) {
      await this.aliases.ensureCnpjCodeAlias(newProduct.id, cnpj, input.storeProductCode, storeName ?? null);
    }
    return { product: newProduct, matchType: 'NEW', needsReview: true, score: fuzzy?.score ?? 0 };
  }

  /**
   * v37 — DECISÃO DO USUÁRIO (tela de revisão): vincular/criar/corrigir.
   * Grava alias (CNPJ, código) + textual e REAPONTA os que estiverem errados.
   * É isto que "treina" a tabela da verdade.
   */
  async recordDecision(productId: string, input: {
    cnpj?: string | null;
    storeName?: string | null;
    storeProductCode?: string | null;
    aliasText?: string | null;
  }): Promise<void> {
    if (input.storeProductCode) {
      await this.aliases.ensureCnpjCodeAlias(productId, input.cnpj ?? null, input.storeProductCode, input.storeName ?? null);
    }
    if (input.aliasText) {
      // alias textual apenas se não existir idêntico para o produto
      const rows = await this.aliases.getAllWithProduct();
      const dup = rows.some((r) => r.product_id === productId && r.alias_text && normalizeText(r.alias_text) === normalizeText(input.aliasText!));
      if (!dup) {
        await this.aliases.insert({
          id: genId(),
          product_id: productId,
          alias_text: input.aliasText,
          store_name: input.storeName ?? null,
          store_product_code: null,
        });
      }
    }
  }

  /** v37: classificar produto em categoria/subitem (decisão persistida). */
  async setCategory(productId: string, categoryId: string | null): Promise<void> {
    await this.products.update(productId, { category_id: categoryId });
  }

  /** v37: sugestões ordenadas por similaridade para o seletor da revisão. */
  async suggestProducts(name: string, limit = 6): Promise<Array<{ product: ProductRow; score: number }>> {
    const catalog = await this.products.getAll(1000);
    return catalog
      .map((product) => ({ product, score: productSimilarity(name, product.name) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Criação manual (tela Despensa) — origin USER. */
  async createManualProduct(input: {
    name: string;
    ean?: string | null;
    baseUnit?: 'G' | 'ML' | 'UN' | null;
    unitMeasure?: ProductUnitMeasure;
    categoryId?: string | null;
    pantryPolicy?: 'ALWAYS' | 'ASK' | 'NEVER' | null;
  }): Promise<ProductRow> {
    const row: ProductRow = {
      id: genId(),
      ean: input.ean ?? null,
      name: input.name,
      brand: null,
      category_id: input.categoryId ?? null,
      base_unit: input.baseUnit ?? (input.unitMeasure === 'KG' || input.unitMeasure === 'G' ? 'G' : 'UN'),
      unit_measure: input.unitMeasure ?? (input.baseUnit === 'G' ? 'G' : 'UN'),
      origin: 'USER',
      pantry_policy: input.pantryPolicy ?? 'ASK',
    };
    await this.products.insert(row);
    return row;
  }

  async getProduct(id: string): Promise<ProductRow | null> {
    return this.products.getById(id);
  }

  async setPantryPolicy(productId: string, policy: 'ALWAYS' | 'ASK' | 'NEVER'): Promise<void> {
    await this.products.update(productId, { pantry_policy: policy });
  }

  /** v57 (Produtos): renomear / trocar EAN / unidade base de uma vez.
   *  v63.1: mapeia `baseUnit` (camelCase da API) para `base_unit` (coluna) —
   *  antes a unidade nunca era gravada (o repo só conhece snake_case). */
  async updateProduct(productId: string, patch: {
    name?: string;
    ean?: string | null;
    baseUnit?: 'G' | 'ML' | 'UN' | null;
    unitMeasure?: ProductUnitMeasure;
  }): Promise<void> {
    const repoPatch: Partial<Omit<ProductRow, 'id'>> = {};
    if (patch.name !== undefined) repoPatch.name = patch.name;
    if (patch.ean !== undefined) repoPatch.ean = patch.ean;
    if (patch.baseUnit !== undefined) repoPatch.base_unit = patch.baseUnit;
    if (patch.unitMeasure !== undefined) repoPatch.unit_measure = patch.unitMeasure;
    await this.products.update(productId, repoPatch);
  }

  async ensureMeasurementUnit(unitOriginal: string | null | undefined): Promise<void> {
    const code = unitOriginal?.trim().toUpperCase();
    if (!code) return;
    if (code.length > 32) throw new Error('Unidade de medida inválida na NFC-e');
    await this.db.runAsync(
      'INSERT OR IGNORE INTO measurement_units (code, label) VALUES (?, ?)',
      [code, code]
    );
  }

  async listProducts(limit = 500): Promise<ProductRow[]> {
    return this.products.getAll(limit);
  }

  /**
   * v67 (MELHORIA 2) — EXCLUIR DO CATÁLOGO = SÓ DESVINCULAR:
   *  · lançamentos e NOTAS NÃO são apagados — os itens das notas ficam com
   *    product_id = NULL (o texto/descrição deles permanece);
   *  · o aprendizado daquele produto (aliases CNPJ+código/textuais), o estoque
   *    atual e o ledger da despensa dele saem junto (pertencem ao produto);
   *  · nenhum lançamento financeiro é tocado (não há product_id neles).
   * Retorna quantos vínculos foram desfeitos (para a mensagem da tela).
   */
  async removeCatalogProduct(productId: string): Promise<{ aliases: number; ledger: number; itemsUnlinked: number }> {
    const product = await this.products.getById(productId);
    if (!product) throw new Error('Produto não encontrado');
    let aliases = 0;
    let ledger = 0;
    let itemsUnlinked = 0;
    await this.db.transactionAsync(async () => {
      const a = await this.db.runAsync('DELETE FROM product_aliases WHERE product_id = ?', [productId]);
      aliases = a?.changes ?? 0;
      const l = await this.db.runAsync('DELETE FROM pantry_ledger WHERE product_id = ?', [productId]);
      ledger = l?.changes ?? 0;
      await this.db.runAsync('DELETE FROM pantry_stock WHERE product_id = ?', [productId]);
      const u = await this.db.runAsync('UPDATE nfce_items SET product_id = NULL WHERE product_id = ?', [productId]);
      itemsUnlinked = u?.changes ?? 0;
      await this.db.runAsync('DELETE FROM products_catalog WHERE id = ?', [productId]);
    });
    return { aliases, ledger, itemsUnlinked };
  }
}
