/**
 * v72 — DESPENSA: LISTA DE COMPRA (pedido do usuário).
 *
 * O usuário monta o carrinho na Despensa (toque no produto, ou tudo que está
 * abaixo do mínimo de uma vez) e o app diz DE ONDE comprar mais barato, com
 * base nas NOTAS LIDAS (nfce_items × nfce_documents — sem tabela nova):
 *  · preço unitário = valor do item ÷ quantidade;
 *  · por loja, por produto: vale a COMPRA MAIS RECENTE;
 *  · guarda de dimensão: KG nunca mistura com UN (g↔kg e ml↔L são convertidos
 *    para a base do produto; entradas de outra dimensão são ignoradas);
 *  · produto sem nota lida segue na lista, sem preço.
 *  Roda: npx jest src/__tests__/despensa-lista-compra.test.ts
 */

import { makeCtx } from '../helpers';
import type { DbDriver } from '../../db/types';
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..', '..', '..');
const readSrc = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const ACC = '';

async function seedNota(
  db: DbDriver,
  args: {
    accessKey: string; store: string; issuedAt: string;
    items: Array<{ desc: string; qty: number; unit: string; total: number; productId: string | null }>;
  }
) {
  await db.runAsync(
    `INSERT INTO nfce_documents (access_key, store_name, issued_at, amount_paid_cents, parse_status, needs_review)
     VALUES (?, ?, ?, 0, 'COMPLETE', 0)`,
    [args.accessKey, args.store, args.issuedAt]
  );
  for (let i = 0; i < args.items.length; i++) {
    const it = args.items[i];
    await db.runAsync(
      `INSERT INTO nfce_items (id, access_key, line_number, description, qty, unit_original, total_cents, product_id, status, stock_applied)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PARSED', 0)`,
      [`it-${args.accessKey}-${i}`, args.accessKey, i + 1, it.desc, it.qty, it.unit, it.total, it.productId]
    );
  }
}

