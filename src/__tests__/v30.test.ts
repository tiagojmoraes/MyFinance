/**
 * v30 — NFC-e LAYOUT AXURE (página de consulta por QR da SEFAZ-SP).
 *
 * O portal da SEFAZ-SP entrega a nota em DOIS layouts:
 *  · CLÁSSICO (NFCeConsultaPublica): classes txtTopo/txtTit/Rqtd/RvlUnit —
 *    já coberto desde v18/v26;
 *  · AXURE (ConsultaQRCode, gerado pelo Axure RP): dados em <div id='uNN'> —
 *    u20_div (estabelecimento), u25 (CNPJ), u40 (número/série/emissão),
 *    u45 (valor a pagar), u60 (forma de pagamento) — e ITENS na
 *    <table id='grdItens'> com 2 células por linha. É o layout do documento
 *    técnico do usuário; até a v29 o app não o lia ("nunca dá certo").
 *
 * Fixture construída a partir da documentação técnica recebida (tags, ids e
 * conteúdos reais — SENDAS DISTRIBUIDORA / 06.057.223/0508-61 / 131,47).
 */
import {
  parseNfceHeader,
  parseNfceItems,
  parseNfceItemsAxure,
  isAxureNfcePage,
  looksLikeNfcePage,
  pageHasItems,
  isFirewallRejectionPage,
} from '../parsers/nfce';

const KEY = '3'.repeat(44);

/** Layout Axure com aspas SIMPLES e sufixo _div (formato real do portal). */
const AXURE = `<!DOCTYPE html>
<html>
<head><title>Consulta Pública da NFC-e</title></head>
<body>
<div id='u20_div' class='ax_default box_1'>SENDAS DISTRIBUIDORA S/A</div>
<div id='u25' class='ax_default box_1'>CNPJ: 06.057.223/0508-61</div>
<div id='u40' class='ax_default box_1'>Número: 65163 Série: 2 Emissão: 31/10/2026 14:20:12</div>
<div id='u50' class='ax_default box_1'>13526007496549386 31/10/2026 14:20:14</div>
<div id='u45' class='ax_default box_1'>Valor a pagar R$:131,47</div>
<div id='u60' class='ax_default box_1'>Cartão de Crédito 131,47</div>
<table id='grdItens'><tbody>
<tr><td>Descrição</td><td>Vl. Total</td></tr>
<tr><td>MAMAO PAPAYA kg<br>(Código: 8142)<br><b>Qtde.:</b> 2,616 <b>UN:</b> Kg <b>Vl. Unit.:</b> 5,89</td><td>Vl. Total<br>15,40</td></tr>
<tr><td>LEITE CONDENSADO CAIXA 395G<br>(Código: 7894900011517)<br><b>Qtde.:</b> 2 <b>UN:</b> UN <b>Vl. Unit.:</b> 8,49</td><td>Vl. Total<br>16,98</td></tr>
<tr><td>SACOLA PLASTICA<br>(Código: 95)<br><b>Qtde.:</b> 3 <b>UN:</b> UN <b>Vl. Unit.:</b> 0,25</td><td>Vl. Total<br></td></tr>
</tbody></table>
</body>
</html>`;

/** Mesma página com aspas DUPLAS e id sem sufixo (variação tolerada). */
const AXURE_DQ = AXURE
  .replace(/id='u20_div'/, 'id="u20"')
  .replace(/id='u25'/, 'id="u25"')
  .replace(/id='grdItens'/, 'id="grdItens"');

describe('v30 — detecção do layout Axure', () => {
  test('isAxureNfcePage reconhece os ids uNN/grdItens (aspas simples e duplas)', () => {
    expect(isAxureNfcePage(AXURE)).toBe(true);
    expect(isAxureNfcePage(AXURE_DQ)).toBe(true);
    expect(isAxureNfcePage('<html><body><table id="tabResult"></table></body></html>')).toBe(false);
  });
  test('looksLikeNfcePage aceita a página Axure completa', () => {
    expect(looksLikeNfcePage(AXURE)).toBe(true);
  });
  test('looksLikeNfcePage aceita Axure mínimo (só ids uNN + NFC-e no título)', () => {
    const minimal = "<html><head><title>Consulta NFC-e</title></head><body><div id='u20_div'>LOJA</div></body></html>";
    expect(looksLikeNfcePage(minimal)).toBe(true);
  });
  test('página Axure NÃO é confundida com rejeição do firewall', () => {
    expect(isFirewallRejectionPage(AXURE)).toBe(false);
  });
  test('pageHasItems enxerga a tabela grdItens (não espera 6× à toa)', () => {
    expect(pageHasItems(AXURE)).toBe(true);
  });
  test('rejeição do firewall continua sendo rejeição', () => {
    expect(isFirewallRejectionPage('<html><title>Request Rejected</title><body>Your support ID: 123</body></html>')).toBe(true);
  });
});

