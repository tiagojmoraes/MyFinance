/** Fase 4 — Hierarquia de resolução de produtos (v7): EAN > Alias > Fuzzy > Novo. */

import { makeCtx } from './helpers';
import { ProductAliasRepo } from '../repos/catalog';

describe('ProductService — hierarquia v7', () => {
  test('Passo 1: match exato por EAN vence tudo', async () => {
    const { services } = await makeCtx();
    const manual = await services.products.createManualProduct({ name: 'Coca-Cola 2L', ean: '7894900011517', baseUnit: 'ML' });
    const res = await services.products.resolveOrRegister('Assaí', {
      ean: '7894900011517', storeProductCode: '999', name: 'REFRIGERANTE COCA COLA 2LT',
    });
    expect(res.matchType).toBe('EAN');
    expect(res.product?.id).toBe(manual.id);
    expect(res.needsReview).toBe(false);
  });

  test('Passo 2: alias (loja, código interno) vence e é criado automaticamente no passo 4', async () => {
    const { services } = await makeCtx();
    const manual = await services.products.createManualProduct({ name: 'Arroz Tio João 5kg', baseUnit: 'G' });
    // Primeira resolução de um item sem EAN: cria novo (passo 4) e grava alias da loja
    const first = await services.products.resolveOrRegister('Pão de Açúcar', {
      ean: null, storeProductCode: 'A-777', name: 'ARROZ INTEGRAL TYPE 1 PACOTE GRANDE 5K',
    });
    expect(first.matchType).toBe('NEW');
    // Segunda resolução com o MESMO código da loja: passo 2 (alias) vence, mesmo que fuzzy também batesse
    const second = await services.products.resolveOrRegister('Pão de Açúcar', {
      ean: null, storeProductCode: 'A-777', name: 'ARROZ INTEGRAL TYPE 1 PACOTE GRANDE 5K',
    });
    expect(second.matchType).toBe('ALIAS');
    expect(second.product?.id).toBe(first.product?.id);
    // Alias apontando para produto manual também resolve no passo 2
    const aliases = new ProductAliasRepo(services.db);
    await aliases.ensureStoreCodeAlias(manual.id, 'Pão de Açúcar', 'A-999');
    const third = await services.products.resolveOrRegister('Pão de Açúcar', {
      ean: null, storeProductCode: 'A-999', name: 'QUALQUER COISA DIFERENTE',
    });
    expect(third.matchType).toBe('ALIAS');
    expect(third.product?.id).toBe(manual.id);
  });

  test('Passo 3 v37: nome IDÊNTICO unifica sozinho (sem perguntar) e grava a decisão', async () => {
    const { services } = await makeCtx();
    await services.products.createManualProduct({ name: 'Leite Integral Caixa 1L', baseUnit: 'ML' });
    const res = await services.products.resolveOrRegister('Assaí', {
      ean: null, storeProductCode: null, name: 'LEITE INTEGRAL CAIXA 1L',
    });
    expect(res.matchType).toBe('FUZZY');
    expect(res.product?.name).toBe('Leite Integral Caixa 1L');
    // v59: fuzzy SÓ SUGERE — mesmo com 100%, vai p/ revisão durante a NF (nunca unifica sozinho)
    expect(res.needsReview).toBe(true);
    expect(res.score).toBeGreaterThanOrEqual(0.94);
  });

  test('Passo 3 v37: parecido mas não idêntico PERGUNTA (zona de revisão)', async () => {
    const { services } = await makeCtx();
    await services.products.createManualProduct({ name: 'Leite Integral Caixa 1L', baseUnit: 'ML' });
    const res = await services.products.resolveOrRegister(null, {
      ean: null, storeProductCode: null, name: 'LEITE INTEGRAL CAIXA 1L DESLACTOSADO',
    });
    expect(res.matchType).toBe('FUZZY');
    expect(res.product?.name).toBe('Leite Integral Caixa 1L');
    expect(res.needsReview).toBe(true); // score ~0.88 (zona 0.84–0.94): confirma antes
  });

  test('Passo 3 v37: variedades DIFERENTES não unificam (Manga Palmer × Manga Tommy)', async () => {
    const { services } = await makeCtx();
    await services.products.createManualProduct({ name: 'Manga Palmer', baseUnit: 'G' });
    const res = await services.products.resolveOrRegister(null, {
      ean: null, storeProductCode: null, name: 'MANGA TOMMY KG',
    });
    expect(res.matchType).toBe('NEW');
    expect(res.product?.name).toBe('MANGA TOMMY KG');
    expect(res.needsReview).toBe(true); // novo produto: pergunta 1ª vez
  });

  test('Passo 3: nome diferente demais NÃO faz fuzzy (threshold da spec)', async () => {
    const { services } = await makeCtx();
    await services.products.createManualProduct({ name: 'Leite Integral Caixa 1L' });
    const res = await services.products.resolveOrRegister('Assaí', {
      ean: null, storeProductCode: null, name: 'SABONETE DOVE PELE SUAVE 90G',
    });
    expect(res.matchType).toBe('NEW');
  });

  test('Passo 4: novo produto com origin NFCE e EAN preservado', async () => {
    const { services } = await makeCtx();
    const res = await services.products.resolveOrRegister('Extra', {
      ean: '7891234567890', storeProductCode: 'X-1', name: 'BISCOITO RECHEADO',
    });
    expect(res.matchType).toBe('NEW');
    expect(res.product?.origin).toBe('NFCE');
    expect(res.product?.ean).toBe('7891234567890');
    // Alias da loja criado no passo 4
    const alias = await services.db.getFirstAsync(
      'SELECT * FROM product_aliases WHERE store_name = ? AND store_product_code = ?',
      ['Extra', 'X-1']
    );
    expect(alias).toBeTruthy();
  });

  test('normalização: acentos e maiúsculas não impedem fuzzy', async () => {
    const { services } = await makeCtx();
    await services.products.createManualProduct({ name: 'Açúcar Refinado União 1kg' });
    const res = await services.products.resolveOrRegister(null, {
      ean: null, storeProductCode: null, name: 'ACUCAR REFINADO UNIAO 1KG',
    });
    expect(res.matchType).toBe('FUZZY');
  });

  test('segunda resolução fuzzy reutiliza o vínculo criado (alias textual)', async () => {
    const { services } = await makeCtx();
    await services.products.createManualProduct({ name: 'Café Pilão 500g' });
    const first = await services.products.resolveOrRegister('Hiper', {
      ean: null, storeProductCode: null, name: 'CAFE PILAO 500G',
    });
    // v59: fuzzy SÓ SUGERE — mesmo idêntico após normalizar, vai p/ revisão (nunca unifica sozinho)
    expect(first.needsReview).toBe(true);
    // Após o vínculo textual, a próxima busca continua FUZZY (alias_text armazenado)
    const second = await services.products.resolveOrRegister('Hiper', {
      ean: null, storeProductCode: null, name: 'CAFE PILAO 500G',
    });
    expect(second.product?.id).toBe(first.product?.id);
  });
});
