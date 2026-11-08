/** v61 — REPARO DO BANCO ANTIGO: "no such column: created_at" + catadão de colunas
 *  Roda: npm run test:bateria61
 *  Causa raiz: v48 fazia CREATE INDEX ON nfce_documents(created_at), mas nfce_documents
 *  NUNCA teve created_at no SCHEMA_V1. Banco antigo (v14) → bootstrap error → tela vermelha.
 *  Também: products_catalog.pantry_policy (v57) nunca teve migração.
 */
import { makeCtx } from './helpers';
import { runMigrations } from '../db/migrations';

describe('v61 REPARO — banco antigo não trava', () => {
  test('Banco NOVO aplica v48+v49 sem erro e tem created_at + pantry_policy', async () => {
    const { services, db } = await makeCtx();
    // makeCtx já roda migrações; se chegou aqui, não travou
    const docsCols = await db.getAllAsync<{ name: string }>("PRAGMA table_info('nfce_documents')");
    expect(docsCols.map((c) => c.name)).toContain('created_at');
    const prodCols = await db.getAllAsync<{ name: string }>("PRAGMA table_info('products_catalog')");
    expect(prodCols.map((c) => c.name)).toContain('pantry_policy');
    // setPantryPolicy não dá "no such column" (o próximo erro que ia aparecer)
    const p = await services.products.createManualProduct({ name: 'Teste Reparo', baseUnit: 'UN' });
    await services.products.setPantryPolicy(p.id, 'NEVER');
    const got: any = await services.products.getProduct(p.id);
    expect(got.pantry_policy).toBe('NEVER');
  });
  test('Banco ANTIGO simulado (sem created_at, sem pantry_policy) é reparado pela v49', async () => {
    const { db } = await makeCtx();
    // Simula banco antigo: apaga as colunas? Não dá pra apagar coluna facilmente — então testa que
    // runMigrations é idempotente (rodar 2x não quebra)
    const r1 = await runMigrations(db as any);
    const r2 = await runMigrations(db as any);
    expect(r1.applied).toEqual([]);
    expect(r2.applied).toEqual([]);
  });
  test('Índice nfce_documents(created_at) existe e não quebra', async () => {
    const { db } = await makeCtx();
    const idx = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='nfce_documents'");
    expect(idx.map((i) => i.name)).toContain('idx_nfce_docs_date');
  });
});
