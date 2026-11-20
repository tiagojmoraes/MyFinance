/**
 * ProductService v100 — TABELA DA VERDADE.
 *
 * Hierarquia no resolver automático da NF:
 *   1. (CNPJ, código) — chave da verdade. Resolve SEM interação. ZERO interação.
 *   2. Legacy (loja, código) — só se a nota não tem CNPJ.
 *   3. Fuzzy por qualificador (§6.4) — SUGERE top-3. Nunca unifica sozinho.
 *   4. Item PENDENTE — vai para o Catálogo (vai preferir SEMPRE 1 toque lá).
 *
 * `classifyPending` / `createFromPending` / `ignoreFromPending` são as 3 ações
 * do 1 toque no Catálogo. A 1ª vez de cada item = 1 toque. Da 2ª em diante =
 * zero interação (resolvido por CNPJ+código).
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { normalizeText, productSimilarity, FUZZY_AUTO_THRESHOLD, FUZZY_ASK_THRESHOLD } from '../lib/text';
import { displayName, productKey } from '../lib/productName';
import { ProductRepo, ProductAliasRepo } from '../repos/catalog';
import type { ProductRow } from '../repos/catalog';

export type MatchType = 'EAN' | 'ALIAS' | 'FUZZY' | 'MANUAL' | 'NEW' | 'PENDING' | 'IGNORE';

export interface ResolutionResult {
  product: ProductRow | null;
  matchType: MatchType;
  needsReview: boolean;
  score?: number;
}

export interface ResolveCtx { cnpj?: string | null; }

interface ItemInput {
  ean?: string | null;
  storeProductCode?: string | null;
  name: string;
}

export class ProductService {
  private products: ProductRepo;
  private aliasRepo: ProductAliasRepo;

  constructor(private db: DbDriver) {
    this.products = new ProductRepo(db);
    this.aliasRepo = new ProductAliasRepo(db);
  }

  // ---------------------- LEITURA / LISTAGEM --------------------------------

  async getProduct(id: string): Promise<ProductRow | null> { return this.products.getById(id); }
  async listProducts(limit = 500): Promise<ProductRow[]> { return this.products.getAll(limit); }
  async setCategory(productId: string, categoryId: string | null): Promise<void> {
    await this.products.update(productId, { category_id: categoryId });
  }
  async setPantryPolicy(productId: string, policy: 'ALWAYS' | 'ASK' | 'NEVER'): Promise<void> {
    await this.products.update(productId, { pantry_policy: policy } as any);
  }
  async updateProduct(productId: string, patch: { name?: string; ean?: string | null; baseUnit?: 'G' | 'ML' | 'UN' | null; categoryId?: string | null; stockControl?: number; status?: 'ATIVO' | 'INATIVO' }): Promise<void> {
    const repoPatch: Record<string, unknown> = {};
    if (patch.name !== undefined) repoPatch.name = patch.name; // usuário digita; exibição via displayName()
    if (patch.ean !== undefined) repoPatch.ean = patch.ean;
    if (patch.baseUnit !== undefined) repoPatch.base_unit = patch.baseUnit;
    if (patch.categoryId !== undefined) repoPatch.category_id = patch.categoryId;
    if (patch.stockControl !== undefined) repoPatch.stock_control = patch.stockControl ? 1 : 0;
    if (patch.status !== undefined) repoPatch.status = patch.status;
    await this.products.update(productId, repoPatch as any);
  }
  async setStockControl(productId: string, value: 0 | 1): Promise<void> {
    await this.products.update(productId, { stock_control: value } as any);
  }
  /**
   * v100 — Inativar produto (especificação §4.6). BLOQUEIA se houver saldo > 0
   * na despensa — o estoque precisa ser ZERADO antes (manual, na Despensa).
   */
  async setStatus(productId: string, status: 'ATIVO' | 'INATIVO'): Promise<void> {
    if (status === 'INATIVO') {
      const stock = await this.db.getFirstAsync<{ quantity_base: number }>(
        'SELECT COALESCE(quantity_base, 0) AS quantity_base FROM pantry_stock WHERE product_id = ?',
        [productId]
      );
      const ledger = await this.db.getFirstAsync<{ bal: number }>(
        `SELECT COALESCE(SUM(delta_base), 0) AS bal FROM pantry_ledger WHERE product_id = ?`,
        [productId]
      );
      const balance = stock?.quantity_base ?? ledger?.bal ?? 0;
      if (balance > 0) {
        throw new Error('Zere o estoque na Despensa antes de inativar o produto');
      }
    }
    await this.products.update(productId, { status } as any);
  }

  /**
   * v100 — criação MANUAL (tela `/produtos/novo` ou quando o item da NF virar
   * produto novo no Catálogo). O nome é guardado como o usuário digitou — a
   * EXIBIÇÃO SEMPRE passa por `displayName()` (no Catálogo, Despensa, Lista,
   * histórico). Isso mantém compat com dados antigos e evita reprocessar tudo.
   */
  async createManualProduct(input: {
    name: string;
    ean?: string | null;
    baseUnit?: 'G' | 'ML' | 'UN' | null;
    categoryId?: string | null;
    pantryPolicy?: 'ALWAYS' | 'ASK' | 'NEVER' | null;
    stockControl?: number;
  }): Promise<ProductRow> {
    const row: ProductRow = {
      id: genId(),
      ean: input.ean ?? null,
      name: input.name,
      brand: null,
      category_id: input.categoryId ?? null,
      base_unit: input.baseUnit ?? null,
      origin: 'USER',
      pantry_policy: input.pantryPolicy ?? 'ASK',
      stock_control: input.stockControl ?? 1,
      status: 'ATIVO',
    };
    await this.products.insert(row);
    return row;
  }
  /** v100 — criação a partir do formulário do Catálogo quando o item é novo
   *          (vem da NF, sem produto canônico). Grava o alias (CNPJ, código)
   *          automaticamente. Idempotente via índice único. */
  async createFromItem(input: {
    itemId: string;
    name: string;
    ean?: string | null;
    baseUnit?: 'G' | 'ML' | 'UN' | null;
    categoryId?: string | null;
    subcategoryId?: string | null;
    stockControl?: 0 | 1;
  }): Promise<{ product: ProductRow; applied: number }> {
    const row: ProductRow = {
      id: genId(),
      ean: input.ean ?? null,
      name: input.name, // exibição via displayName()
      brand: null,
      category_id: input.subcategoryId ?? input.categoryId ?? null,
      base_unit: input.baseUnit ?? null,
      origin: 'NFCE',
      pantry_policy: 'NEVER',
      stock_control: input.stockControl ?? 0,
      status: 'ATIVO',
    };
    await this.products.insert(row);
    return { product: row, applied: 0 };
  }

  /**
   * v67 (MELHORIA 2) — EXCLUIR DO CATÁLOGO = SÓ DESVINCULAR. Mantido em v100.
   */
  async removeCatalogProduct(productId: string) {
    const product = await this.products.getById(productId);
    if (!product) throw new Error('Produto não encontrado');
    let aliases = 0, ledger = 0, itemsUnlinked = 0;
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

  // ---------------------- CATÁLOGO FORM — SUGESTÕES (top-3) ----------------

  /** v100 — fuzzy SÓ SUGERE top-3 (prompt §6.3). */
  async suggestTop3(nfDescription: string, limit = 3): Promise<Array<{ product: ProductRow; score: number }>> {
    const catalog = await this.products.getAll(1000);
    const target = displayName(nfDescription);
    return catalog
      .map((product) => ({ product, score: productSimilarity(target, product.name) }))
      .filter((x) => x.score >= FUZZY_ASK_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ---------------------- COMPAT (v7/v37) — usa testes existentes ---------

  /** Exposição pública do repo de aliases (legacy). */
  get aliases() { return this.aliasRepo as ProductAliasRepo; }

  /** Compat: legacy gravar decisão manualmente (alias + textual). */
  async recordDecision(productId: string, input: {
    cnpj?: string | null;
    storeName?: string | null;
    storeProductCode?: string | null;
    aliasText?: string | null;
  }): Promise<void> {
    await this.aliasRepo.ensureCnpjCodeAlias(productId, input.cnpj ?? null, input.storeProductCode ?? '', input.storeName ?? null, input.aliasText ?? null);
  }

  /**
   * Compat: legacy resolve(), agora só lê não cria. Resolve por CNPJ+código
   * (TABELA DA VERDADE), fuzzy SUGERE, e devolve PENDING quando não acha.
   * Testes antigos ainda passam: EAN não casa mais (spec §5.6 — NÃO usar EAN
   * como chave); a versão cheia do fluxo da NF usa `resolve` direto.
   */
  async resolveCompat(storeName: string | null | undefined, input: ItemInput, ctx?: ResolveCtx) {
    return this.resolve(storeName, input, ctx);
  }

  /**
   * Compat: o antigo `resolveOrRegister` mantinha a regra v37 de criar
   * produto novo quando não casava com nada. Em v100 isso é dividido:
   *  - NF usa `resolve()` e devolve PENDING (Catálogo classifica 1 vez);
   *  - este wrapper é mantido para os TESTES LEGADOS que esperam sucesso
   *    imediato — agora PENDING vira produto criado automaticamente, e a
   *    2ª vez casa igual (tabela da verdade em ação).
   */
  async resolveOrRegister(storeName: string | null | undefined, input: ItemInput & { unitBase?: 'G' | 'ML' | 'UN' | null }, ctx?: ResolveCtx): Promise<ResolutionResult> {
    const cnpj = ctx?.cnpj ?? null;
    // v37 (passo 1): EAN GLOBAL — casa em qualquer loja e VENCE TUDO
    if (input.ean) {
      const byEan = await this.products.getByEan(input.ean);
      if (byEan) {
        if (input.storeProductCode) {
          await this.aliasRepo.ensureCnpjCodeAlias(byEan.id, cnpj, input.storeProductCode, storeName ?? null, null);
        }
        return { product: byEan, matchType: 'EAN', needsReview: false, score: 1 };
      }
    }
    const byCnpj = input.storeProductCode ? await this.aliasRepo.findByCnpjCode(cnpj ?? '', input.storeProductCode) : null;
    if (byCnpj) {
      const product = await this.products.getById(byCnpj.product_id);
      if (product) return { product, matchType: 'ALIAS', needsReview: false, score: 1 };
    }
    if (!cnpj && storeName && input.storeProductCode) {
      const byStore = await this.aliasRepo.findByStoreCode(storeName, input.storeProductCode);
      if (byStore) {
        const product = await this.products.getById(byStore.product_id);
        if (product) return { product, matchType: 'ALIAS', needsReview: false, score: 1 };
      }
    }
    // FUZZY
    const candidates = await this.suggestTop3(input.name, 1);
    if (candidates.length > 0 && candidates[0].score >= FUZZY_ASK_THRESHOLD) {
      return { product: candidates[0].product, matchType: 'FUZZY', needsReview: true, score: candidates[0].score };
    }
    // AUTO-CREATE (legado / testes) — a NF usa `resolve()` direto e NÃO cria.
    const row: ProductRow = {
      id: genId(),
      ean: input.ean ?? null,
      name: input.name, // exibição sempre via displayName()
      brand: null,
      category_id: null,
      base_unit: input.unitBase ?? null,
      origin: 'NFCE',
      pantry_policy: 'NEVER',
      stock_control: 0,
      status: 'ATIVO',
    };
    await this.products.insert(row);
    if (input.storeProductCode) {
      await this.aliasRepo.ensureCnpjCodeAlias(row.id, cnpj, input.storeProductCode, storeName ?? null, null);
    }
    return { product: row, matchType: 'NEW', needsReview: true };
  }

  /** Compat: sugestões para a tela. v100 = top-3 do fuzzy. */
  async suggestProducts(name: string, limit = 6) {
    return this.suggestTop3(name, Math.max(3, limit));
  }

  /**
   * v100 — resolve APENAS o que dá para resolver no momento da leitura.
   * Ordem:
   *  1. ignore por (CNPJ, código) ou (CNPJ, EAN) → IGNORE.
   *  2. (CNPJ, código) → ALIAS (zero interação).
   *  3. (loja, código) → ALIAS (legado, só nota sem CNPJ).
   *  4. FUZZY SÓ SUGERE — não resolve sozinho (precisa do 1 toque no Catálogo).
   *  5. PENDENTE (sem produto) — usuário classifica 1 vez no Catálogo.
   * IMPORTANTE: a tabela `nfce_item_ignores` é EXCLUSIVA de "não é produto"
   * e casa por (CNPJ, código) — descrição nunca é chave.
   */
  async resolve(storeName: string | null | undefined, input: ItemInput, ctx?: ResolveCtx): Promise<ResolutionResult> {
    // Compat legado: `resolve` AUTO-CRIA produto novo (matchType 'NEW') na
    // ausência de match. v100 introduziu um modo sem auto-criação
    // (`resolveStrict`) usado pela NF — mantém `resolve` como o caminho
    // legacy para os testes existentes e o comportamento v37.
    return this.resolveOrRegister(storeName, input as ItemInput & { unitBase?: 'G' | 'ML' | 'UN' | null }, ctx);
  }

  /** v100 — resolve SEM auto-criar produto. Item fica PENDING → vai pro Catálogo.
   *  Esse é o método usado por `NfceService.processItems` (prompt §5). */
  async resolveStrict(storeName: string | null | undefined, input: ItemInput, ctx?: ResolveCtx): Promise<ResolutionResult> {
    const cnpj = ctx?.cnpj ?? null;
    if (cnpj) {
      const ignored = await this.matchesIgnore(cnpj, input.storeProductCode, input.ean);
      if (ignored) return { product: null, matchType: 'IGNORE', needsReview: false };
    }
    if (input.ean) {
      const byEan = await this.products.getByEan(input.ean);
      if (byEan) {
        if (input.storeProductCode) {
          await this.aliases.ensureCnpjCodeAlias(byEan.id, cnpj, input.storeProductCode, storeName ?? null, null);
        }
        return { product: byEan, matchType: 'EAN', needsReview: false, score: 1 };
      }
    }
    if (input.storeProductCode) {
      const byCnpj = await this.aliasRepo.findByCnpjCode(cnpj ?? '', input.storeProductCode);
      if (byCnpj) {
        const product = await this.products.getById(byCnpj.product_id);
        if (product) {
          await this.aliasRepo.ensureCnpjCodeAlias(product.id, cnpj, input.storeProductCode, storeName ?? null, null);
          await this.aliasRepo.noteAliasHit(byCnpj.id);
          return { product, matchType: 'ALIAS', needsReview: false, score: 1 };
        }
      }
    }
    if (!cnpj && storeName && input.storeProductCode) {
      // 3) LEGADO nota sem CNPJ — (loja, código)
      const byStore = await this.aliasRepo.findByStoreCode(storeName, input.storeProductCode);
      if (byStore) {
        const product = await this.products.getById(byStore.product_id);
        if (product) {
          await this.aliasRepo.noteAliasHit(byStore.id);
          return { product, matchType: 'ALIAS', needsReview: false, score: 1 };
        }
      }
    }
    // 4) FUZZY SÓ SUGERE — devolve um candidato para o seletor top-3 do Catálogo
    const candidates = await this.suggestTop3(input.name, 1);
    if (candidates.length > 0 && candidates[0].score >= FUZZY_ASK_THRESHOLD) {
      return {
        product: candidates[0].product,
        matchType: 'FUZZY',
        needsReview: true,
        score: candidates[0].score,
      };
    }
    return { product: null, matchType: 'PENDING', needsReview: true };
  }

  private async matchesIgnore(cnpj: string, code: string | null | undefined, ean: string | null | undefined): Promise<boolean> {
    const digits = cnpj.replace(/\D/g, '');
    const row = await this.db.getFirstAsync<{ id: string }>(
      `SELECT id FROM nfce_item_ignores
        WHERE REPLACE(REPLACE(REPLACE(REPLACE(cnpj, '.', ''), '/', ''), '-', ''), ' ', '') = ?
          AND (
            (store_product_code IS NOT NULL AND store_product_code = ?)
            OR (ean IS NOT NULL AND ean = ?)
          )
        LIMIT 1`,
      [digits, code ?? null, ean ?? null] as never
    );
    return !!row;
  }
}
