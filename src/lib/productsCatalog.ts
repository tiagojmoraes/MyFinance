/** v57 — Catálogo de Produtos (Cadastros → Produtos) + Memória da despensa + Vinculação durante a NF.
 *  Regras acordadas com o usuário:
 *  - Produto = o que se vê. Alias (CNPJ+código) = o que o app usa por dentro, NÃO aparece na tela.
 *  - Classificar (categoria/subcategoria) = 1 vez, na tabela. Nunca durante a NF.
 *  - Vincular = durante a NF, 1 item por vez. Fuzzy só SUGERE, nunca unifica sozinho.
 *  - Memória: SEMPRE / PERGUNTAR / NUNCA por produto.
 *  - Estoque por unidade da NF: KG e UN separados, sem conversão.
 */
import { productSimilarity } from './text';

export type PantryPolicy = 'ALWAYS' | 'ASK' | 'NEVER';
export type StockUnit = 'G' | 'ML' | 'UN' | 'KG' | 'L';

export interface CatalogProduct {
  id: string;
  name: string;
  ean: string | null; // null = nunca veio EAN (maioria)
  categoryId: string | null; // ex: 'Alimentos'
  subcategoryId: string | null; // ex: 'Verduras' / 'Frutas'
  pantryPolicy: PantryPolicy; // SEMPRE / PERGUNTAR / NUNCA
  lowThresholdBase: number | null;
  baseUnit: StockUnit;
}
export interface ProductAlias {
  cnpj: string | null; // lugar
  storeCode: string; // código da loja (cProd) — sempre tem
  ean: string | null; // cEAN — às vezes vem, às vezes SEM GTIN
  productId: string;
  aliasText: string; // texto original na nota, ex: BANANA PRATA KG
}
/** Normaliza EAN: 'SEM GTIN', vazio, '0' = sem EAN. */
export function normalizeEan(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (!s || s === 'SEM GTIN' || s === 'SEMGTIN' || s === '0' || s === '0000000000000') return null;
  return s;
}
/** 1º passo: EAN exato (global). */
export function findByEan(products: CatalogProduct[], eanRaw: string | null | undefined): CatalogProduct | null {
  const ean = normalizeEan(eanRaw);
  if (!ean) return null;
  return products.find(p => p.ean && normalizeEan(p.ean) === ean) ?? null;
}
/** 2º passo: Alias (CNPJ + código da loja) — a chave da verdade local. */
export function findByAlias(aliases: ProductAlias[], cnpj: string | null | undefined, storeCode: string | null | undefined, products: CatalogProduct[]): CatalogProduct | null {
  if (!storeCode) return null;
  const a = aliases.find(x => x.storeCode === storeCode && (x.cnpj ?? null) === (cnpj ?? null));
  if (!a) return null;
  return products.find(p => p.id === a.productId) ?? null;
}
/** 3º passo: Fuzzy SÓ SUGERE (nunca unifica). Retorna melhor sugestão + score. */
export function suggestByFuzzy(name: string, products: CatalogProduct[]): { product: CatalogProduct; score: number } | null {
  if (!products.length) return null;
  let best: CatalogProduct | null = null; let bestScore = 0;
  for (const p of products) {
    const s = productSimilarity(name, p.name);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  if (!best) return null;
  return { product: best, score: bestScore };
}
/** Resolve um item da NF: EAN → Alias → Fuzzy-sugestão → Pergunta. */
export type NfItemResolution =
  | { kind: 'AUTO_EAN'; product: CatalogProduct }
  | { kind: 'AUTO_ALIAS'; product: CatalogProduct }
  | { kind: 'ASK_FUZZY'; suggestion: CatalogProduct | null; score: number }
  | { kind: 'ASK_NEW' };
export function resolveNfItem(input: { name: string; eanRaw: string | null; cnpj: string | null; storeCode: string | null }, products: CatalogProduct[], aliases: ProductAlias[]): NfItemResolution {
  const byEan = findByEan(products, input.eanRaw);
  if (byEan) return { kind: 'AUTO_EAN', product: byEan };
  const byAlias = findByAlias(aliases, input.cnpj, input.storeCode, products);
  if (byAlias) return { kind: 'AUTO_ALIAS', product: byAlias };
  const sugg = suggestByFuzzy(input.name, products);
  if (sugg && sugg.score >= 0.84) return { kind: 'ASK_FUZZY', suggestion: sugg.product, score: sugg.score };
  if (sugg) return { kind: 'ASK_FUZZY', suggestion: null, score: sugg.score };
  return { kind: 'ASK_NEW' };
}
/** Ao confirmar um vínculo, grava/ensina o alias (CNPJ+código → produto) e, se veio EAN, grava EAN no produto. */
export function learnAlias(aliases: ProductAlias[], products: CatalogProduct[], input: { cnpj: string | null; storeCode: string; eanRaw: string | null; aliasText: string }, productId: string): { aliases: ProductAlias[]; products: CatalogProduct[] } {
  const ean = normalizeEan(input.eanRaw);
  const exists = aliases.some(a => a.storeCode === input.storeCode && (a.cnpj ?? null) === (input.cnpj ?? null) && a.productId === productId);
  const nextAliases = exists ? aliases : [...aliases, { cnpj: input.cnpj, storeCode: input.storeCode, ean, productId, aliasText: input.aliasText }];
  const nextProducts = products.map(p => p.id === productId && ean && !p.ean ? { ...p, ean } : p);
  return { aliases: nextAliases, products: nextProducts };
}
/** Decisão de despensa na hora do item: respeita a memória. */
export function pantryDecisionFor(product: CatalogProduct): 'IN' | 'OUT' | 'ASK' {
  if (product.pantryPolicy === 'ALWAYS') return 'IN';
  if (product.pantryPolicy === 'NEVER') return 'OUT';
  return 'ASK';
}
/** Estoque por unidade da NF: nunca converte KG ↔ UN. */
export interface StockLine { productId: string; unit: StockUnit; qty: number }
export function addStock(lines: StockLine[], productId: string, unit: StockUnit, qty: number): StockLine[] {
  const i = lines.findIndex(l => l.productId === productId && l.unit === unit);
  if (i === -1) return [...lines, { productId, unit, qty }];
  const next = [...lines]; next[i] = { ...next[i], qty: next[i].qty + qty }; return next;
}
export function stockFor(lines: StockLine[], productId: string): StockLine[] { return lines.filter(l => l.productId === productId); }
/** Gasto por categoria (R$) + estoque por categoria (quantidades por unidade). */
export function spendByCategory(items: { product: CatalogProduct; amountCents: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const key = `${it.product.categoryId ?? 'Sem categoria'} / ${it.product.subcategoryId ?? '—'}`;
    m.set(key, (m.get(key) ?? 0) + it.amountCents);
  }
  return m;
}
