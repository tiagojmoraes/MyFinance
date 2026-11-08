/**
 * v41 — QR NO NOVO LANÇAMENTO (pedido do usuário):
 *  · prepareFromHtml NÃO cria lançamento e NÃO aplica estoque — a nota fica
 *    preparada (documento + itens + resolução de produtos) para o FORMULÁRIO;
 *  · attachToTransaction cria o vínculo com o lançamento e aplica estoque
 *    SOMENTE dos itens marcados (os excluídos ficam reversíveis na revisão);
 *  · default de inclusão = canApplyStock && !needsReview ("só pergunta dos
 *    novos" v37 — novo produto/fuzzy baixo NÃO entra no estoque por padrão);
 *  · re-preparar a mesma nota NÃO duplica itens nem cria transação;
 *  · guarda: nota já anexada a um lançamento não vai para outro;
 *  · regressão: processItems (tela NFC-e) segue aplicando estoque automático.
 */

import { makeCtx, seedAccount } from './helpers';
import type { TestCtx } from './helpers';

// ───────────────────────── fixtures (layout por CLASSES da SEFAZ-SP) ─────────────────────────

const CNPJ = '06.057.223/0508-61';

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

const notaHtml = (linhas: string, total = '25,48') => `
<html><body>
<div class="txtTopo">SENDAS DISTRIBUIDORA S/A</div>
<div>Nome Empresarial: SENDAS DISTRIBUIDORA S/A</div>
<div>CNPJ: ${CNPJ}</div>
<div>Data e Hora da Emissão: 31/10/2026 14:20:12</div>
<table id="tabResult"><tbody>${linhas}</tbody></table>
<div>Valor Total: R$ ${total}</div>
<div>Valor Pago: R$ ${total}</div>
</body></html>`;

const KEY = genKey();
/** 3 itens: leite (EAN conhecido), mamão (novo), arroz (EAN de produto UN, item KG). */
const NOTA = notaHtml(
  itemRow('LEITE INTEGRAL CAIXA 1L', '7891000100103', '6', 'UN', '5,99', '35,94') +
    itemRow('MAMAO PAPAYA kg', '8142', '2,616', 'Kg', '5,89', '15,40') +
    itemRow('ARROZ TIPO 1 kg', '7891234500001', '5', 'Kg', '4,53', '22,65'),
  '73,99'
);

let ctx: Awaited<ReturnType<typeof makeCtx>> | null = null;

beforeEach(async () => {
  ctx = await makeCtx();
  // Leite: produto CONHECIDO por EAN → casamento determinístico (auto, sem pergunta)
  await ctx!.services.products.createManualProduct({ name: 'Leite Integral Caixa 1L', ean: '7891000100103', baseUnit: 'UN' });
  // Arroz: produto conhecido por UN — item vem em KG (guarda de dimensão: fora do estoque)
  await ctx!.services.products.createManualProduct({ name: 'Arroz Tipo 1', ean: '7891234500001', baseUnit: 'UN' });
});

// ───────────────────────── 1. prepareFromHtml: nota NO FORMULÁRIO ─────────────────────────

