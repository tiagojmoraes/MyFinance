/**
 * Testes v19 — as mudanças desta rodada, testáveis sem React:
 *  · toast (src/lib/toast.ts): aviso chega no listener, some ao desregistrar;
 *  · limpeza (CLEAR_MOVEMENTS_SQL): NFC-e salvas (documentos + itens + ledger
 *    de NFC) agora saem junto, na ordem certa das FKs;
 *  · parser NFC-e continua extraindo header/itens (amostra da página SEFAZ-SP);
 *  · versão 19.0.0 nos dois manifestos.
 */

import { CLEAR_MOVEMENTS_SQL } from '../db/migrations';
import { showToast, setToastListener } from '../lib/toast';
import { parseNfceHeader, parseNfceItems } from '../parsers/nfce';

describe('v19 — avisos sem popup (toast)', () => {
  it('entrega a mensagem ao listener registrado', () => {
    const got: Array<{ msg: string; kind: string }> = [];
    setToastListener((msg, kind) => got.push({ msg, kind }));
    showToast('Lançamento salvo');
    showToast('Informe o valor', 'err');
    expect(got).toEqual([
      { msg: 'Lançamento salvo', kind: 'ok' },
      { msg: 'Informe o valor', kind: 'err' },
    ]);
    setToastListener(null);
    showToast('ninguém escuta');
    expect(got).toHaveLength(2);
  });

  it('ignora mensagem vazia', () => {
    let called = 0;
    setToastListener(() => { called++; });
    showToast('');
    expect(called).toBe(0);
    setToastListener(null);
  });
});

describe('v19 — Limpar lançamentos TAMBÉM apaga NFC-e salvas', () => {
  it('o SQL da limpeza inclui nfce_items, nfce_documents e o ledger de NFC', () => {
    expect(CLEAR_MOVEMENTS_SQL).toMatch(/DELETE FROM pantry_ledger WHERE nfce_item_id IS NOT NULL;/);
    expect(CLEAR_MOVEMENTS_SQL).toMatch(/DELETE FROM nfce_items;/);
    expect(CLEAR_MOVEMENTS_SQL).toMatch(/DELETE FROM nfce_documents;/);
    // ordem correta das FKs: ledger (aponta para nfce_items) sai ANTES dos itens
    const ledger = CLEAR_MOVEMENTS_SQL.indexOf('DELETE FROM pantry_ledger WHERE nfce_item_id');
    const items = CLEAR_MOVEMENTS_SQL.indexOf('DELETE FROM nfce_items;');
    const docs = CLEAR_MOVEMENTS_SQL.indexOf('DELETE FROM nfce_documents;');
    expect(ledger).toBeGreaterThan(-1);
    expect(items).toBeGreaterThan(ledger);
    expect(docs).toBeGreaterThan(items);
    // cadastros base continuam preservados
    expect(CLEAR_MOVEMENTS_SQL).toMatch(/CARTÕES \(cards\), CONTAS \(accounts\) e CATEGORIAS \(categories\) permanecem/);
    expect(CLEAR_MOVEMENTS_SQL).not.toMatch(/DELETE FROM cards/);
    expect(CLEAR_MOVEMENTS_SQL).not.toMatch(/DELETE FROM accounts/);
    expect(CLEAR_MOVEMENTS_SQL).not.toMatch(/DELETE FROM categories/);
  });
});

describe('v19 — parser NFC-e segue extraindo header e itens', () => {
  const html = `
    <html><body>
    <div><span class="label">Nome Empresarial</span><span class="text">MERCEARIA DONA MARIA LTDA</span></div>
    <div>CNPJ: 12.345.678/0001-95</div>
    <div>Data e Hora da Emissão: 02/11/2026 10:41:00</div>
    <table>
      <tr><td>1</td><td>ARROZ TIPO 1 5KG</td><td>2 UN x R$ 4,99</td><td>R$ 9,98</td></tr>
      <tr><td>Código do produto (GTIN/EAN):</td><td>7891234567890</td><td>Qtde total de itens: 2,0000 UN</td><td>Unidade comercial: UN</td><td>Valor total do item: R$ 9,98</td></tr>
      <tr><td>2</td><td>LEITE INTEGRAL 1L</td><td>R$ 5,49</td></tr>
    </table>
    <div>Valor Total: R$ 20,00</div>
    <div>Valor Pago: R$ 20,00</div>
    </body></html>`;

  it('header: estabelecimento, CNPJ e valores', () => {
    const h = parseNfceHeader(html, '35261114222016000126650110000123456789012345678');
    expect(h.storeName).toContain('MERCEARIA DONA MARIA');
    expect(h.cnpj).toBe('12.345.678/0001-95');
    expect(h.amountPaidCents).toBe(2000);
  });

  it('itens: nome, qtde, unidade e código — sem rótulo virando produto', () => {
    const items = parseNfceItems(html);
    expect(items.length).toBe(2);
    expect(items[0].description).toContain('ARROZ');
    expect(items[0].eanExtracted).toBe('7891234567890');
    expect(items[0].qty).toBe(2);
    expect(items[0].unitOriginal).toBe('UN');
    expect(items[0].totalCents).toBe(998);
    expect(items[1].description).toContain('LEITE');
  });
});
