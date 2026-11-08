/**
 * v37 — TABELA DA VERDADE (pedido do usuário):
 *  · extrair o CÓDIGO da loja do item ("(Código: 8142)");
 *  · unificar o MESMO produto entre CNPJs diferentes via fuzzy matching
 *    (mamão no Assaí 8142 = Carrefour 456 = Empório 789);
 *  · unidade diferente → mesmo código da verdade, contabilização separada
 *    (item KG não entra em produto UN);
 *  · classificar em item/subitem e GRAVAR A DECISÃO — a próxima nota daquele
 *    CNPJ já resolve sozinha ("só pergunta dos novos");
 *  · decisão manual REAPONTA alias errado (a última decisão vence);
 *  · re-resolução retroativa de itens antigos sem produto.
 */

import { makeCtx } from './helpers';
import { parseNfceItems, parseNfceHeader } from '../parsers/nfce';
import { productSimilarity, FUZZY_ASK_THRESHOLD } from '../lib/text';
import { ProductAliasRepo } from '../repos/catalog';

// ───────────────────────── fixtures (layout por CLASSES da SEFAZ-SP) ─────────────────────────

const CNPJ_ASSAI = '06.057.223/0508-61';
const CNPJ_CARREFOUR = '12.345.678/0001-95';
const CNPJ_EMPORIO = '45.723.174/0001-10';

let seq = 0;
const genKey = () => `3526${String(++seq).padStart(4, '0')}9140216900018765001000000000000000000000`.slice(0, 44);

const itemRow = (desc: string, code: string, qty: string, unit: string, unitPrice: string, total: string) => `
<tr id="Item + 1"><td>
<span class="txtTit">${desc}</span>
<span class="RCod">(Código: ${code} )</span><br/>
<span class="Rqtd"><strong>Qtde.:</strong>${qty}</span>
<span class="RUN"><strong>UN: </strong>${unit}</span>
<span class="RvlUnit"><strong>Vl. Unit.:</strong> ${unitPrice}</span></td>
<td class="txtTit noWrap">Vl. Total<br/><span class="valor">${total}</span></td></tr>`;

const notaHtml = (razao: string, cnpj: string, linhas: string) => `
<html><body>
<div class="txtTopo">${razao}</div>
<div>Nome Empresarial: ${razao}</div>
<div>CNPJ: ${cnpj}</div>
<div>Data e Hora da Emissão: 31/10/2026 14:20:12</div>
<table id="tabResult"><tbody>${linhas}</tbody></table>
<div>Valor Total: R$ 15,40</div>
<div>Valor Pago: R$ 15,40</div>
</body></html>`;

const MAMAO_ASSAI = notaHtml(
  'SENDAS DISTRIBUIDORA S/A',
  CNPJ_ASSAI,
  itemRow('MAMAO PAPAYA kg', '8142', '2,616', 'Kg', '5,89', '15,40')
);
const MAMAO_ASSAI_OUTRA = notaHtml(
  'SENDAS DISTRIBUIDORA S/A',
  CNPJ_ASSAI,
  itemRow('MAMAO PAPAYA kg', '8142', '1,000', 'Kg', '5,89', '5,89')
);
const MAMAO_CARREFOUR = notaHtml(
  'CARREFOUR COMERCIO E SERVICOS',
  CNPJ_CARREFOUR,
  itemRow('MAMAO PAPAYA KG', '456', '2,616', 'KG', '6,49', '16,97')
);
const MAMAO_CARREFOUR_OUTRA = notaHtml(
  'CARREFOUR COMERCIO E SERVICOS',
  CNPJ_CARREFOUR,
  itemRow('MAMAO PAPAYA', '456', '1,000', 'KG', '6,49', '6,49')
);
const MAMAO_EMPORIO = notaHtml(
  'EMPORIO A FRUTAS',
  CNPJ_EMPORIO,
  itemRow('MAMAO PAPAYA kg', '789', '1,200', 'Kg', '7,99', '9,59')
);
const ABACAXI_EMPORIO_UN = notaHtml(
  'EMPORIO A FRUTAS',
  CNPJ_EMPORIO,
  itemRow('ABACAXI PERA', '777', '1', 'UN', '5,89', '5,89')
);
const ABACAXI_EMPORIO_KG = notaHtml(
  'EMPORIO A FRUTAS',
  CNPJ_EMPORIO,
  itemRow('ABACAXI PERA kg', '778', '1,300', 'Kg', '4,53', '5,89')
);