describe('v72 — Lista de Compra: preços por nfce_items', () => {
  test('menor preço por loja (compra mais recente), guarda de dimensão e data', async () => {
    const { db, services } = await makeCtx();
    const arroz = await services.products.createManualProduct({ name: 'Arroz Type 1', baseUnit: 'G' });
    const sabonete = await services.products.createManualProduct({ name: 'Sabonete Dove', baseUnit: 'UN' });
    const semNota = await services.products.createManualProduct({ name: 'Produto sem nota', baseUnit: 'UN' });

    // Assaí 01/11: arroz 5kg R$ 25,00 (5,00/kg) + sabonete 3un R$ 14,97 (4,99/un)
    await seedNota(db, {
      accessKey: 'A1'.padEnd(44, '0'),
      store: 'Assaí',
      issuedAt: '2026-11-01T12:00:00.000Z',
      items: [
        { desc: 'ARROZ TYPE 1 5KG', qty: 5, unit: 'KG', total: 2500, productId: arroz.id },
        { desc: 'SABONETE DOVE', qty: 3, unit: 'UN', total: 1497, productId: sabonete.id },
      ],
    });
    // Assaí ANTIGA (01/10): arroz mais caro — NÃO vale (vale a mais recente da loja)
    await seedNota(db, {
      accessKey: 'A0'.padEnd(44, '0'),
      store: 'Assaí',
      issuedAt: '2026-10-01T12:00:00.000Z',
      items: [{ desc: 'ARROZ TYPE 1 5KG', qty: 5, unit: 'KG', total: 3000, productId: arroz.id }],
    });
    // Carrefour 03/11: arroz 5kg R$ 22,50 (4,50/kg — MENOR) + sabonete 3un R$ 15,30 (5,10/un)
    await seedNota(db, {
      accessKey: 'C1'.padEnd(44, '0'),
      store: 'Carrefour',
      issuedAt: '2026-11-03T12:00:00.000Z',
      items: [
        { desc: 'ARROZ TYPE 1 5KG', qty: 5, unit: 'KG', total: 2250, productId: arroz.id },
        { desc: 'SABONETE DOVE', qty: 3, unit: 'UN', total: 1530, productId: sabonete.id },
      ],
    });
    // KG ≠ UN: arroz vendido por UNIDADE (cunha de dimensão) — ignorado
    await seedNota(db, {
      accessKey: 'X9'.padEnd(44, '0'),
      store: 'Bairro',
      issuedAt: '2026-11-05T12:00:00.000Z',
      items: [{ desc: 'ARROZ (pacote)', qty: 1, unit: 'UN', total: 999, productId: arroz.id }],
    });

    const data = await services.pantry.getListaCompraData([
      { productId: arroz.id, qtyBase: 0 },
      { productId: sabonete.id, qtyBase: 0 },
      { productId: semNota.id, qtyBase: 0 },
    ]);
    expect(data).toHaveLength(3);

    const arrozData = data.find((d) => d.productId === arroz.id)!;
    expect(arrozData.name).toBe('Arroz Type 1');
    expect(arrozData.baseUnit).toBe('G');
    expect(arrozData.dim).toBe('G');
    // UMA oferta por loja — e a de Out/2026 (mais antiga) NÃO entrou
    expect(arrozData.offers).toHaveLength(2);
    const assai = arrozData.offers.find((o) => o.storeName === 'Assaí')!;
    expect(assai.unitPriceBaseCents).toBeCloseTo(0.5, 6); // 2.500 ¢ / 5.000 g = 0,5 ¢/g = R$ 5,00/kg
    expect(assai.date).toBe('2026-11-01');
    const carrefour = arrozData.offers.find((o) => o.storeName === 'Carrefour')!;
    expect(carrefour.unitPriceBaseCents).toBeCloseTo(0.45, 6); // R$ 22,50 / 5 kg = R$ 4,50/kg
    expect(carrefour.date).toBe('2026-11-03');
    // a oferta em UN (dimensão errada) não vira oferta de arroz
    expect(arrozData.offers.some((o) => o.storeName === 'Bairro')).toBe(false);

    const sabData = data.find((d) => d.productId === sabonete.id)!;
    expect(sabData.dim).toBe('UN');
    expect(sabData.offers).toHaveLength(2);
    // menor preço do sabonete = Assaí 4,99/un (1.497/3)
    const melhorSab = sabData.offers.reduce((a, b) => (b.unitPriceBaseCents < a.unitPriceBaseCents ? b : a));
    expect(melhorSab.storeName).toBe('Assaí');
    expect(melhorSab.unitPriceBaseCents).toBeCloseTo(499, 6); // 1.497 ¢ / 3 un = 499 ¢/un = R$ 4,99/un

    // produto SEM nota: segue na lista, sem ofertas
    const semData = data.find((d) => d.productId === semNota.id)!;
    expect(semData.name).toBe('Produto sem nota');
    expect(semData.offers).toHaveLength(0);
  });

  test('lista vazia → dados vazios (sem consulta ao banco)', async () => {
    const { services } = await makeCtx();
    expect(await services.pantry.getListaCompraData([])).toEqual([]);
  });

  test('categoria do produto vem junto (pai ▸ filho para a visão por categoria)', async () => {
    const { db, services } = await makeCtx();
    const cat = await services.categories.create({ name: 'Mercado V72', direction: 'DEBIT' });
    const sub = await services.categories.create({ name: 'Hortifruti V72', direction: 'DEBIT', parentId: cat.id });
    const prod = await services.products.createManualProduct({ name: 'Banana Prata', baseUnit: 'G' });
    await services.products.setCategory(prod.id, sub.id);
    await seedNota(db, {
      accessKey: 'B1'.padEnd(44, '0'),
      store: 'Feirinha',
      issuedAt: '2026-11-02T12:00:00.000Z',
      items: [{ desc: 'BANANA PRATA', qty: 2, unit: 'KG', total: 1198, productId: prod.id }],
    });
    const [d] = await services.pantry.getListaCompraData([{ productId: prod.id, qtyBase: 0 }]);
    expect(d.categoryName).toBe('Hortifruti V72');
    expect(d.parentCategoryName).toBe('Mercado V72');
  });

  test('carrinho sobrevive ao fechar e voltar (persistido em app_settings, sem tabela nova)', async () => {
    const { db, services } = await makeCtx();
    const p1 = await services.products.createManualProduct({ name: 'Café', baseUnit: 'G' });
    await services.settings.set('despensa_lista_compra', JSON.stringify([p1.id]));
    const raw = await services.settings.get('despensa_lista_compra');
    expect(JSON.parse(raw!)).toEqual([p1.id]);
    // e a chave vive em app_settings (nenhuma tabela nova)
    const row = await db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE '%compra%'"
    );
    expect(row?.n).toBe(0);
  });
});

describe('v72 — tela Despensa: abas, carrinho e as duas visões', () => {
  test('a tela tem a aba Lista de Compra, o botão "Abaixo do mínimo" e as visões', () => {
    const src = readSrc('app/despensa.tsx');
    expect(src).toContain("'ESTOQUE' | 'COMPRA'");
    expect(src).toContain('Lista de Compra');
    // v104: o alerta de estoque baixo virou chip "⚠ Estoque baixo" na linha.
    expect(src).toContain('Estoque baixo');
    expect(src).toContain('Por categoria');
    expect(src).toContain('Por loja');
    // v34: cada item entra UMA vez, na loja do MENOR preço — o rodapé do card
    // passou a dizer "total nesta loja"
    expect(src).toContain('total nesta loja');
    // guarda de dimensão documentada na tela (KG nunca mistura com UN)
    expect(src).toContain('nunca mistura');
  });
});
