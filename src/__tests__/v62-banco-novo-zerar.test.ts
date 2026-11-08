/** v62 — BANCO NOVO JÁ NASCE CERTO + ZERAR TUDO
 *  Roda: npm run test:bateria62
 *  - SCHEMA_V1 já inclui created_at, pantry_policy, cnpj, match_type, etc. (banco novo não precisa de reparo)
 *  - zerarTudo apaga tudo e deixa o banco como novo
 */
import { zerarTudo } from '../db/seed';
import { makeCtx } from './helpers';

describe('v62 BANCO NOVO + ZERAR TUDO', () => {
  test('Banco novo já tem created_at + pantry_policy sem precisar de migração de reparo', async () => {
    const { db } = await makeCtx();
    const docs = await db.getAllAsync<{ name: string }>("PRAGMA table_info('nfce_documents')");
    expect(docs.map((c) => c.name)).toContain('created_at');
    expect(docs.map((c) => c.name)).toContain('cnpj');
    const prod = await db.getAllAsync<{ name: string }>("PRAGMA table_info('products_catalog')");
    expect(prod.map((c) => c.name)).toContain('pantry_policy');
    const alias = await db.getAllAsync<{ name: string }>("PRAGMA table_info('product_aliases')");
    expect(alias.map((c) => c.name)).toContain('cnpj');
  });
  test('zerarTudo apaga tudo e o banco volta a funcionar', async () => {
    const { db, services } = await makeCtx();
    await services.products.createManualProduct({ name: 'Produto Teste Zerar', baseUnit: 'UN' });
    await zerarTudo(db as any);
    const prods = await db.getAllAsync<any>('SELECT * FROM products_catalog');
    expect(prods).toEqual([]);
    // Depois de zerar, criar de novo funciona (banco não ficou quebrado)
    const p2 = await services.products.createManualProduct({ name: 'Depois do Zerar', baseUnit: 'UN' });
    expect(p2.id).toBeTruthy();
  });
});
