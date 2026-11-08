/** Fase 5 — Conciliação OFX batch (v7): dedupe por hash, match, ambiguidade, NEW_TX. */

import { makeCtx, seedAccount, expectRejects } from './helpers';

export function ofxFile(lines: Array<{ fitid: string; date: string; amount: string; memo: string }>): string {
  const body = lines
    .map(
      (l) =>
        `<STMTTRN><TRNTYPE>${l.amount.startsWith('-') ? 'DEBIT' : 'CREDIT'}<DTPOSTED>${l.date}120000<TRNAMT>${l.amount}<FITID>${l.fitid}<MEMO>${l.memo}</STMTTRN>`
    )
    .join('\n');
  return `OFXHEADER:100\nDATA:OFXSGML\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKTRANLIST>\n${body}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

describe('OfxService — batch v7', () => {
  test('importa NEW_TX e cria transação + move com external_ref = fitid', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Itaú');
    const content = ofxFile([
      { fitid: 'F1', date: '20260501', amount: '-150.00', memo: 'SUPERMERCADO ABC' },
      { fitid: 'F2', date: '20260502', amount: '5000.00', memo: 'SALARIO' },
    ]);
    const summary = await services.ofx.importOfx(acc, content);
    expect(summary.totalLines).toBe(2);
    expect(summary.newTransactions).toBe(2);
    const txs = await services.db.getAllAsync<{ description: string; amount_cents: number; type: string; external_ref_id: string }>(
      "SELECT description, amount_cents, type, external_ref_id FROM transactions WHERE source_system = 'OFX_BANK' ORDER BY external_ref_id"
    );
    expect(txs).toHaveLength(2);
    expect(txs[0].amount_cents).toBe(15000);
    expect(txs[0].type).toBe('EXPENSE');
    expect(txs[1].amount_cents).toBe(500000);
    expect(txs[1].type).toBe('INCOME');
    expect(txs.every((t) => t.external_ref_id != null)).toBe(true);
  });

  test('re-import do MESMO arquivo aborta por SHA-256 (ARQ-003)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const content = ofxFile([{ fitid: 'F1', date: '20260501', amount: '-10.00', memo: 'X' }]);
    await services.ofx.importOfx(acc, content);
    await expect(services.ofx.importOfx(acc, content)).rejects.toThrow(/já importado/);
    const count = await services.db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM ofx_imports');
    expect(count?.c).toBe(1);
  });

  test('match automático de lançamento manual existente (mesmo valor, janela de datas)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db, 'Nubank');
    await services.transactions.createAccountExpense({
      description: 'Padaria do Zé', amountCents: 4250, accountId: acc, date: '2026-05-10',
    });
    const content = ofxFile([
      { fitid: 'B1', date: '20260511', amount: '-42.50', memo: 'DEBITO PADARIA DO ZÉ' },
    ]);
    const summary = await services.ofx.importOfx(acc, content);
    expect(summary.matchedAuto).toBe(1);
    expect(summary.newTransactions).toBe(0);
    const line = await services.db.getFirstAsync<{ match_status: string; matched_transaction_id: string }>(
      'SELECT match_status, matched_transaction_id FROM ofx_statement_lines'
    );
    expect(line?.match_status).toBe('MATCHED_AUTO');
    expect(line?.matched_transaction_id).toBe(
      (await services.db.getFirstAsync<{ id: string }>("SELECT id FROM transactions WHERE source_system='MANUAL'"))?.id
    );
  });

  test('valor igual em duas transações distintas => AMBIGUOUS', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    await services.transactions.createAccountExpense({ description: 'UBER VIAGEM 1', amountCents: 2000, accountId: acc, date: '2026-05-01' });
    await services.transactions.createAccountExpense({ description: 'UBER VIAGEM 2', amountCents: 2000, accountId: acc, date: '2026-05-20' });
    const content = ofxFile([
      { fitid: 'U1', date: '20260510', amount: '-20.00', memo: 'UBER' },
    ]);
    const summary = await services.ofx.importOfx(acc, content);
    expect(summary.ambiguous).toBe(1);
    const line = await services.db.getFirstAsync<{ match_status: string }>('SELECT match_status FROM ofx_statement_lines');
    expect(line?.match_status).toBe('AMBIGUOUS');
    // revisão manual: linkLine resolve
    const lineId = (await services.db.getFirstAsync<{ id: string }>('SELECT id FROM ofx_statement_lines'))!.id;
    const candidate = (await services.ofx.getLineCandidates(lineId))[0];
    await services.ofx.linkLine(lineId, candidate.id);
    const fixed = await services.db.getFirstAsync<{ match_status: string }>('SELECT match_status FROM ofx_statement_lines');
    expect(fixed?.match_status).toBe('MATCHED_AUTO');
  });

  test('fitid repetido em ARQUIVO DIFERENTO não duplica (idempotência por ref)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const file1 = ofxFile([{ fitid: 'Z1', date: '20260501', amount: '-30.00', memo: 'LOJA X' }]);
    await services.ofx.importOfx(acc, file1);
    // outro arquivo (hash diferente) com o mesmo fitid
    const file2 = ofxFile([{ fitid: 'Z1', date: '20260501', amount: '-30.00', memo: 'LOJA X' }, { fitid: 'Z2', date: '20260502', amount: '-5.00', memo: 'LOJA Y' }]);
    const summary = await services.ofx.importOfx(acc, file2);
    expect(summary.newTransactions).toBe(1); // apenas Z2
    const z1 = await services.db.getAllAsync("SELECT * FROM transactions WHERE external_ref_id = 'Z1'");
    expect(z1).toHaveLength(1);
  });

  test('transação EXCLUÍDA (física) não é candidata a match (v10)', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    const tx = await services.transactions.createAccountExpense({ description: 'Compra X', amountCents: 5000, accountId: acc, date: '2026-05-01' });
    await services.transactions.deleteTransaction(tx.id);
    const content = ofxFile([{ fitid: 'V1', date: '20260501', amount: '-50.00', memo: 'COMPRA X' }]);
    const summary = await services.ofx.importOfx(acc, content);
    expect(summary.newTransactions).toBe(1);
    expect(summary.matchedAuto).toBe(0);
  });

  test('duas transações idênticas no banco + duas linhas OFX iguais: pareia 1-a-1 sem duplicar', async () => {
    const { services } = await makeCtx();
    const acc = await seedAccount(services.db);
    await services.transactions.createAccountExpense({ description: 'CORREIO A', amountCents: 1000, accountId: acc, date: '2026-05-01' });
    await services.transactions.createAccountExpense({ description: 'CORREIO B', amountCents: 1000, accountId: acc, date: '2026-05-02' });
    const content = ofxFile([
      { fitid: 'C1', date: '20260501', amount: '-10.00', memo: 'CORREIO A' },
      { fitid: 'C2', date: '20260502', amount: '-10.00', memo: 'CORREIO B' },
    ]);
    const summary = await services.ofx.importOfx(acc, content);
    expect(summary.matchedAuto).toBe(2);
    expect(summary.newTransactions).toBe(0);
  });
});
