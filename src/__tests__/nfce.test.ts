/** Fase 4 — NFC-e: Header First (ARQ-008), idempotência, resolução e estoque. */

import { makeCtx, expectRejects } from './helpers';
import {
  accessKeyDv,
  checkAccessKey,
  extractAccessKey,
  parseNfceHeader,
  parseNfceItems,
  convertToBaseUnit,
} from '../parsers/nfce';

const NFC_HTML = `
<html><body>
<table><tr><td>
<span class="label">Nome de Fantasia</span><span class="text">MERCADO EXEMPLO LTDA</span>
<span class="label">Data e Hora da Emissão</span><span class="text">10/05/2026 14:32:11</span>
<span class="label">Valor Total</span><span class="text">R$ 87,90</span>
<span class="label">Valor Pago</span><span class="text">R$ 90,00</span>
</td></tr></table>
<table>
<tr><td><span class="txtTit">LEITE INTEGRAL 1L</span><span class="txtCod">Código do produto: 7894900011517</span>
<span class="Rqtd">Qtde total de itens: 2</span><span class="RUN">Unidade comercial: UN</span><span class="valor">Valor total do item: R$ 15,98</span></td></tr>
<tr><td><span class="txtTit">SABONETE DOVE 90G</span><span class="txtCod">Código do produto: 1234-AB</span>
<span class="Rqtd">Qtde total de itens: 3</span><span class="RUN">Unidade comercial: UN</span><span class="valor">Valor total do item: R$ 14,97</span></td></tr>
</table>
</body></html>`;

const KEY = '35260514214169000187650010000012341234567890';

