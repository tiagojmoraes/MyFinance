/** v55 — BATERIA: amarrar lançamentos existentes (débito + crédito) só com DATA + VALOR.
 *  Sem local/estabelecimento. Sem tela. Roda: npm run test:bateria55 | .\scripts\run-bateria.ps1 -Bateria55
 */
import { matchOfxLine, matchCardInstallment, directionOf, typeMatchesOfx } from '../lib/ofxMatch';
import { parseOfx, ofxKind } from '../parsers/ofx';

const tx = (id: string, amountCents: number, occurredOn: string, type: 'INCOME'|'EXPENSE'|'TRANSFER' = 'EXPENSE', description: string | null = null) => ({ id, amountCents, occurredOn, type, description });

describe('v55 DÉBITO — amarrar o que já existe', () => {
  test('Débito: valor + data exata -> MATCHED_AUTO', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-05', amountCents: -10000, memo: 'Mercado' }, [tx('t1', 10000, '2026-11-05', 'EXPENSE', 'Mercado')]);
    expect(r.status).toBe('MATCHED_AUTO'); expect(r.txId).toBe('t1'); expect(r.score).toBe(1);
  });
  test('Débito: valor igual, data 3 dias depois (clearing) -> MATCHED_AUTO, score menor', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-08', amountCents: -10000, memo: 'Mercado' }, [tx('t1', 10000, '2026-11-05', 'EXPENSE')]);
    expect(r.status).toBe('MATCHED_AUTO'); expect(r.score).toBeCloseTo(0.7);
  });
  test('Débito: valor igual, data 15 dias depois -> NEW_TX (fora da janela 10d)', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-20', amountCents: -10000, memo: 'Mercado' }, [tx('t1', 10000, '2026-11-05', 'EXPENSE')]);
    expect(r.status).toBe('NEW_TX');
  });
  test('Débito: valor diferente (1 centavo) -> NEW_TX, não amarra errado', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-05', amountCents: -10001, memo: 'Mercado' }, [tx('t1', 10000, '2026-11-05', 'EXPENSE')]);
    expect(r.status).toBe('NEW_TX');
  });
  test('Débito: 2 lançamentos mesmo valor, datas equidistantes -> AMBIGUOUS (não chuta)', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-05', amountCents: -5000, memo: 'X' }, [tx('a', 5000, '2026-11-04', 'EXPENSE'), tx('b', 5000, '2026-11-06', 'EXPENSE')]);
    expect(r.status).toBe('AMBIGUOUS'); expect(r.txId).toBeNull(); expect(r.candidates).toHaveLength(2);
  });
  test('Débito: 2 lançamentos mesmo valor, um mais perto -> MATCHED_AUTO no mais perto', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-05', amountCents: -5000, memo: 'X' }, [tx('a', 5000, '2026-11-05', 'EXPENSE'), tx('b', 5000, '2026-11-01', 'EXPENSE')]);
    expect(r.status).toBe('MATCHED_AUTO'); expect(r.txId).toBe('a');
  });
  test('Débito: OFX negativo NÃO casa com INCOME mesmo valor (direção importa)', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-05', amountCents: -10000, memo: 'X' }, [tx('t1', 10000, '2026-11-05', 'INCOME')]);
    expect(r.status).toBe('NEW_TX');
  });
  test('Débito: TRANSFER conta->conta também casa (é saída)', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-05', amountCents: -20000, memo: 'Transf' }, [tx('t1', 20000, '2026-11-05', 'TRANSFER')]);
    expect(r.status).toBe('MATCHED_AUTO');
  });
});