describe('v41 — prepareFromHtml (nota no formulário)', () => {
  test('NÃO cria lançamento, NÃO aplica estoque e devolve itens prontos', async () => {
    const { services, db } = ctx!;
    const res = await services.nfce.prepareFromHtml(KEY, NOTA, null);
    expect(res.alreadyRegistered).toBe(false);
    expect(res.items).toHaveLength(3);
    expect(res.header.storeName).toBe('SENDAS DISTRIBUIDORA S/A');
    expect(res.header.amountPaidCents).toBe(7399);

    // NENHUMA transação foi criada (o lançamento nasce no Salvar do formulário)
    const txCount = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(txCount?.n).toBe(0);

    // Documento preparado (sem transação), itens gravados SEM estoque
    const doc = await db.getFirstAsync<{ parse_status: string; transaction_id: string | null }>(
      'SELECT parse_status, transaction_id FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    expect(doc?.parse_status).toBe('COMPLETE');
    expect(doc?.transaction_id).toBeNull();

    const applied = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM nfce_items WHERE stock_applied = 1'
    );
    expect(applied?.n).toBe(0);

    // Soma dos itens = total da nota (73,99)
    const soma = res.items.reduce((a, b) => a + (b.totalCents ?? 0), 0);
    expect(soma).toBe(7399);
  });

  test('default de inclusão: conhecido entra; novo e choque de unidade ficam de fora', async () => {
    const { services } = ctx!;
    const res = await services.nfce.prepareFromHtml(KEY, NOTA, null);
    const byDesc = (d: string) => res.items.find((i) => i.description?.startsWith(d))!;

    const leite = byDesc('LEITE');
    expect(leite.matchType).toBe('EAN');
    expect(leite.canApplyStock).toBe(true);
    expect(leite.needsReview).toBe(false); // EAN da tabela da verdade → automático

    const mamao = byDesc('MAMAO');
    expect(mamao.matchType).toBe('NEW'); // produto novo criado, mas pergunta 1ª vez
    expect(mamao.canApplyStock).toBe(true);
    expect(mamao.needsReview).toBe(true);

    const arroz = byDesc('ARROZ');
    expect(arroz.unitClash).toBe(true); // KG em produto UN — nunca mistura dimensão
    expect(arroz.canApplyStock).toBe(false);
  });

  test('re-preparar a mesma nota não duplica itens nem cria transação', async () => {
    const { services, db } = ctx!;
    await services.nfce.prepareFromHtml(KEY, NOTA, null);
    const second = await services.nfce.prepareFromHtml(KEY, NOTA, null);
    expect(second.items).toHaveLength(3);
    expect(second.alreadyRegistered).toBe(false);
    const txCount = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(txCount?.n).toBe(0);
    const itemCount = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM nfce_items WHERE access_key = ?',
      [KEY]
    );
    expect(itemCount?.n).toBe(3);
  });

  test('nota JÁ registrada (fluxo automático da tela NFC-e) volta como alreadyRegistered', async () => {
    const { services, db } = ctx!;
    const acc = await seedAccount(db);
    await services.nfce.ingestFromHtml(KEY, NOTA, null); // fluxo antigo: cria a transação
    const res = await services.nfce.prepareFromHtml(KEY, NOTA, null);
    expect(res.alreadyRegistered).toBe(true);
    expect(res.items).toHaveLength(0);
  });
});

// ───────────────────────── 2. attachToTransaction: salvar no formulário ─────────────────────────

