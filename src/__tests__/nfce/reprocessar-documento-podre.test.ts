/** (v80) Parte de v24.test.ts — NFC-e: reprocessar documento podre (relato 2).
 *  v24 — dois relatos do usuário:
 *  1. SALDO DO DIA instável / "não comporta alteração de datas": editar a data
 *     de um lançamento (qualquer status) tem que RECALCULAR todos os dias do
 *     mês — o valor sai do dia antigo e passa a valer no dia novo.
 *  2. NFC-e "continua o mesmo erro": documento PENDING/FAILED de tentativas
 *     antigas travava a nota em "já estava registrada" PARA SEMPRE. Agora o
 *     documento podre é reprocessado (upsert) e a nota é lida de verdade.
 */
import { makeCtx, seedAccount } from '../helpers';
import type { DbDriver } from '../../db/types';

let db: DbDriver;
let services: ReturnType<typeof buildServices>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildServices } = require('../../services');

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