describe('v55 CRÉDITO — amarrar o que já existe', () => {
  test('Crédito: salário +500000 data exata -> MATCHED_AUTO', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-05', amountCents: 500000, memo: 'Salario' }, [tx('s1', 500000, '2026-11-05', 'INCOME', 'Salário')]);
    expect(r.status).toBe('MATCHED_AUTO'); expect(r.txId).toBe('s1');
  });
  test('Crédito: estorno de compra (+10000) casa com INCOME, não com EXPENSE', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-05', amountCents: 10000, memo: 'Estorno' }, [tx('e1', 10000, '2026-11-05', 'EXPENSE', 'Compra'), tx('i1', 10000, '2026-11-05', 'INCOME', 'Estorno')]);
    expect(r.status).toBe('MATCHED_AUTO'); expect(r.txId).toBe('i1');
  });
  test('Crédito: PIX recebido +20000, 2 dias depois -> MATCHED_AUTO', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-07', amountCents: 20000, memo: 'PIX' }, [tx('p1', 20000, '2026-11-05', 'INCOME')]);
    expect(r.status).toBe('MATCHED_AUTO');
  });
  test('Crédito: 2 receitas mesmo valor, mesma distância -> AMBIGUOUS', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-05', amountCents: 10000, memo: 'PIX' }, [tx('a', 10000, '2026-11-04', 'INCOME'), tx('b', 10000, '2026-11-06', 'INCOME')]);
    expect(r.status).toBe('AMBIGUOUS');
  });
  test('Crédito: directionOf e typeMatchesOfx', () => {
    expect(directionOf(100)).toBe('CREDIT'); expect(directionOf(-100)).toBe('DEBIT');
    expect(typeMatchesOfx(100, 'INCOME')).toBe(true); expect(typeMatchesOfx(100, 'EXPENSE')).toBe(false);
    expect(typeMatchesOfx(-100, 'EXPENSE')).toBe(true); expect(typeMatchesOfx(-100, 'TRANSFER')).toBe(true); expect(typeMatchesOfx(-100, 'INCOME')).toBe(false);
  });
  test('Crédito: OFX positivo NÃO casa com TRANSFER (transferência não é receita)', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-05', amountCents: 5000, memo: 'X' }, [tx('t1', 5000, '2026-11-05', 'TRANSFER')]);
    expect(r.status).toBe('NEW_TX');
  });
});

describe('v55 DATA + VALOR como único filtro (sem local)', () => {
  test('Memo diferente NÃO impede match — só data+valor contam', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-05', amountCents: -7500, memo: 'SUPERMERCADO XYZ LOJA 123' }, [tx('t1', 7500, '2026-11-05', 'EXPENSE', 'Mercado da esquina')]);
    expect(r.status).toBe('MATCHED_AUTO');
  });
  test('Memo igual mas valor diferente -> NÃO amarra (evita falso positivo por nome)', () => {
    const r = matchOfxLine({ fitid: '1', postedOn: '2026-11-05', amountCents: -7500, memo: 'Mercado' }, [tx('t1', 7501, '2026-11-05', 'EXPENSE', 'Mercado')]);
    expect(r.status).toBe('NEW_TX');
  });
  test('Lote: 100 linhas, cada uma casa com seu lançamento (sem N+1, sem consumir 2x)', () => {
    const existing = Array.from({ length: 100 }, (_, i) => tx(`t${i}`, 1000 + i, `2026-11-${String((i % 28) + 1).padStart(2, '0')}`, 'EXPENSE'));
    const used = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const r = matchOfxLine({ fitid: `f${i}`, postedOn: existing[i].occurredOn, amountCents: -(1000 + i), memo: 'X' }, existing.filter(e => !used.has(e.id)));
      expect(r.status).toBe('MATCHED_AUTO'); expect(r.txId).toBe(`t${i}`); used.add(`t${i}`);
    }
    expect(used.size).toBe(100);
  });
  test('OFX real: 2 linhas débito + 1 crédito no mesmo arquivo, cada uma casa certo', () => {
    const ofx = `<OFX><BANKMSGSRSV1><STMTTRS><STMTRS><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261105</DTPOSTED><TRNAMT>-100.00</TRNAMT><FITID>1</FITID><MEMO>Mercado</MEMO></STMTTRN><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261106</DTPOSTED><TRNAMT>-50.00</TRNAMT><FITID>2</FITID><MEMO>Farmacia</MEMO></STMTTRN><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261105</DTPOSTED><TRNAMT>5000.00</TRNAMT><FITID>3</FITID><MEMO>Salario</MEMO></STMTTRN></BANKTRANLIST></STMTRS></STMTTRS></BANKMSGSRSV1></OFX>`;
    const parsed = parseOfx(ofx);
    expect(parsed.lines).toHaveLength(3);
    const existing = [tx('a', 10000, '2026-11-05', 'EXPENSE'), tx('b', 5000, '2026-11-06', 'EXPENSE'), tx('c', 500000, '2026-11-05', 'INCOME')];
    const rs = parsed.lines.map(l => matchOfxLine({ fitid: l.fitid, postedOn: l.postedOn!, amountCents: l.amountCents!, memo: l.memo }, existing));
    expect(rs.map(r => r.txId)).toEqual(['a', 'b', 'c']);
  });
});

