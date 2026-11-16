/**
 * v87 — DESPENSA e CATEGORIAS: limite mínimo que pode ser DESATIVADO, exclusão
 * de categoria com orçamento (chave estrangeira) e reparenting.
 *
 *  · `setLowThreshold(id, null)` agora limpa o limite (antes o COALESCE do
 *    upsert mantinha o valor antigo e o alerta de "abaixo do mínimo" era
 *    eterno — o produto voltava para a lista de compra para sempre);
 *  · categoria em uso por ORÇAMENTO não pode ser excluída (a guarda contava
 *    apenas lançamentos/produtos/subcategorias/fixas → erro cru de FK);
 *  · mover uma categoria que já tem filhas é bloqueado (evita hierarquia de
 *    2 níveis, que o arquivamento em cascata não alcança).
 */

import { makeCtx } from '../helpers';

describe('v87 — despensa: limite mínimo pode ser limpo', () => {
  test('setLowThreshold(null) REMOVE o limite (produto sai de "abaixo do mínimo")', async () => {
    const { db, services } = await makeCtx();
    const prod = await services.products.createManualProduct({ name: 'Arroz', baseUnit: 'G' });
    // limite de 500 g
    await services.pantry.setLowThreshold(prod.id, 500);
    let linha = await db.getFirstAsync<{ low_threshold_base: number | null }>(
      'SELECT low_threshold_base FROM pantry_stock WHERE product_id = ?',
      [prod.id]
    );
    expect(linha?.low_threshold_base).toBe(500);

    // v87: limpar o limite (a tela manda null quando o usuário apaga o campo)
    await services.pantry.setLowThreshold(prod.id, null);
    linha = await db.getFirstAsync<{ low_threshold_base: number | null }>(
      'SELECT low_threshold_base FROM pantry_stock WHERE product_id = ?',
      [prod.id]
    );
    expect(linha?.low_threshold_base ?? null).toBeNull();
  });

  test('setar um limite novo continua funcionando (não some ao gravar)', async () => {
    const { db, services } = await makeCtx();
    const prod = await services.products.createManualProduct({ name: 'Feijão', baseUnit: 'G' });
    await services.pantry.setLowThreshold(prod.id, 300);
    await services.pantry.setLowThreshold(prod.id, 700);
    const linha = await db.getFirstAsync<{ low_threshold_base: number | null }>(
      'SELECT low_threshold_base FROM pantry_stock WHERE product_id = ?',
      [prod.id]
    );
    expect(linha?.low_threshold_base).toBe(700);
  });
});

describe('v87 — categorias: orçamento e hierarquia', () => {
  test('categoria com ORÇAMENTO não pode ser excluída (mensagem amigável)', async () => {
    const { services } = await makeCtx();
    const cat = await services.categories.create({ name: 'Mercado', direction: 'DEBIT', icon: '🛒', parentId: null });
    await services.budgets.save(cat.id, 100_000);
    const uso = await services.categories.usageCount(cat.id);
    expect(uso.budgets).toBe(1);
    await expect(services.categories.remove(cat.id)).rejects.toThrow(/em uso/i);
  });

  test('mover uma categoria que JÁ tem subcategorias é bloqueado', async () => {
    const { services } = await makeCtx();
    const pai = await services.categories.create({ name: 'Pai', direction: 'DEBIT', icon: '📁', parentId: null });
    const outro = await services.categories.create({ name: 'Outro', direction: 'DEBIT', icon: '📁', parentId: null });
    await services.categories.create({ name: 'Filha', direction: 'DEBIT', icon: '📄', parentId: pai.id });
    await expect(services.categories.update(pai.id, { parentId: outro.id })).rejects.toThrow(/subcategorias/i);
  });
});
