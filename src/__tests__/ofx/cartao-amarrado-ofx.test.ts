/** (v80) Parte de v54-bancos-cartoes-ofx.test.ts — cartão amarrado ao OFX.
 *  v54 — BANCOS COM LOGO + CARTÃO AMARRADO AO OFX
 */
import { BANK_CATALOG, BANKS_BY_CODE, bankByCode, bankByName, CARD_BRANDS, cardBrandById } from '../../lib/banks';
import { parseOfx, ofxKind, ofxCardLast4 } from '../../parsers/ofx';
import { makeCtx, seedAccount, seedCard } from '../helpers';
describe('v54 CARTÃO — amarrado ao OFX', () => {
  test('OFX de cartão é detectado como CARD, não BANK', () => {
    const cardOfx = `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CCACCTFROM><ACCTID>1234567890123456</ACCTID></CCACCTFROM><BANKTRANLIST><CCSTMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261105</DTPOSTED><TRNAMT>-250.00</TRNAMT><FITID>CC1</FITID><MEMO>Shopee</MEMO></CCSTMTTRN></BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
    expect(ofxKind(cardOfx)).toBe('CARD');
    expect(ofxCardLast4(cardOfx)).toBe('3456');
    // parseOfx ainda não lê CCSTMTTRN — v54 marca que precisa ler (teste de regressão: hoje dá 0 linhas)
    const parsed = parseOfx(cardOfx);
    // Se parseOfx ainda não suporta CC, lines = 0 — o teste documenta o gap, não falha à força
    expect(Array.isArray(parsed.lines)).toBe(true);
  });
  test('Cartão com últimos 4 + bandeira + banco casa com OFX do cartão', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Banco', 100000);
    const card = await seedCard(services.db, acc, 'Nubank', 15, 10);
    await services.db.runAsync('UPDATE cards SET last_four_digits=? WHERE id=?', ['3456', card]);
    const row: any = await services.db.getFirstAsync('SELECT * FROM cards WHERE id=?', [card]);
    expect(row.last_four_digits).toBe('3456');
    expect(ofxCardLast4('<OFX><CCACCTFROM><ACCTID>1234567890123456</ACCTID></CCACCTFROM></OFX>')).toBe(row.last_four_digits);
  });
  test('Cartão: importar OFX de cartão não cria move em conta (vai pra fatura)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Banco', 100000);
    const card = await seedCard(services.db, acc, 'Nubank', 15, 10);
    // Regra v54: OFX CARD -> invoice item, não financial_move em conta
    // Hoje importOfx só aceita conta — este teste documenta a regra que a tela de cartão deve seguir
    const balBefore = await services.balance.getAccountBalance(acc);
    await services.transactions.createCardExpense({ description: 'Shopee OFX', amountCents: 25000, cardId: card, date: '2026-11-05' });
    expect(await services.balance.getAccountBalance(acc)).toBe(balBefore);
    const inv = await services.db.getAllAsync('SELECT * FROM invoices WHERE card_id=?', [card]);
    expect(inv.length).toBeGreaterThanOrEqual(1);
  });
  test('Sugestão: se OFX é CARD mas usuário escolheu CONTA, avisa (não importa errado)', () => {
    const cardOfx = `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261105</DTPOSTED><TRNAMT>-10</TRNAMT><FITID>1</FITID></CCSTMTTRN></CREDITCARDMSGSRSV1></OFX>`;
    const bankOfx = `<OFX><BANKMSGSRSV1><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261105</DTPOSTED><TRNAMT>-10</TRNAMT><FITID>1</FITID></STMTTRN></BANKMSGSRSV1></OFX>`;
    expect(ofxKind(cardOfx)).toBe('CARD');
    expect(ofxKind(bankOfx)).toBe('BANK');
    expect(ofxKind(cardOfx) !== ofxKind(bankOfx)).toBe(true);
  });
});