describe('v41 — attachToTransaction (salvar lança o total e aplica o estoque marcado)', () => {
  test('lançamento pelo TOTAL da nota + estoque SÓ dos itens incluídos', async () => {
    const { services, db } = ctx!;
    const acc = await seedAccount(db);
    const res = await services.nfce.prepareFromHtml(KEY, NOTA, null);
    const byDesc = (d: string) => res.items.find((i) => i.description?.startsWith(d))!;

    // O que o formulário faria: leite marcado (conhecido), mamão e arroz desmarcados
    const leite = byDesc('LEITE');
    const mamao = byDesc('MAMAO');
    const arroz = byDesc('ARROZ');
    const marcados = [leite.id];

    // Lançamento criado pelo botão Salvar com o TOTAL da nota
    const tx = await services.transactions.createAccountExpense({
      description: 'NFC-e SENDAS DISTRIBUIDORA S/A',
      amountCents: 7399,
      date: '2026-10-31',
      categoryId: null,
      accountId: acc,
    });

    const out = await services.nfce.attachToTransaction(KEY, tx.id, marcados);
    expect(out.applied).toBe(1);

    // Vínculo gravado no documento
    const doc = await db.getFirstAsync<{ transaction_id: string; parse_status: string }>(
      'SELECT transaction_id, parse_status FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    expect(doc?.transaction_id).toBe(tx.id);
    expect(doc?.parse_status).toBe('COMPLETE');

    // Estoque: SÓ o leite (6 UN); mamão e arroz ficam stock_applied = 0
    const leiteId = leite.productId!;
    const leiteStock = await db.getFirstAsync<{ q: number }>(
      'SELECT quantity_base AS q FROM pantry_stock WHERE product_id = ?',
      [leiteId]
    );
    expect(leiteStock?.q).toBe(6);
    const mamaoStock = await db.getFirstAsync<{ q: number }>(
      'SELECT COALESCE(quantity_base, 0) AS q FROM pantry_stock WHERE product_id = ?',
      [mamao.productId!]
    );
    expect(mamaoStock?.q ?? 0).toBe(0); // sem linha no estoque — nada foi aplicado
    const arrozRow = await db.getFirstAsync<{ stock_applied: number }>(
      'SELECT stock_applied FROM nfce_items WHERE id = ?',
      [arroz.id]
    );
    expect(arrozRow?.stock_applied).toBe(0);
    const mamaoRow = await db.getFirstAsync<{ stock_applied: number }>(
      'SELECT stock_applied FROM nfce_items WHERE id = ?',
      [mamao.id]
    );
    expect(mamaoRow?.stock_applied).toBe(0);
  });

  test('item excluído continua reversível: aplicar depois na revisão funciona', async () => {
    const { services, db } = ctx!;
    const acc = await seedAccount(db);
    const res = await services.nfce.prepareFromHtml(KEY, NOTA, null);
    const leite = res.items.find((i) => i.description?.startsWith('LEITE'))!;
    const mamao = res.items.find((i) => i.description?.startsWith('MAMAO'))!;
    const tx = await services.transactions.createAccountExpense({
      description: 'NFC-e',
      amountCents: 7399,
      date: '2026-10-31',
      categoryId: null,
      accountId: acc,
    });
    await services.nfce.attachToTransaction(KEY, tx.id, [leite.id]);
    // Depois o usuário classifica o mamão na revisão e confirma o estoque
    await services.pantry.applyNfceItems(KEY, [mamao.id]);
    const mamaoStock = await db.getFirstAsync<{ q: number }>(
      'SELECT quantity_base AS q FROM pantry_stock WHERE product_id = ?',
      [mamao.productId!]
    );
    expect(mamaoStock?.q).toBeGreaterThan(0);
  });

  test('reanexar os mesmos itens é idempotente (nada duplica no ledger)', async () => {
    const { services, db } = ctx!;
    const acc = await seedAccount(db);
    const res = await services.nfce.prepareFromHtml(KEY, NOTA, null);
    const leite = res.items.find((i) => i.description?.startsWith('LEITE'))!;
    const tx = await services.transactions.createAccountExpense({
      description: 'NFC-e',
      amountCents: 7399,
      date: '2026-10-31',
      categoryId: null,
      accountId: acc,
    });
    await services.nfce.attachToTransaction(KEY, tx.id, [leite.id]);
    const again = await services.nfce.attachToTransaction(KEY, tx.id, [leite.id]);
    expect(again.applied).toBe(0);
    const ledger = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM pantry_ledger WHERE nfce_item_id = ?',
      [leite.id]
    );
    expect(ledger?.n).toBe(1);
  });

  test('guarda: nota anexada a um lançamento NÃO vai para outro', async () => {
    const { services, db } = ctx!;
    const acc = await seedAccount(db);
    const res = await services.nfce.prepareFromHtml(KEY, NOTA, null);
    const tx1 = await services.transactions.createAccountExpense({
      description: 'Compra 1', amountCents: 7399, date: '2026-10-31', categoryId: null, accountId: acc,
    });
    await services.nfce.attachToTransaction(KEY, tx1.id, []);
    const tx2 = await services.transactions.createAccountExpense({
      description: 'Compra 2', amountCents: 7399, date: '2026-10-31', categoryId: null, accountId: acc,
    });
    await expect(services.nfce.attachToTransaction(KEY, tx2.id, [])).rejects.toThrow(/outro lançamento/i);
  });
});

// ───────────────────────── 3. regressão: fluxo automático da tela NFC-e ─────────────────────────

describe('v41 — regressão do fluxo automático (tela NFC-e)', () => {
  test('ingestFromHtml + processItems continuam criando lançamento e aplicando estoque', async () => {
    const { services, db } = ctx!;
    const res = await services.nfce.ingestFromHtml(KEY, NOTA, null);
    expect(res.created).toBe(true);
    const proc = await services.nfce.processItems(KEY, NOTA);
    // Só o leite é confiável no ctx novo (mamão = novo, arroz = choque de unidade)
    expect(proc.items).toBe(3);
    expect(proc.appliedToStock).toBe(1);
    const txCount = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(txCount?.n).toBe(1);
    const doc = await db.getFirstAsync<{ transaction_id: string | null }>(
      'SELECT transaction_id FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    expect(doc?.transaction_id).not.toBeNull();
  });
});