async function ingest(key: string, html: string) {
  const { services } = ctx!;
  await services.nfce.ingestFromHtml(key, html, null);
  return services.nfce.processItems(key, html);
}

let ctx: Awaited<ReturnType<typeof makeCtx>> | null = null;
beforeEach(async () => {
  ctx = await makeCtx();
});

// ───────────────────────── 1. parser: o CÓDIGO da loja ─────────────────────────

describe('v37 — parser: Código da loja e EAN', () => {
  test('item com (Código: 8142) → storeProductCode; descrição sem o código', () => {
    const itens = parseNfceItems(MAMAO_ASSAI);
    expect(itens).toHaveLength(1);
    expect(itens[0].description).toBe('MAMAO PAPAYA kg');
    expect(itens[0].storeProductCode).toBe('8142');
    expect(itens[0].eanExtracted).toBeNull();
    expect(itens[0].qty).toBeCloseTo(2.616, 3);
    expect(itens[0].unitOriginal).toBe('KG');
    expect(itens[0].totalCents).toBe(1540);
  });

  test('código de 13 dígitos é EAN/GTIN, não código de loja', () => {
    const html = notaHtml('LOJA X', CNPJ_ASSAI, itemRow('NESTON 400G', '7896102500110', '1', 'UN', '8,99', '8,99'));
    const itens = parseNfceItems(html);
    expect(itens[0].eanExtracted).toBe('7896102500110');
    expect(itens[0].storeProductCode).toBeNull();
  });
});

// ───────────────────────── 2. similaridade de PRODUTO (tokens) ─────────────────────────

describe('v37 — productSimilarity (fuzzy entre lojas)', () => {
  test('mesmo produto com ruído de unidade → 1.0', () => {
    expect(productSimilarity('MAMAO PAPAYA KG', 'MAMAO PAPAYA')).toBe(1);
    expect(productSimilarity('LEITE INTEGRAL CAIXA 1L', 'Leite Integral Caixa 1L')).toBe(1);
  });
  test('variedades diferentes NÃO se unificam', () => {
    expect(productSimilarity('MANGA PALMER', 'MANGA TOMMY')).toBeLessThan(FUZZY_ASK_THRESHOLD);
  });
});

// ───────────────────────── 3. A TABELA DA VERDADE ponta a ponta ─────────────────────────

