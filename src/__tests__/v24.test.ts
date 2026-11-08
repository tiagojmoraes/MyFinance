/** v24 — dois relatos do usuário:
 *  1. SALDO DO DIA instável / "não comporta alteração de datas": editar a data
 *     de um lançamento (qualquer status) tem que RECALCULAR todos os dias do
 *     mês — o valor sai do dia antigo e passa a valer no dia novo.
 *  2. NFC-e "continua o mesmo erro": documento PENDING/FAILED de tentativas
 *     antigas travava a nota em "já estava registrada" PARA SEMPRE. Agora o
 *     documento podre é reprocessado (upsert) e a nota é lida de verdade.
 */
import { makeCtx, seedAccount } from './helpers';
import type { DbDriver } from '../db/types';

let db: DbDriver;
let services: ReturnType<typeof buildServices>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildServices } = require('../services');

beforeEach(async () => {
  const ctx = await makeCtx();
  db = ctx.db;
  services = ctx.services;
});

const NOTE_HTML = `<html><body>
<div><span class="label">Nome Empresarial:</span><span class="text">SUPERMERCADO TESTE LTDA</span></div>
<div>CNPJ: 12.345.678/0001-90</div>
<div>Data e Hora de Emissão: 02/12/2026 14:30:00</div>
<div>Valor Total: R$ 150,00</div>
<div>Valor Pago: R$ 150,00</div>
</body></html>`;

const KEY = '35261107216883000121650010000636851006368500';

describe('v24 saldo do dia — alteração de data recalcula TODOS os dias', () => {
  test('despesa CONFIRMADA movida de 03/12 para 05/12: sai do dia antigo, entra no novo', async () => {
    const acc = await seedAccount(db, 'Itau', 100000); // saldo inicial R$ 1.000,00
    // 03/12 é futuro em relação ao hoje real (2026-11-03): nasce PENDING...
    const tx = await services.transactions.createAccountExpense({
      description: 'Compra R$ 300', amountCents: 30000, date: '2026-12-03', accountId: acc,
    });
    // ...e a abertura do Fluxo em 04/12 promove a CONFIRMADA (v21 bug 2)
    await services.transactions.promoteDuePendings('2026-12-04');

    const antes = await services.balance.getDailyBalancesDual('2026-12');
    expect(antes.efetivado['2026-12-02']).toBe(100000);
    expect(antes.efetivado['2026-12-03']).toBe(70000); // 1.000 − 300
    expect(antes.efetivado['2026-12-04']).toBe(70000);

    // usuário EDITA a data para 05/12 (tela Alterar)
    await services.transactions.updateSimple(tx.id, { date: '2026-12-05' });

    const depois = await services.balance.getDailyBalancesDual('2026-12');
    // dias 02–04 VOLTAM ao saldo sem a compra (recálculo de todos os lançamentos)
    expect(depois.efetivado['2026-12-02']).toBe(100000);
    expect(depois.efetivado['2026-12-03']).toBe(100000);
    expect(depois.efetivado['2026-12-04']).toBe(100000);
    // e o dia novo passa a considerar (efetivado = previsto aqui)
    expect(depois.efetivado['2026-12-05']).toBe(70000);
    expect(depois.previsto['2026-12-05']).toBe(70000);
  });

  test('lançamento FUTURO (previsão) movido de data: previsto dos dias anteriores nunca o considera', async () => {
    const acc = await seedAccount(db, 'Itau', 100000);
    // 10k em 03/12 (futuro → PENDING + move VOIDED)
    const tx = await services.transactions.createAccountExpense({
      description: 'Compra 10k', amountCents: 1000000, date: '2026-12-03', accountId: acc,
    });
    let dual = await services.balance.getDailyBalancesDual('2026-12');
    // o exemplo do usuário: saldo do dia 02/12 NÃO considera o 10k do dia 03/12
    expect(dual.previsto['2026-12-02']).toBe(100000);
    expect(dual.previsto['2026-12-03']).toBe(-900000);

    // move para 08/12 — previsto dos dias 02–07 volta a ignorar o valor
    await services.transactions.updateSimple(tx.id, { date: '2026-12-08' });
    dual = await services.balance.getDailyBalancesDual('2026-12');
    expect(dual.previsto['2026-12-02']).toBe(100000);
    expect(dual.previsto['2026-12-07']).toBe(100000);
    expect(dual.previsto['2026-12-08']).toBe(-900000);
  });
});

describe('v24 NFC-e — documento podre (PENDING/FAILED) é reprocessado', () => {
  const insertStaleDoc = async (parseStatus: 'PENDING' | 'FAILED') => {
    await db.runAsync(
      `INSERT INTO nfce_documents
        (access_key, store_name, cnpj, issued_at, amount_paid_cents, gross_total_cents, discount_cents, parse_status, needs_review, transaction_id, source_url)
       VALUES (?,?,NULL,NULL,NULL,NULL,0,?,0,NULL,NULL)`,
      [KEY, parseStatus === 'PENDING' ? null : 'Loja Velha', parseStatus]
    );
  };

  test('PENDING antigo NÃO responde "já registrada": ingestFromHtml grava header + cria transação', async () => {
    await insertStaleDoc('PENDING');
    // antes: sem transação registrada
    expect(await services.nfce.findRegisteredTransactionId(KEY)).toBeNull();

    const res = await services.nfce.ingestFromHtml(KEY, NOTE_HTML, 'https://www.nfce.fazenda.sp.gov.br/qrcode?p=' + KEY);
    expect(res.created).toBe(true);
    expect(res.transactionId).toBeTruthy();

    const doc = await db.getFirstAsync<{ store_name: string | null; cnpj: string | null; parse_status: string; transaction_id: string | null }>(
      'SELECT store_name, cnpj, parse_status, transaction_id FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    expect(doc?.store_name).toBe('SUPERMERCADO TESTE LTDA');
    expect(doc?.cnpj).toBe('12.345.678/0001-90');
    expect(doc?.parse_status).toBe('HEADER_ONLY');
    expect(doc?.transaction_id).toBe(res.transactionId);
    expect(await services.nfce.findRegisteredTransactionId(KEY)).toBe(res.transactionId);
  });

  test('FAILED antigo idem — e a transação da nota nunca é duplicada', async () => {
    await insertStaleDoc('FAILED');
    const first = await services.nfce.ingestFromHtml(KEY, NOTE_HTML, null);
    expect(first.created).toBe(true);

    // reescaneio da mesma nota: NÃO cria segunda transação
    const second = await services.nfce.ingestFromHtml(KEY, NOTE_HTML, null);
    expect(second.created).toBe(false);
    expect(second.transactionId).toBe(first.transactionId);

    const count = await db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM transactions WHERE source_system = 'NFCE' AND external_ref_id = ?",
      [KEY]
    );
    expect(count?.n).toBe(1);
  });

  test('valor ilegível: documento fica HEADER_ONLY + needsAmount (sem transação, sem crash)', async () => {
    const htmlSemValor = '<html><body><div>Nome Empresarial: LOJA SEM VALOR</div><div>CNPJ: 12.345.678/0001-90</div></body></html>';
    const res = await services.nfce.ingestFromHtml(KEY, htmlSemValor, null);
    expect(res.needsAmount).toBe(true);
    expect(res.created).toBe(false);
    const doc = await db.getFirstAsync<{ parse_status: string; needs_review: number }>(
      'SELECT parse_status, needs_review FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    expect(doc?.parse_status).toBe('HEADER_ONLY');
    expect(doc?.needs_review).toBe(1);
  });
});
