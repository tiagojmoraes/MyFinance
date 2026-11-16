/**
 * (v80) Parte de v69.test.ts — parser de mensagens, ingest e conciliação OFX.
 * v69 — TESTES: mensagens bancárias, Lista de Desejos, poupança do Fluxo e
 * formato "Orçado • Previsto • Gasto".
 *
 * 1. PARSER de mensagens (débito/crédito, valor pt-BR, data, estabelecimento);
 * 2. INGEST na lista — idempotente, NUNCA cria lançamento sozinho;
 * 3. "Lançar" + CONCILIAÇÃO OFX automática por data + valor (nos DOIS sentidos:
 *    OFX já importado → vincula na hora; OFX depois → casamento padrão);
 * 4. "Deletar" tira da lista;
 * 5. LISTA DE DESEJOS — cadastro/alteração/exclusão, reserva na CAIXINHA fora
 *    do saldo geral, reserva na POUPANÇA em fatia separada, barra 100% = pronto,
 *    comprar vira lançamento normal;
 * 6. METODOLOGIA (5.2) — sobra 1.500 x Prioridade 3.000 → 2 meses; as outras
 *    classificações nem começam; frases pedidas pelo usuário;
 * 7. POUPANÇA do Fluxo — cabeçalho não fica em R$ 0,00 (programado inclui a
 *    estimativa do Fechamento), "Falta transferir" = programado − transferido;
 * 8. FORMATO da linha "Orçado • Previsto • Gasto" — uma linha, % redonda.
 */

import { makeCtx, seedAccount, expectRejects, type TestCtx } from '../helpers';
import {
  BankMessageService, parseBankMessage, parseValorTexto,
} from '../../services/BankMessageService';
import {
  WishlistService, RESERVA_ACCOUNT_NAME, CLASS_LABELS,
  type WishlistMethodology,
} from '../../services/WishlistService';
import { pctOf, orcadoPrevistoGastoLinha } from '../../lib/fluxoFormat';
import { TransactionService } from '../../services/TransactionService';
import { formatBRL } from '../../lib/money';
import { clearLancamentos } from '../../db/seed';

let ctx: TestCtx;
let bank: BankMessageService;
let wish: WishlistService;
let tx: TransactionService;

beforeEach(async () => {
  ctx = await makeCtx();
  bank = new BankMessageService(ctx.db);
  wish = new WishlistService(ctx.db, ctx.services.transactions, ctx.services.balance);
  tx = ctx.services.transactions;
});
// ---------------------------------------------------------------- parser ----

describe('v69 · 1 — parser de mensagens bancárias', () => {
  test('compra no débito com valor, data e estabelecimento', () => {
    const p = parseBankMessage('Compra aprovada: SHOPEE R$ 149,90 em 12/05/2026 às 14:02');
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('DEBIT');
    expect(p!.amountCents).toBe(14990);
    expect(p!.date).toBe('2026-05-12');
    expect(p!.description?.toLowerCase()).toContain('shopee');
  });

  test('PIX recebido é crédito', () => {
    const p = parseBankMessage('Pix recebido de JOAO SILVA. Valor: R$ 1.234,56. 13/05/2026');
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('CREDIT');
    expect(p!.amountCents).toBe(123456);
  });

  test('assinatura/streaming cai como débito', () => {
    const p = parseBankMessage('Pagamento efetuado — assinatura NETFLIX R$ 55,90 10/06/2026');
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('DEBIT');
    expect(p!.amountCents).toBe(5590);
  });

  test('data curta dd/mm usa o ano corrente (e ano passado se ficar no futuro)', () => {
    const p = parseBankMessage('Compra aprovada R$ 10,00 em 01/01');
    expect(p).not.toBeNull();
    expect(p!.date).toMatch(/^\d{4}-01-01$/);
  });

  test('mensagem sem valor não entra na lista (null)', () => {
    expect(parseBankMessage('Seu extrato do dia está disponível no app')).toBeNull();
    expect(parseBankMessage('')).toBeNull();
  });

  test('parseValorTexto lê os formatos pt-BR', () => {
    expect(parseValorTexto('1.234,56')).toBe(123456);
    expect(parseValorTexto('149,90')).toBe(14990);
    expect(parseValorTexto('10')).toBe(1000);
    expect(parseValorTexto('')).toBeNull();
  });
});