describe('v37 — mamão Assaí 8142 = Carrefour 456 = Empório 789', () => {
  test('1ª nota: produto novo PERGUNTA (classifique 1×); decisão grava alias', async () => {
    const { services, db } = ctx!;
    const key1 = genKey();
    const p1 = await ingest(key1, MAMAO_ASSAI);
    expect(p1.items).toBe(1);
    expect(p1.needsReview).toBe(1); // "só pergunta dos novos" — este é novo

    const item1 = await db.getFirstAsync<{ id: string; product_id: string; match_type: string | null; stock_applied: number }>(
      'SELECT id, product_id, match_type, stock_applied FROM nfce_items WHERE access_key = ?'
    , [key1]);
    expect(item1?.match_type).toBe('NEW');
    expect(item1?.product_id).toBeTruthy();
    expect(item1?.stock_applied).toBe(0); // não entra no estoque antes da decisão

    const doc1 = await db.getFirstAsync<{ needs_review: number }>('SELECT needs_review FROM nfce_documents WHERE access_key = ?', [key1]);
    expect(doc1?.needs_review).toBe(1);

    // decisão do usuário: confirmar (categoria viria do seletor na UI)
    await services.nfce.confirmItemProduct(item1!.id);
    const stock1 = await db.getFirstAsync<{ quantity_base: number }>('SELECT quantity_base FROM pantry_stock WHERE product_id = ?', [item1!.product_id]);
    expect(stock1?.quantity_base).toBe(2616); // 2,616 kg = 2616 g
  });

  test('mesma nota de novo (mesmo CNPJ+codigo) → ALIAS automático, SEM pergunta, entra no estoque', async () => {
    const { services, db } = ctx!;
    const key1 = genKey();
    await ingest(key1, MAMAO_ASSAI);
    const item1 = await db.getFirstAsync<{ product_id: string; id: string }>('SELECT id, product_id FROM nfce_items WHERE access_key = ?', [key1]);
    await services.nfce.confirmItemProduct(item1!.id);

    const key2 = genKey();
    const p2 = await ingest(key2, MAMAO_ASSAI_OUTRA);
    expect(p2.needsReview).toBe(0); // já classificado — não pergunta de novo
    const item2 = await db.getFirstAsync<{ product_id: string; match_type: string | null; stock_applied: number }>(
      'SELECT product_id, match_type, stock_applied FROM nfce_items WHERE access_key = ?', [key2]);
    expect(item2?.match_type).toBe('ALIAS');
    expect(item2?.product_id).toBe(item1!.product_id); // MESMA verdade
    expect(item2?.stock_applied).toBe(1); // estoque automático
    const doc2 = await db.getFirstAsync<{ needs_review: number }>('SELECT needs_review FROM nfce_documents WHERE access_key = ?', [key2]);
    expect(doc2?.needs_review).toBe(0);
  });

  test('OUTRA loja (Carrefour, código 456) → fuzzy SUGERE a verdade; confirmar grava o alias', async () => {
    const { services, db } = ctx!;
    const key1 = genKey();
    await ingest(key1, MAMAO_ASSAI);
    const item1Row = await db.getFirstAsync<{ id: string; product_id: string }>('SELECT id, product_id FROM nfce_items WHERE access_key = ?', [key1]);
    // v59: a 1ª nota é NEW — o usuário confirma para criar a verdade
    await services.nfce.confirmItemProduct(item1Row!.id);
    const item1 = await db.getFirstAsync<{ product_id: string }>('SELECT product_id FROM nfce_items WHERE access_key = ?', [key1]);

    const keyC = genKey();
    const pC = await ingest(keyC, MAMAO_CARREFOUR);
    // v59: fuzzy SÓ SUGERE — vai para a revisão (a decisão é do usuário)
    expect(pC.needsReview).toBe(1);
    const itemCRow = await db.getFirstAsync<{ id: string; product_id: string; match_type: string | null; match_score: number | null; stock_applied: number }>(
      'SELECT id, product_id, match_type, match_score, stock_applied FROM nfce_items WHERE access_key = ?', [keyC]);
    expect(itemCRow?.match_type).toBe('FUZZY');
    expect(itemCRow?.match_score ?? 0).toBeGreaterThanOrEqual(0.94);
    expect(itemCRow?.product_id).toBe(item1!.product_id); // ← SUGERIDA a unificação entre lojas
    expect(itemCRow?.stock_applied).toBe(0); // não aplica antes da decisão
    // usuário confirma a sugestão → grava o alias do Carrefour (CNPJ, 456) + aplica estoque
    await services.nfce.confirmItemProduct(itemCRow!.id);

    // 2ª nota do Carrefour: agora é ALIAS (código 456 aprendido para o CNPJ do Carrefour)
    const keyC2 = genKey();
    const pC2 = await ingest(keyC2, MAMAO_CARREFOUR_OUTRA);
    expect(pC2.needsReview).toBe(0);
    const itemC2 = await db.getFirstAsync<{ match_type: string | null; product_id: string }>(
      'SELECT match_type, product_id FROM nfce_items WHERE access_key = ?', [keyC2]);
    expect(itemC2?.match_type).toBe('ALIAS');
    expect(itemC2?.product_id).toBe(item1!.product_id);
  });

  test('terceira loja (Empório, código 789) também entra — os três códigos, um produto', async () => {
    const { services, db } = ctx!;
    const key1 = genKey();
    await ingest(key1, MAMAO_ASSAI);
    const item1Row = await db.getFirstAsync<{ id: string; product_id: string }>('SELECT id, product_id FROM nfce_items WHERE access_key = ?', [key1]);
    await services.nfce.confirmItemProduct(item1Row!.id);
    const truthId = item1Row!.product_id;

    // v59: Carrefour — fuzzy sugere a verdade, o usuário confirma (grava alias 456)
    const keyC = genKey();
    await ingest(keyC, MAMAO_CARREFOUR);
    const itemCRow = await db.getFirstAsync<{ id: string; product_id: string }>('SELECT id, product_id FROM nfce_items WHERE access_key = ?', [keyC]);
    expect(itemCRow!.product_id).toBe(truthId);
    await services.nfce.confirmItemProduct(itemCRow!.id);

    // v59: Empório — idem (grava alias 789)
    const keyE = genKey();
    await ingest(keyE, MAMAO_EMPORIO);
    const itemERow = await db.getFirstAsync<{ id: string; product_id: string }>('SELECT id, product_id FROM nfce_items WHERE access_key = ?', [keyE]);
    expect(itemERow!.product_id).toBe(truthId);
    await services.nfce.confirmItemProduct(itemERow!.id);

    const aliases = await db.getAllAsync<{ cnpj: string | null; store_product_code: string | null; product_id: string }>(
      `SELECT cnpj, store_product_code, product_id FROM product_aliases
        WHERE cnpj IS NOT NULL AND store_product_code IN (?, ?, ?) ORDER BY store_product_code`,
      ['8142', '456', '789']
    );
    // os TRÊS códigos apontam para o MESMO produto canônico
    expect(aliases.map((a) => a.product_id)).toEqual([truthId, truthId, truthId]);
  });
});