describe('v30 — cabeçalho no layout Axure', () => {
  test('estabelecimento, CNPJ, emissão e valor a pagar (R$: colado)', () => {
    const h = parseNfceHeader(AXURE, KEY);
    expect(h.storeName).toBe('SENDAS DISTRIBUIDORA S/A');
    expect(h.cnpj).toBe('06.057.223/0508-61');
    expect(h.issuedAt).toBe('2026-10-31T17:20:12.000Z'); // 14:20:12 em São Paulo (UTC-3)
    expect(h.grossTotalCents).toBe(13147); // "Valor a pagar R$:131,47"
    expect(h.amountPaidCents).toBe(13147); // sem "Valor Pago" na página → usa o total
  });
  test('aspas duplas e id sem _div também funcionam', () => {
    const h = parseNfceHeader(AXURE_DQ, KEY);
    expect(h.storeName).toBe('SENDAS DISTRIBUIDORA S/A');
    expect(h.grossTotalCents).toBe(13147);
  });
});

describe('v30 — itens no layout Axure (tabela grdItens)', () => {
  test('descrição, código da loja, EAN, quantidade, unidade e total', () => {
    const items = parseNfceItems(AXURE);
    expect(items).toHaveLength(3); // linha de cabeçalho da tabela descartada
    expect(items[0]).toMatchObject({
      description: 'MAMAO PAPAYA kg',
      eanExtracted: null,
      storeProductCode: '8142', // 4 dígitos = código interno da loja
      qty: 2.616,
      unitOriginal: 'KG',
      totalCents: 1540, // célula "Vl. Total 15,40" — vence o calculado (15,41)
    });
    expect(items[1]).toMatchObject({
      description: 'LEITE CONDENSADO CAIXA 395G',
      eanExtracted: '7894900011517', // 13 dígitos = EAN/GTIN
      storeProductCode: null,
      qty: 2,
      unitOriginal: 'UN',
      totalCents: 1698,
    });
  });
  test('célula de total vazia → fallback quantidade × valor unitário', () => {
    const items = parseNfceItems(AXURE);
    expect(items[2]).toMatchObject({
      description: 'SACOLA PLASTICA',
      storeProductCode: '95',
      qty: 3,
      unitOriginal: 'UN',
      totalCents: 75, // 3 × 0,25
    });
  });
  test('parseNfceItemsAxure direto devolve o mesmo resultado', () => {
    expect(parseNfceItemsAxure(AXURE)).toHaveLength(3);
    expect(parseNfceItemsAxure('<table id="tabResult"></table>')).toHaveLength(0);
  });
  test('página clássica NÃO é interceptada pelo leitor Axure (regressão v26)', () => {
    const classic = `<html><body>
<div id="u20" class="txtTopo">SUPERMERCADO EXEMPLO LTDA</div>
<div class="text">CNPJ: 12.345.678/0001-90</div>
<table id="tabResult">
<tr id="Item + 1"><td><span class="txtTit">LEITE INTEGRAL 1L</span><span class="RCod">(Código: 7894900011517 )</span><br/><span class="Rqtd"><strong>Qtde.:</strong>2,0000</span><span class="RUN"><strong>UN: </strong>UN</span><span class="RvlUnit"><strong>Vl. Unit.:</strong>&nbsp;&nbsp;4,99</span></td><td class="txtTit noWrap">Vl. Total<br/><span class="valor">9,98</span></td></tr>
</table>
<div id="totalNota"><label>Valor a pagar R$:</label><span class="totalNumb txtMax">9,98</span></div>
</body></html>`;
    expect(parseNfceItemsAxure(classic)).toHaveLength(0);
    const items = parseNfceItems(classic);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ description: 'LEITE INTEGRAL 1L', eanExtracted: '7894900011517', totalCents: 998 });
    const h = parseNfceHeader(classic, KEY);
    expect(h.storeName).toBe('SUPERMERCADO EXEMPLO LTDA');
    expect(h.grossTotalCents).toBe(998); // leitura clássica continua exata
  });
  test('itens sem código e sem quantidade, mas com total, continuam itens', () => {
    const onlyTotal = `<html><body><div id='u20_div'>LOJA</div>
<table id='grdItens'><tbody>
<tr><td>PÃO FRANCÊS kg</td><td>Vl. Total<br>12,30</td></tr>
</tbody></table></body></html>`;
    const items = parseNfceItemsAxure(onlyTotal);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ description: 'PÃO FRANCÊS kg', totalCents: 1230 });
  });
});
