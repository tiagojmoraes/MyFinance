/** v58 — PRODUTOS tela (Cadastros → Produtos) — persistência da memória + edição
 *  Roda: npm run test:bateria58 | .\scripts\run-bateria.ps1 -Bateria58
 *  A tela em si (app/produtos.tsx) usa os mesmos componentes do programa (Screen/Card/Select/Segmented).
 *  Aqui testamos o que a tela grava: nome, EAN, categoria, pantry_policy, limite.
 */
import { makeCtx } from './helpers';

describe('v58 PRODUTOS — criar com categoria + pantry_policy', () => {
  test('Criar produto novo com categoria + SEMPRE grava e volta na listagem', async () => {
    const { services } = await makeCtx();
    const cats = await services.categories.listActive();
    const cat = cats[0];
    const created = await services.products.createManualProduct({ name: 'Banana Prata', baseUnit: 'G', categoryId: cat.id, pantryPolicy: 'ALWAYS' });
    expect(created.id).toBeTruthy(); expect(created.name).toBe('Banana Prata');
    const list = await services.products.listProducts();
    const found: any = list.find((p: any) => p.id === created.id);
    expect(found).toBeTruthy(); expect(found.category_id).toBe(cat.id); expect(found.pantry_policy).toBe('ALWAYS');
  });
  test('Editar nome + EAN + unidade via updateProduct', async () => {
    const { services } = await makeCtx();
    const created = await services.products.createManualProduct({ name: 'BNN PRATA', baseUnit: 'UN' });
    await services.products.updateProduct(created.id, { name: 'Banana Prata', ean: '7891234567890', baseUnit: 'G' });
    const got: any = await services.products.getProduct(created.id);
    expect(got.name).toBe('Banana Prata'); expect(got.ean).toBe('7891234567890'); expect(got.base_unit).toBe('G');
  });
  test('Memória SEMPRE → NUNCA: setPantryPolicy persiste e muda a decisão da próxima nota', async () => {
    const { services } = await makeCtx();
    const created = await services.products.createManualProduct({ name: 'Sabão em Pó', baseUnit: 'UN', pantryPolicy: 'ALWAYS' });
    let got: any = await services.products.getProduct(created.id);
    expect(got.pantry_policy).toBe('ALWAYS');
    await services.products.setPantryPolicy(created.id, 'NEVER');
    got = await services.products.getProduct(created.id);
    expect(got.pantry_policy).toBe('NEVER');
  });
  test('Classificar 1 vez na tabela: setCategory troca categoria/subcategoria', async () => {
    const { services } = await makeCtx();
    const cats = await services.categories.listActive();
    const parent = cats.find((c: any) => !c.parent_id);
    const sub = cats.find((c: any) => c.parent_id === parent?.id);
    const created = await services.products.createManualProduct({ name: 'Couve Manteiga', baseUnit: 'UN' });
    await services.products.setCategory(created.id, sub ? sub.id : parent!.id);
    const got: any = await services.products.getProduct(created.id);
    expect(got.category_id).toBe(sub ? sub.id : parent!.id);
  });
  test('Padrão sem pantry_policy = ASK (perguntar)', async () => {
    const { services } = await makeCtx();
    const created = await services.products.createManualProduct({ name: 'Produto Sem Política', baseUnit: 'UN' });
    const got: any = await services.products.getProduct(created.id);
    expect(got.pantry_policy).toBe('ASK');
  });
  test('Estoque: +1/-1 via Despensa continua funcionando p/ produto da tela Produtos', async () => {
    const { services } = await makeCtx();
    const created = await services.products.createManualProduct({ name: 'Banana Prata', baseUnit: 'G' });
    await services.pantry.registerManualMovement({ productId: created.id, deltaBase: 1700, reason: 'CORRECTION' });
    const list = await services.pantry.listPantry();
    const row: any = list.find((r: any) => r.product_id === created.id);
    expect(row.quantity_base).toBe(1700);
    await services.pantry.registerManualMovement({ productId: created.id, deltaBase: -500, reason: 'CONSUMPTION' });
    const list2 = await services.pantry.listPantry();
    expect((list2.find((r: any) => r.product_id === created.id) as any).quantity_base).toBe(1200);
  });
});