// ───────────────────────── 4. unidade diferente → contabilização separada ─────────────────────────

describe('v37 — unidade diferente: mesmo código da verdade, KG não vira UN', () => {
  test('item KG ligado a produto UN fica vinculado mas FORA do estoque', async () => {
    const { services, db } = ctx!;
    const key1 = genKey();
    await ingest(key1, ABACAXI_EMPORIO_UN); // produto novo (base UN) — pergunta
    const item1 = await db.getFirstAsync<{ id: string; product_id: string }>('SELECT id, product_id FROM nfce_items WHERE access_key = ?', [key1]);
    await ctx!.services.nfce.confirmItemProduct(item1!.id);
    const stock1 = await db.getFirstAsync<{ quantity_base: number }>('SELECT quantity_base FROM pantry_stock WHERE product_id = ?', [item1!.product_id]);
    expect(stock1?.quantity_base).toBe(1); // 1 UN

    // mesma fruta vendida por PESO em outra nota — fuzzy SUGERE a verdade (v59),
    // fica em revisão e FORA do estoque (dimensão KG ≠ UN)
    const key2 = genKey();
    const p2 = await ingest(key2, ABACAXI_EMPORIO_KG);
    const item2 = await db.getFirstAsync<{ product_id: string; match_type: string | null; stock_applied: number }>(
      'SELECT product_id, match_type, stock_applied FROM nfce_items WHERE access_key = ?', [key2]);
    expect(item2?.product_id).toBe(item1!.product_id); // mesma verdade sugerida
    expect(item2?.match_type).toBe('FUZZY');
    expect(item2?.stock_applied).toBe(0); // GUARDA: KG não entra em produto UN (e está em revisão)
    expect(p2.needsReview).toBe(1); // v59: sugestão fuzzy espera a decisão do usuário

    const stock2 = await db.getFirstAsync<{ quantity_base: number }>('SELECT quantity_base FROM pantry_stock WHERE product_id = ?', [item1!.product_id]);
    expect(stock2?.quantity_base).toBe(1); // estoque intacto (sem misturar dimensão)
    // sugestão pendente de decisão pendura o documento para revisão (v59)
    const doc2 = await db.getFirstAsync<{ needs_review: number }>('SELECT needs_review FROM nfce_documents WHERE access_key = ?', [key2]);
    expect(doc2?.needs_review).toBe(1);
  });
});

// ───────────────────────── 5. decisão manual corrige a verdade ─────────────────────────

describe('v37 — a última decisão manual vence (reapontamento)', () => {
  test('vincular item a outro produto REAPONTA o alias (CNPJ, código)', async () => {
    const { services, db } = ctx!;
    const key1 = genKey();
    await ingest(key1, MAMAO_ASSAI);
    const item1 = await db.getFirstAsync<{ id: string; product_id: string }>('SELECT id, product_id FROM nfce_items WHERE access_key = ?', [key1]);
    await services.nfce.confirmItemProduct(item1!.id); // 8142 → mamão

    // nova nota, usuário diz que AQUELE código é outro produto
    const key2 = genKey();
    await ingest(key2, MAMAO_ASSAI_OUTRA); // resolve ALIAS → mamão
    const item2 = await db.getFirstAsync<{ id: string; product_id: string }>('SELECT id, product_id FROM nfce_items WHERE access_key = ?', [key2]);
    const melancia = await services.products.createManualProduct({ name: 'MELANCIA SANDIA kg', baseUnit: 'G' });
    await services.nfce.linkItemToProduct(item2!.id, melancia.id); // DECISÃO

    const alias = await db.getFirstAsync<{ product_id: string }>(
      'SELECT product_id FROM product_aliases WHERE cnpj = ? AND store_product_code = ?',
      ['06057223050861', '8142']
    );
    expect(alias?.product_id).toBe(melancia.id); // ← REAPONTADO

    // próxima nota já nasce no produto corrigido
    const key3 = genKey();
    await ingest(key3, MAMAO_ASSAI_OUTRA);
    const item3 = await db.getFirstAsync<{ product_id: string; match_type: string | null }>(
      'SELECT product_id, match_type FROM nfce_items WHERE access_key = ?', [key3]);
    expect(item3?.product_id).toBe(melancia.id);
    expect(item3?.match_type).toBe('ALIAS');
  });
});