// ------------------------------------------------------------ v87 ----

describe('v87 — parser de mensagens: valor, recusa, estorno e data', () => {
  test('"rs" dentro de palavra NÃO vira valor (sem juros 12x)', () => {
    // v87: o "rs" sem fronteira casava dentro de palavras e criava R$ 12,00
    const p = parseBankMessage('Compra aprovada no debito com 12x sem juros');
    expect(p).toBeNull();
  });

  test('valor sujo no primeiro casamento ainda tenta o fallback', () => {
    // v87: captura suja (".") descartava a notificação com valor legítimo
    const p = parseBankMessage('Compra aprovada no debito PADARIA o valor de R$ 25,90 em 12/05/2026');
    expect(p).not.toBeNull();
    expect(p!.amountCents).toBe(2590);
  });

  test('compra RECUSADA não vira lançamento (nada foi debitado)', () => {
    expect(parseBankMessage('Compra recusada no debito PADARIA R$ 80,00 em 12/05/2026')).toBeNull();
  });

  test('aviso de fatura/boleto gerado não vira despesa', () => {
    expect(parseBankMessage('Sua fatura R$ 350,00 fecha dia 10')).toBeNull();
    expect(parseBankMessage('Boleto gerado no valor de R$ 120,00')).toBeNull();
  });

  test('estorno é CRÉDITO (o dinheiro volta)', () => {
    const p = parseBankMessage('Estorno de compra R$ 45,00 em 12/05/2026');
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('CREDIT');
    expect(p!.amountCents).toBe(4500);
  });

  test('"12/26" (validade) NÃO vira data da transação', () => {
    const p = parseBankMessage('Compra aprovada no debito LOJA R$ 30,00 em 12/05/2026 validade 12/26');
    expect(p).not.toBeNull();
    expect(p!.date).toBe('2026-05-12');
  });
});

// ---------------------------------------------------------------- ingest ----

describe('v69 · 2 — ingest na lista (nunca cria lançamento sozinho)', () => {
  test('mensagem entra com status NEW e NÃO cria transação', async () => {
    const r = await bank.ingest('Nubank', 'Compra aprovada: SHOPEE R$ 149,90 em 12/05/2026');
    expect(r.inserted).toBe(true);
    const pend = await bank.listPending();
    expect(pend).toHaveLength(1);
    expect(pend[0].status).toBe('NEW');
    expect(pend[0].amount_cents).toBe(14990);
    const txCount = await ctx.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(txCount?.n).toBe(0); // nunca cria lançamento sozinho
  });

  test('mesma mensagem não entra duas vezes (idempotente)', async () => {
    const corpo = 'Compra aprovada: AMAZON R$ 89,90 em 02/06/2026';
    const a = await bank.ingest('Nubank', corpo);
    const b = await bank.ingest('Nubank', corpo);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(await bank.listPending()).toHaveLength(1);
  });

  test('"Deletar" tira da lista (DESCARTADA)', async () => {
    const r = await bank.ingest(null, 'Compra aprovada: IFOOD R$ 42,50 em 03/06/2026');
    await bank.discard(r.id!);
    expect(await bank.listPending()).toHaveLength(0);
    const row = await bank.getById(r.id!);
    expect(row?.status).toBe('DESCARTADA');
  });
});

// ---------------------------------------------------- conciliação com OFX ----

