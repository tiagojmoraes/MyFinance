/** v26 — NFC-e (layout público atual da SEFAZ-SP) + saldo do dia/todaySP. */
import { parseNfceItems, parseNfceHeader, pageHasItems } from '../parsers/nfce';
import { todaySP, spDateOfIso } from '../lib/dates';
import { makeCtx } from './helpers';
import { enqueueLoad } from '../lib/loadQueue';

const KEY = '3'.repeat(44);
const REAL = `<html><body>
<div id="u20" class="txtTopo">SUPERMERCADO EXEMPLO LTDA</div>
<div class="text">CNPJ: 12.345.678/0001-90</div>
<table id="tabResult">
<tr id="Item + 1"><td><span class="txtTit">LEITE INTEGRAL 1L</span><span class="RCod">(Código: 7894900011517 )</span><br/><span class="Rqtd"><strong>Qtde.:</strong>2,0000</span><span class="RUN"><strong>UN: </strong>UN</span><span class="RvlUnit"><strong>Vl. Unit.:</strong>&nbsp;&nbsp;4,99</span></td><td class="txtTit noWrap">Vl. Total<br/><span class="valor">9,98</span></td></tr>
<tr id="Item + 2"><td><span class="txtTit">ARROZ 5KG</span><span class="RCod">(Código: 123 )</span><br/><span class="Rqtd"><strong>Qtde.:</strong>1,0000</span><span class="RUN"><strong>UN: </strong>UN</span><span class="RvlUnit"><strong>Vl. Unit.:</strong>&nbsp;&nbsp;25,90</span></td><td class="txtTit noWrap">Vl. Total<br/><span class="valor">25,90</span></td></tr>
</table>
<div id="totalNota"><label>Valor a pagar R$:</label><span class="totalNumb txtMax">35,88</span></div>
</body></html>`;

describe('v26 — NFC-e layout público da SEFAZ-SP', () => {
  test('itens com valor, unidade, EAN e código da loja', () => {
    const items = parseNfceItems(REAL);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ description: 'LEITE INTEGRAL 1L', eanExtracted: '7894900011517', qty: 2, unitOriginal: 'UN', totalCents: 998 });
    expect(items[1]).toMatchObject({ description: 'ARROZ 5KG', eanExtracted: null, storeProductCode: '123', qty: 1, totalCents: 2590 });
  });
  test('cabeçalho: estabelecimento, CNPJ e total', () => {
    const h = parseNfceHeader(REAL, KEY);
    expect(h.storeName).toBe('SUPERMERCADO EXEMPLO LTDA');
    expect(h.cnpj).toBe('12.345.678/0001-90');
    expect(h.grossTotalCents).toBe(3588);
  });
  test('pageHasItems distingue só-cabeçalho de nota completa', () => {
    expect(pageHasItems(REAL)).toBe(true);
    expect(pageHasItems('<html><body>NFC-e CNPJ 12.345.678/0001-90 Valor Total R$ 10,00</body></html>')).toBe(false);
  });
  test('reprocessar completa campos vazios sem duplicar itens', async () => {
    const { db, services } = await makeCtx();
    await db.runAsync(
      "INSERT INTO nfce_documents (access_key, parse_status, needs_review, discount_cents) VALUES (?, 'PENDING', 0, 0)",
      [KEY]
    );
    await db.runAsync(
      "INSERT INTO nfce_items (id, access_key, line_number, description, qty, total_cents, status, stock_applied) VALUES ('i1', ?, 1, 'LEITE INTEGRAL 1L', 2, NULL, 'PARSED', 0)",
      [KEY]
    );
    await services.nfce.processItems(KEY, REAL);
    const rows = await db.getAllAsync<{ line_number: number; total_cents: number | null; unit_original: string | null }>(
      'SELECT line_number, total_cents, unit_original FROM nfce_items WHERE access_key = ? ORDER BY line_number', [KEY]
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].total_cents).toBe(998);
    expect(rows[0].unit_original).toBe('UN');
  });
});

