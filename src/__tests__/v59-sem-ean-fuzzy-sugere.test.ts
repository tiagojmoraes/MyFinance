/** v59 — SEM EAN NA TELA + FUZZY SÓ SUGERE + VINCULAÇÃO DURANTE A NF
 *  Roda: npm run test:bateria59 | .\scripts\run-bateria.ps1 -Bateria59
 *  - EAN: usuário não sabe o que é olhando a NF → sem campo EAN em Produtos / Revisão.
 *    O EAN continua sendo aprendido sozinho por dentro (resolveOrRegister).
 *  - Fuzzy: mesmo com 100% nunca unifica sozinho — sempre needsReview.
 */
import { pantryDecisionFor } from '../lib/productsCatalog';
import { makeCtx } from './helpers';

describe('v59 SEM EAN NA TELA — criar produto sem EAN funciona', () => {
  test('Criar produto novo sem EAN (usuário não digita EAN) funciona e EAN fica null', async () => {
    const { services } = await makeCtx();
    const created = await services.products.createManualProduct({ name: 'Banana Prata', baseUnit: 'G' });
    const got: any = await services.products.getProduct(created.id);
    expect(got.ean).toBeNull(); expect(got.name).toBe('Banana Prata');
  });
  test('EAN que vem NA NOTA continua sendo aprendido sozinho (por dentro, sem digitar)', async () => {
    const { services } = await makeCtx();
    const manual = await services.products.createManualProduct({ name: 'Coca-Cola 2L', ean: '7894900011517', baseUnit: 'ML' });
    // Simula NF com EAN: resolve por EAN sem o usuário digitar nada
    const res = await services.products.resolveOrRegister('Assaí', { ean: '7894900011517', storeProductCode: '999', name: 'REFRIGERANTE COCA COLA 2LT' });
    expect(res.matchType).toBe('EAN'); expect(res.product?.id).toBe(manual.id); expect(res.needsReview).toBe(false);
  });
});

describe('v59 FUZZY SÓ SUGERE — nunca unifica sozinho', () => {
  test('Nome IDÊNTICO (100%) NÃO unifica sozinho — vai p/ revisão durante a NF', async () => {
    const { services } = await makeCtx();
    await services.products.createManualProduct({ name: 'Leite Integral Caixa 1L', baseUnit: 'ML' });
    const res = await services.products.resolveOrRegister('Assaí', { ean: null, storeProductCode: null, name: 'LEITE INTEGRAL CAIXA 1L' });
    expect(res.matchType).toBe('FUZZY'); expect(res.needsReview).toBe(true); expect(res.score).toBeGreaterThanOrEqual(0.94);
  });
  test('Nome parecido (fuzzy) NÃO grava alias sozinho — próxima nota continua perguntando até o usuário decidir', async () => {
    const { services } = await makeCtx();
    const manual = await services.products.createManualProduct({ name: 'Banana Prata', baseUnit: 'G' });
    const first = await services.products.resolveOrRegister('Carrefour', { ean: null, storeProductCode: '456', name: 'BANANA PRATA - PESO' });
    expect(first.matchType).toBe('FUZZY'); expect(first.needsReview).toBe(true);
    // Sem decisão do usuário, a 2ª nota com o mesmo código NÃO resolve por alias
    const second = await services.products.resolveOrRegister('Carrefour', { ean: null, storeProductCode: '456', name: 'BANANA PRATA - PESO' });
    expect(second.matchType).toBe('FUZZY'); expect(second.needsReview).toBe(true);
    expect(second.product?.id).toBe(manual.id); // sugere o mesmo, mas não unifica
  });
  test('Depois que o usuário decide (recordDecision), a próxima nota resolve sozinha por código', async () => {
    const { services } = await makeCtx();
    const manual = await services.products.createManualProduct({ name: 'Banana Prata', baseUnit: 'G' });
    await services.products.recordDecision(manual.id, { cnpj: null, storeName: 'Carrefour', storeProductCode: '456', aliasText: 'BANANA PRATA - PESO' });
    const next = await services.products.resolveOrRegister('Carrefour', { ean: null, storeProductCode: '456', name: 'BANANA PRATA - PESO' });
    expect(next.matchType).toBe('ALIAS'); expect(next.needsReview).toBe(false);
  });
});

describe('v59 VINCULAÇÃO DURANTE — 5 SEMPRE + 2 NUNCA (memória da despensa)', () => {
  test('setPantryPolicy durante a vinculação persiste e vale na próxima nota', async () => {
    const { services } = await makeCtx();
    const p = await services.products.createManualProduct({ name: 'Sabão em Pó', baseUnit: 'UN' });
    await services.products.setPantryPolicy(p.id, 'NEVER');
    const got: any = await services.products.getProduct(p.id);
    expect(got.pantry_policy).toBe('NEVER');
    // 2ª nota: NUNCA = pula sem perguntar (decisão fora da tela, na lógica v57)
    expect(pantryDecisionFor({ ...got, pantryPolicy: got.pantry_policy } as any)).toBe('OUT');
  });
});