describe('v69 · 3 — lançar mensagem concilia OFX por data + valor', () => {
  test('OFX importado ANTES: markLancado vincula a linha na hora (sem duplicar)', async () => {
    const acc = await seedAccount(ctx.db, 'Banco', 500_000);
    // 1) OFX já importado com a despesa de -149,90 em 2026-05-12
    const ofxContent = [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      'VERSION:102',
      '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260512</DTPOSTED><TRNAMT>-149.90</TRNAMT><FITID>F1</FITID><MEMO>SHOPEE</MEMO>',
    ].join('\n');
    const res = await ctx.services.ofx.importOfx(acc, ofxContent);
    expect(res.newTransactions).toBe(1);

    // 2) mensagem bancária da mesma compra
    const m = await bank.ingest('Nubank', 'Compra aprovada: SHOPEE R$ 149,90 em 12/05/2026');
    // 3) usuário LANÇA (pela tela, vira createAccountExpense) — o serviço marca
    const txRow = await tx.createAccountExpense({
      description: 'SHOPEE',
      amountCents: 14990,
      date: '2026-05-12',
      accountId: acc,
    });
    const vinculadas = await bank.markLancado(m.id!, txRow.id, acc);
    expect(vinculadas).toBe(1);
    // a linha OFX ficou MATCHED_AUTO apontando para o lançamento do usuário
    const linha = await ctx.db.getFirstAsync<{ match_status: string; matched_transaction_id: string }>(
      'SELECT match_status, matched_transaction_id FROM ofx_statement_lines WHERE fitid = ?',
      ['F1']
    );
    expect(linha?.match_status).toBe('MATCHED_AUTO');
    expect(linha?.matched_transaction_id).toBe(txRow.id);
    // e a mensagem ficou LANCADO com o lançamento
    const msg = await bank.getById(m.id!);
    expect(msg?.status).toBe('LANCADO');
    expect(msg?.transaction_id).toBe(txRow.id);
    // v70 (BUG 1.5): a linha era NEW_TX (o OFX tinha criado lançamento próprio).
    // Ao lançar a notificação, o duplicado criado pelo OFX FOI APAGADO —
    // o mesmo dinheiro não é contado duas vezes (fica só o do usuário).
    const txCount = await ctx.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(txCount?.n).toBe(1);
  });

  test('OFX importado DEPOIS: casamento padrão acha o lançamento (MATCHED_AUTO, nada novo)', async () => {
    const acc = await seedAccount(ctx.db, 'Banco2', 300_000);
    // 1) mensagem → usuário lança
    const m = await bank.ingest('Inter', 'Compra aprovada: MERCADO LIVRE R$ 200,00 em 20/06/2026');
    const txRow = await tx.createAccountExpense({
      description: 'MERCADO LIVRE',
      amountCents: 20000,
      date: '2026-06-20',
      accountId: acc,
    });
    await bank.markLancado(m.id!, txRow.id, acc);
    // 2) OFX chega depois com a MESMA data + valor
    const ofxContent = [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      'VERSION:102',
      '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260620</DTPOSTED><TRNAMT>-200.00</TRNAMT><FITID>F2</FITID><MEMO>MERCADO LIVRE</MEMO>',
    ].join('\n');
    const res = await ctx.services.ofx.importOfx(acc, ofxContent);
    expect(res.matchedAuto).toBe(1); // conciliou com o lançamento da mensagem
    expect(res.newTransactions).toBe(0); // NÃO duplicou
    const linha = await ctx.db.getFirstAsync<{ match_status: string; matched_transaction_id: string }>(
      'SELECT match_status, matched_transaction_id FROM ofx_statement_lines WHERE fitid = ?',
      ['F2']
    );
    expect(linha?.match_status).toBe('MATCHED_AUTO');
    expect(linha?.matched_transaction_id).toBe(txRow.id);
  });

  test('OFX com valor DIFERENTE não é vinculado pela conciliação da mensagem', async () => {
    const acc = await seedAccount(ctx.db, 'Banco3', 100_000);
    const ofxContent = [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      'VERSION:102',
      '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260701</DTPOSTED><TRNAMT>-99.00</TRNAMT><FITID>F3</FITID><MEMO>OUTRO</MEMO>',
    ].join('\n');
    await ctx.services.ofx.importOfx(acc, ofxContent);
    const m = await bank.ingest(null, 'Compra aprovada: LOJA X R$ 12,00 em 01/07/2026');
    const txRow = await tx.createAccountExpense({ description: 'LOJA X', amountCents: 1200, date: '2026-07-01', accountId: acc });
    const vinculadas = await bank.markLancado(m.id!, txRow.id, acc);
    expect(vinculadas).toBe(0);
  });
});

// ------------------------------------------------------ lista de desejos ----