describe('v26 — todaySP', () => {
  test('formato YYYY-MM-DD e fuso de São Paulo (21h–24h BRT ainda é o mesmo dia)', () => {
    expect(todaySP()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(spDateOfIso('2026-11-03T01:30:00.000Z')).toBe('2026-11-02'); // 22h30 BRT
    expect(spDateOfIso('2026-11-03T03:00:00.000Z')).toBe('2026-11-03'); // 00h00 BRT
  });
});

describe('v26 — fila global de cargas (uma por vez)', () => {
  test('cargas nunca se sobrepõem e respeitam a ordem', async () => {
    let running = 0, maxRunning = 0;
    const order: number[] = [];
    const mk = (n: number, ms: number) => () => new Promise<void>((res) => {
      running++; maxRunning = Math.max(maxRunning, running);
      setTimeout(() => { running--; order.push(n); res(); }, ms);
    });
    await Promise.all([enqueueLoad(mk(1, 30)), enqueueLoad(mk(2, 5)), enqueueLoad(mk(3, 10))]);
    expect(maxRunning).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('v26 — crédito parcelado e mês da fatura (Fixo/Parcelado no cartão)', () => {
  const { seedAccount, seedCard } = jest.requireActual('./helpers') as typeof import('./helpers');
  const invoicesOf = async (db: any) =>
    db.getAllAsync("SELECT reference_month rm, total_cents tot FROM invoices ORDER BY rm") as Promise<Array<{ rm: string; tot: number }>>;

  test('parcelado no cartão com mês da fatura escolhido: 1ª parcela na fatura pedida, demais mês a mês', async () => {
    const { db, services } = await makeCtx();
    const acc = await seedAccount(db, 'A', 0);
    const card = await seedCard(db, acc, 'C', 15, 25);
    await services.installments.createPlan({
      description: 'tv', mode: 'DIVIDE_TOTAL', totalCents: 30000, totalInstallments: 3,
      firstDueDate: '2027-03-05', purchaseDate: '2027-03-05', cardId: card, firstInvoiceMonth: '2027-05',
    } as never);
    expect(await invoicesOf(db)).toEqual([
      { rm: '2027-05', tot: 10000 }, { rm: '2027-06', tot: 10000 }, { rm: '2027-07', tot: 10000 },
    ]);
  });

  test('parcelado sem mês escolhido mantém a regra de corte (compatível)', async () => {
    const { db, services } = await makeCtx();
    const acc = await seedAccount(db, 'A', 0);
    const card = await seedCard(db, acc, 'C', 15, 25);
    await services.installments.createPlan({
      description: 'tv', mode: 'DIVIDE_TOTAL', totalCents: 20000, totalInstallments: 2,
      firstDueDate: '2027-03-05', purchaseDate: '2027-03-05', cardId: card,
    } as never);
    expect((await invoicesOf(db)).map((i) => i.rm)).toEqual(['2027-03', '2027-04']);
  });

  test('CRÉDITO parcelado: em conta vira crédito; no cartão abate a fatura', async () => {
    const { db, services } = await makeCtx();
    const acc = await seedAccount(db, 'A', 0);
    const card = await seedCard(db, acc, 'C', 15, 25);
    await services.installments.createPlan({
      description: 'aluguel', mode: 'FIXED_PER_MONTH', fixedAmountCents: 100000, totalInstallments: 2,
      firstDueDate: '2027-03-05', accountId: acc, type: 'INCOME',
    } as never);
    const dirs = await db.getAllAsync<{ d: string }>("SELECT DISTINCT direction d FROM financial_moves WHERE installment_id IS NOT NULL");
    expect(dirs.map((x) => x.d)).toEqual(['CREDIT']);
    await services.installments.createPlan({
      description: 'estorno', mode: 'FIXED_PER_MONTH', fixedAmountCents: 5000, totalInstallments: 2,
      firstDueDate: '2027-03-05', cardId: card, type: 'INCOME',
    } as never);
    expect((await invoicesOf(db)).every((i) => i.tot === -5000)).toBe(true);
  });

  test('fixa no cartão com mês da fatura escolhido: todas as ocorrências deslocadas', async () => {
    const { db, services } = await makeCtx();
    const acc = await seedAccount(db, 'A', 0);
    const card = await seedCard(db, acc, 'C', 15, 25);
    await services.recurrences.createRule({
      description: 'streaming', type: 'EXPENSE', amountCents: 5000, dayOfMonth: 5,
      startDate: '2027-03-05', cardId: card, invoiceMonth: '2027-04', // corte padrão seria 2027-03 → +1
    } as never);
    await services.recurrences.ensureForecastThrough('2027-06');
    const rms = (await invoicesOf(db)).map((i) => i.rm);
    expect(rms.slice(0, 3)).toEqual(['2027-04', '2027-05', '2027-06']);
    expect(rms).not.toContain('2027-03');
  });
});

describe('v26 — plugin SSL da SEFAZ-SP', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const plugin = require('../../plugins/withWebViewSefazSsl');
  const fs = require('fs');
  const java = fs.readFileSync(
    require('path').join(__dirname, '../../node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebViewClient.java'),
    'utf8'
  );
  test('injeta a exceção antes do cancelamento e é idempotente', () => {
    const out = plugin.patchJava(java);
    expect(out).toContain(plugin.MARKER);
    expect(out.indexOf('handler.proceed()')).toBeLessThan(out.indexOf('handler.cancel()'));
    expect(out).toContain('SSL_UNTRUSTED');
    expect(out).toContain('.fazenda.sp.gov.br');
    expect(plugin.patchJava(out)).toBe(out);
    expect((out.match(/handler\.proceed\(\);\n\s+return;/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });
});