describe('NfceService — ARQ-008', () => {
  test.each([
    ['65', true],
    ['55', false],
  ])('mantém contrato dos campos da chave no layout modelo %s', (model, expectedOk) => {
    const key43 = `35260514214169000187${model}001000001234112345678`;
    const key = `${key43}${accessKeyDv(key43)}`;
    const checked = checkAccessKey(key);

    expect(key).toHaveLength(44);
    expect(checked.modelo).toBe(model);
    expect(checked.ufCode).toBe('35');
    expect(checked.year).toBe(2026);
    expect(checked.month).toBe(5);
    expect(checked.ok).toBe(expectedOk);
    expect(extractAccessKey(`https://sefaz.example/consulta?p=${key}|2|1`)).toBe(key);
  });

  test('extrai chave de 44 dígitos de URL de QR Code', async () => {
    const url = `https://nfce.fazenda.sp.gov.br/consultacompleta.aspx?chaveAcesso=${KEY}`;
    expect(extractAccessKey(url)).toBe(KEY);
    const pUrl = `https://www.sefaz.ms.gov.br/portalNFENacional/qrcode?p=${KEY}|2|1|1|87.90`;
    expect(extractAccessKey(pUrl)).toBe(KEY);
    expect(extractAccessKey(KEY)).toBe(KEY);
    expect(extractAccessKey('lixo sem chave')).toBeNull();
  });

  // v23: timeout maior — o teste espera uma FALHA de rede real (sem servidor);
  // sob paralelismo do jest a falha pode demorar mais que o padrão de 5s.
  test('processItems com falha de rede NÃO derruba transação (desacoplamento)', async () => {
    const { services } = await makeCtx();
    // Sem servidor: fetch falha -> documento PENDING, sem transação (retry depois)
    const result = await services.nfce.ingestFromQrOrKey(KEY);
    expect(result.created).toBe(false);
    const doc = await services.db.getFirstAsync<{ parse_status: string }>(
      'SELECT parse_status FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    expect(doc?.parse_status).toBe('PENDING');
  }, 20000);

  test('parseNfceHeader extrai loja, data e valores do HTML SP', async () => {
    const header = parseNfceHeader(NFC_HTML, KEY);
    expect(header.storeName).toBe('MERCADO EXEMPLO LTDA');
    expect(header.grossTotalCents).toBe(8790);
    expect(header.amountPaidCents).toBe(9000);
    expect(header.issuedAt).toBeTruthy();
  });

  test('parseNfceItems extrai itens com EAN, qty e unidade', async () => {
    const items = parseNfceItems(NFC_HTML);
    expect(items.length).toBeGreaterThanOrEqual(2);
    const leite = items.find((i) => i.description?.includes('LEITE'));
    expect(leite?.eanExtracted).toBe('7894900011517');
    expect(leite?.qty).toBe(2);
    expect(leite?.totalCents).toBe(1598);
  });

  test('conversão de unidades para base (G/ML/UN)', async () => {
    expect(convertToBaseUnit(1, 'KG')).toEqual({ deltaBase: 1000, baseUnit: 'G' });
    expect(convertToBaseUnit(0.5, 'L')).toEqual({ deltaBase: 500, baseUnit: 'ML' });
    expect(convertToBaseUnit(3, 'UN')).toEqual({ deltaBase: 3, baseUnit: 'UN' });
    expect(convertToBaseUnit(2, 'PAR')).toBeNull();
  });
});

describe('PantryService — cache atômico', () => {
  test('ledger e stock sempre consistentes; consumo impede negativo', async () => {
    const { services } = await makeCtx();
    const product = await services.products.createManualProduct({ name: 'Arroz 5kg', baseUnit: 'G' });
    await services.pantry.registerManualMovement({ productId: product.id, deltaBase: 5000, reason: 'PURCHASE_MANUAL' });
    await services.pantry.registerManualMovement({ productId: product.id, deltaBase: -1500, reason: 'CONSUMPTION' });
    const pantry = await services.pantry.listPantry();
    expect(pantry[0].quantity_base).toBe(3500);
    await expect(
      services.pantry.registerManualMovement({ productId: product.id, deltaBase: -99999, reason: 'CONSUMPTION' })
    ).rejects.toThrow(/negativo/);
  });

  test('applyNfceItems é idempotente (UNIQUE nfce_item_id)', async () => {
    const { services } = await makeCtx();
    const product = await services.products.createManualProduct({ name: 'Óleo de Soja 900ml', baseUnit: 'ML' });
    // Simula item NFC-e já resolvido
    await services.db.runAsync(
      "INSERT INTO nfce_documents (access_key, parse_status) VALUES (?, 'COMPLETE')",
      [KEY]
    );
    await services.db.runAsync(
      "INSERT INTO nfce_items (id, access_key, line_number, description, qty, unit_original, product_id, status, stock_applied) VALUES (?,?,1,'OLEO SOJA 900ML',900,'ML',?,'PARSED',0)",
      [`item-1-${Math.random()}`, KEY, product.id]
    );
    const applied1 = await services.pantry.applyNfceItems(KEY);
    const applied2 = await services.pantry.applyNfceItems(KEY);
    expect(applied1).toBe(1);
    expect(applied2).toBe(0);
    const pantry = await services.pantry.listPantry();
    expect(pantry[0].quantity_base).toBe(900);
  });

  test('recompute reconstrói o cache a partir do ledger', async () => {
    const { services } = await makeCtx();
    const product = await services.products.createManualProduct({ name: 'Feijão 1kg', baseUnit: 'G' });
    await services.pantry.registerManualMovement({ productId: product.id, deltaBase: 1000, reason: 'PURCHASE_MANUAL' });
    await services.pantry.registerManualMovement({ productId: product.id, deltaBase: -200, reason: 'WASTE' });
    // Corrompe cache de propósito
    await services.db.runAsync('UPDATE pantry_stock SET quantity_base = 777 WHERE product_id = ?', [product.id]);
    const fixed = await services.pantry.recomputeProduct(product.id);
    expect(fixed).toBe(800);
  });

  test('estoque baixo marcado corretamente', async () => {
    const { services } = await makeCtx();
    const product = await services.products.createManualProduct({ name: 'Sal 1kg', baseUnit: 'G' });
    await services.pantry.registerManualMovement({ productId: product.id, deltaBase: 300, reason: 'PURCHASE_MANUAL' });
    await services.pantry.setLowThreshold(product.id, 500);
    const pantry = await services.pantry.listPantry();
    expect(pantry[0].isLow).toBe(true);
  });
});