// ───────────────────────── 6. classificação item ▸ subitem + re-resolução retroativa ─────────────────────────

describe('v37 — classificação e aprendizado retroativo', () => {
  test('criar produto com categoria/subitem grava a classificação', async () => {
    const { services, db } = ctx!;
    // a seed já cria 'cat-mercado' (topo) — cria só o SUBITEM (item ▸ subitem)
    await db.runAsync(
      "INSERT INTO categories (id, name, parent_id) VALUES ('cat-t37-frutas', 'Frutas', 'cat-mercado')"
    );
    const key1 = genKey();
    await ingest(key1, MAMAO_ASSAI);
    const item1 = await db.getFirstAsync<{ id: string }>('SELECT id FROM nfce_items WHERE access_key = ?', [key1]);
    const cats = await services.categories.listActive();
    const sub = cats.find((c) => c.parent_id);
    expect(sub?.id).toBe('cat-t37-frutas');
    const pid = await services.nfce.createProductFromItem(item1!.id, sub!.id);
    const prod = await services.products.getProduct(pid);
    expect(prod?.category_id).toBe('cat-t37-frutas');
    // o match do item vira MANUAL (log da decisão)
    const it = await db.getFirstAsync<{ match_type: string | null }>('SELECT match_type FROM nfce_items WHERE id = ?', [item1!.id]);
    expect(it?.match_type).toBe('MANUAL');
  });

  test('item antigo SEM produto é resolvido quando a nota é reprocessada (retroativo)', async () => {
    const { services, db } = ctx!;
    const key1 = genKey();
    await ingest(key1, MAMAO_ASSAI);
    const item1 = await db.getFirstAsync<{ id: string; product_id: string }>('SELECT id, product_id FROM nfce_items WHERE access_key = ?', [key1]);

    // simula item "da v36": sem produto e sem log de decisão
    await db.runAsync('UPDATE nfce_items SET product_id = NULL, match_type = NULL, match_score = NULL WHERE id = ?', [item1!.id]);

    // a decisão do usuário existe em outro lugar: produto manual + alias do CNPJ
    const verdade = await services.products.createManualProduct({ name: 'MAMÃO PAPAYA', baseUnit: 'G' });
    const aliases = new ProductAliasRepo(db);
    await aliases.ensureCnpjCodeAlias(verdade.id, '06057223050861', '8142', 'SENDAS DISTRIBUIDORA S/A');

    // REPROCESSA: o aprendizado alcança o passado
    await services.nfce.processItems(key1, MAMAO_ASSAI);
    const after = await db.getFirstAsync<{ product_id: string; match_type: string | null }>(
      'SELECT product_id, match_type FROM nfce_items WHERE id = ?', [item1!.id]);
    expect(after?.product_id).toBe(verdade.id);
    expect(after?.match_type).toBe('ALIAS');
    const doc = await db.getFirstAsync<{ needs_review: number }>('SELECT needs_review FROM nfce_documents WHERE access_key = ?', [key1]);
    expect(doc?.needs_review).toBe(0);
  });

  test('migration v13: colunas da tabela da verdade existem', async () => {
    const { db } = ctx!;
    const aliasCols = await db.getAllAsync<{ name: string }>("PRAGMA table_info('product_aliases')");
    expect(aliasCols.map((c) => c.name)).toContain('cnpj');
    expect(aliasCols.map((c) => c.name)).toContain('match_count');
    const itemCols = await db.getAllAsync<{ name: string }>("PRAGMA table_info('nfce_items')");
    expect(itemCols.map((c) => c.name)).toContain('match_type');
    expect(itemCols.map((c) => c.name)).toContain('match_score');
    const idx = await db.getFirstAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_aliases_cnpj_code'"
    );
    expect(idx?.name).toBe('idx_aliases_cnpj_code');
  });
});
