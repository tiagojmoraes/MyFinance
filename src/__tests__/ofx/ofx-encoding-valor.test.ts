/**
 * v87 — OFX: encoding Latin-1, valor no padrão oficial e linha malformada.
 *
 *  · Arquivo em ISO-8859-1/CP1252 (o padrão dos bancos BR): lido como UTF-8,
 *    os acentos viravam "�" (e o limpador trocava por espaço: "AÇOUGUE" →
 *    "A OUGUE"). Agora o arquivo é lido em base64 e decodificado como Latin-1;
 *  · Valor no padrão OFX oficial ("1.234" = R$ 1,23): o parser decide pelo
 *    próprio arquivo (vírgula em algum TRNAMT = milhar BR; sem vírgula = ponto
 *    decimal);
 *  · Linha com DTPOSTED/TRNAMT inválido vai para `errors` — não entra no
 *    lote (estourava o NOT NULL/CHECK do banco e revertia o import inteiro).
 */

import { parseOfx, parseOfxAmount } from '../../parsers/ofx';
import { base64ParaBytes, bytesParaLatin1, pareceLatin1, textoOfx } from '../../lib/ofxEncoding';

const ofx = (linhas: string[]) =>
  `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\n${linhas.join(
    '\n'
  )}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe('v87 — OFX: valor (ponto decimal oficial x milhar BR)', () => {
  test('arquivo SEM vírgula: "1.234" é o padrão OFX (R$ 1,23)', () => {
    const p = parseOfx(
      ofx(['<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260115<TRNAMT>1.234<FITID>A1<MEMO>X</STMTTRN>'])
    );
    expect(p.lines[0]?.amountCents).toBe(123);
    expect(p.errors).toHaveLength(0);
  });

  test('arquivo COM vírgula (extrato BR): "1.234,56" é milhar (R$ 1.234,56)', () => {
    const p = parseOfx(
      ofx([
        '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260115<TRNAMT>1.234,56<FITID>A1<MEMO>X</STMTTRN>',
        '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260116<TRNAMT>-20,00<FITID>A2<MEMO>Y</STMTTRN>',
      ])
    );
    expect(p.lines[0]?.amountCents).toBe(123_456);
    expect(p.lines[1]?.amountCents).toBe(-2_000);
  });

  test('parseOfxAmount continua aceitando o formato BR quando pedido explicitamente', () => {
    expect(parseOfxAmount('1.234,56')).toBe(123_456);
    expect(parseOfxAmount('1.234', { milharEmPonto: false })).toBe(123);
  });
});

describe('v87 — OFX: linha malformada não derruba o import', () => {
  test('DTPOSTED inválido vai para errors; as linhas boas entram', () => {
    const p = parseOfx(
      ofx([
        '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>ZZZZZZZZ<TRNAMT>-10.00<FITID>B1<MEMO>RUIM</STMTTRN>',
        '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260115<TRNAMT>-10.00<FITID>B2<MEMO>BOA</STMTTRN>',
      ])
    );
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]?.fitid).toBe('B2');
    expect(p.lines[0]?.postedOn).toBe('2026-01-15');
    expect(p.errors.length).toBe(1);
    expect(p.errors[0]).toMatch(/DTPOSTED/i);
  });

  test('TRNAMT zerado vai para errors (o banco exige valor > 0)', () => {
    const p = parseOfx(
      ofx(['<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260115<TRNAMT>0.00<FITID>C1<MEMO>ZERO</STMTTRN>'])
    );
    expect(p.lines).toHaveLength(0);
    expect(p.errors.length).toBe(1);
  });
});

describe('v87 — OFX: arquivo Latin-1 (CP1252) lido certo', () => {
  test('base64 → Latin-1 preserva os acentos', () => {
    const original = 'AÇOUGUE';
    const bytes = Array.from(original).map((c) => c.charCodeAt(0) & 0xff);
    const b64 = Buffer.from(bytes).toString('base64');
    const bytes2 = base64ParaBytes(b64);
    expect(bytesParaLatin1(bytes2)).toBe(original);
  });

  test('UTF-8 válido passa direto; com "�" o base64Latin-1 é usado', () => {
    const utf8 = 'AÇOUGUE';
    expect(pareceLatin1(utf8)).toBe(false);
    expect(textoOfx(utf8, null)).toBe(utf8);

    // o mesmo texto lido como UTF-8 a partir de bytes Latin-1 fica com "�"
    const bytesLatin = Array.from('AÇOUGUE').map((c) => c.charCodeAt(0) & 0xff);
    const b64 = Buffer.from(bytesLatin).toString('base64');
    const quebrado = Buffer.from(bytesLatin).toString('utf8'); // simula a leitura errada
    expect(pareceLatin1(quebrado)).toBe(true);
    expect(textoOfx(quebrado, b64)).toBe('AÇOUGUE');
  });
});