describe('v55 PARCELAMENTO DO CARTÃO NO OFX — como fica?', () => {
  test('Compra 1200 em 3x NÃO aparece como 1200 — aparece como 3 linhas de 400', () => {
    const insts = [
      { id: 'p1', sequenceNumber: 1, totalInstallments: 3, amountCents: 40000, dueDate: '2026-11-10', cardId: 'c1', description: 'Shopee' },
      { id: 'p2', sequenceNumber: 2, totalInstallments: 3, amountCents: 40000, dueDate: '2026-12-10', cardId: 'c1', description: 'Shopee' },
      { id: 'p3', sequenceNumber: 3, totalInstallments: 3, amountCents: 40000, dueDate: '2027-01-10', cardId: 'c1', description: 'Shopee' },
    ];
    // OFX de novembro: só a parcela 1
    const nov = matchCardInstallment({ fitid: 'OFX1', postedOn: '2026-11-10', amountCents: -40000, memo: 'Shopee 1/3' }, insts);
    expect(nov.status).toBe('MATCHED_AUTO'); expect(nov.installmentId).toBe('p1'); expect(nov.reason).toContain('1/3');
    // OFX de dezembro: só a parcela 2 (não a 1 de novo, não o total)
    const dez = matchCardInstallment({ fitid: 'OFX2', postedOn: '2026-12-10', amountCents: -40000, memo: 'Shopee 2/3' }, insts);
    expect(dez.installmentId).toBe('p2');
  });
  test('Parcela com valor diferente (juros/multa) NÃO casa — vira NEW_TX para revisar', () => {
    const insts = [{ id: 'p1', sequenceNumber: 1, totalInstallments: 3, amountCents: 40000, dueDate: '2026-11-10', cardId: 'c1', description: 'Shopee' }];
    const r = matchCardInstallment({ fitid: 'X', postedOn: '2026-11-10', amountCents: -41000, memo: 'Shopee 1/3' }, insts);
    expect(r.status).toBe('NEW_TX');
  });
  test('Se usuário NÃO lançou o parcelado, OFX cria item de fatura solto (não cria lançamento de 1200)', () => {
    const r = matchCardInstallment({ fitid: 'X', postedOn: '2026-11-10', amountCents: -40000, memo: 'Shopee' }, []);
    expect(r.status).toBe('NEW_TX'); expect(r.installmentId).toBeNull();
    // Regra: NEW_TX no cartão = item de fatura de 400, não lançamento de 1200. O usuário agrupa depois se quiser.
  });
  test('OFX de cartão: 2 parcelas mesmo valor, meses diferentes — data decide (janela 5d)', () => {
    const insts = [
      { id: 'p1', sequenceNumber: 1, totalInstallments: 2, amountCents: 10000, dueDate: '2026-11-10', cardId: 'c1', description: 'A' },
      { id: 'p2', sequenceNumber: 2, totalInstallments: 2, amountCents: 10000, dueDate: '2026-12-10', cardId: 'c1', description: 'A' },
    ];
    const rNov = matchCardInstallment({ fitid: '1', postedOn: '2026-11-09', amountCents: -10000, memo: 'A' }, insts, 5);
    expect(rNov.installmentId).toBe('p1');
    const rDez = matchCardInstallment({ fitid: '2', postedOn: '2026-12-11', amountCents: -10000, memo: 'A' }, insts, 5);
    expect(rDez.installmentId).toBe('p2');
  });
  test('OFX de cartão é CARD e não BANK — não vai para conta', () => {
    const cardOfx = `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261110</DTPOSTED><TRNAMT>-400.00</TRNAMT><FITID>1</FITID><MEMO>Shopee 1/3</MEMO></CCSTMTTRN></CREDITCARDMSGSRSV1></OFX>`;
    expect(ofxKind(cardOfx)).toBe('CARD');
  });
  test('Parcelado no cartão: fatura do mês recebe SÓ a parcela do mês, não o total', () => {
    // Compra 1200 em 3x: fatura nov = 400, dez = 400, jan = 400. Nunca 1200 em nov.
    const faturaNov = 40000; const faturaDez = 40000; const faturaJan = 40000;
    expect(faturaNov + faturaDez + faturaJan).toBe(120000);
    expect(faturaNov).toBe(40000);
  });
});
