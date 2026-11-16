/**
 * (v80) Parte de v70.test.ts — parser de notificações e conciliação sem duplicar.
 * v70 — TESTES: notificações bancárias (NÃO SMS), OFX real robusto, Fechamento
 * Mensal com recálculo na hora, abertura do mês (retenção do Fechamento) e as
 * limpezas/melhorias de versão.
 *
 * 1. OFX OFICIAL (fixture anexada pelo usuário — Banco Inter, 71 lançamentos):
 *    parse completo, MEMO sujo (aspas/GUID), sem LEDGERBAL/AVAILBAL, formato BR
 *    negativo, mojibake/entidades, dedupe por FITID;
 * 2. IMPORTAÇÃO sem duplicar: hash idêntico aborta; arquivo atualizado (mesmos
 *    FITIDs + 1 novo) NÃO duplica; NFC-e/notificação já lançada casa por
 *    data+valor (MATCHED_AUTO), nunca vira linha nova;
 * 3. PARSER de notificações (exemplos REAIS do Inter): crédito nacional com
 *    cartão final, compra no débito, PIX recebido; genérico (sem "Tiago");
 * 4. ÁREA TEMPORÁRIA: ingest → NEW (nunca cria lançamento); Lançar + markLancado
 *    apaga o lançamento duplicado criado pelo próprio OFX (NEW_TX);
 * 5. FECHAMENTO MENSAL (1.2): confirmou estimativa → alterou valor → recalcula
 *    na hora; sem sobra → sai (nada retido);
 * 6. ABERTURA do mês (1.3): BalanceService devolve openingPrevisto (saldo
 *    carregado antes do dia 1) para o Fluxo zerar a retenção do fechamento;
 * 7. VERSÃO/LIMPEZA: version 70.0.0, splash configurado, raiz limpa (guias
 *    BATERIA-v*, OTIMIZACAO-v* movidos para docs/arquivo/), docs/CHANGELOG.md existe.
 */

import * as fs from 'fs';
import * as path from 'path';
import { makeCtx, seedAccount, type TestCtx } from '../helpers';
import { parseOfx, dedupeByFitid, parseOfxAmount, sanitizeOfxText } from '../../parsers/ofx';
import { OfxService } from '../../services/OfxService';
import {
  BankMessageService, parseBankMessage, parseValorTexto,
} from '../../services/BankMessageService';
import { SavingsService } from '../../services/SavingsService';
import { BalanceService } from '../../services/BalanceService';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'ofx-inter-oficial.ofx');
const OFX_REAL = fs.readFileSync(FIXTURE, 'utf8');

let ctx: TestCtx;

beforeEach(async () => {
  ctx = await makeCtx();
});
// --------------------------------------------- parser de notificações ----

describe('v70 · 3 — parser de NOTIFICAÇÕES bancárias (exemplos reais do Inter)', () => {
  test('crédito nacional com cartão final 6830: SAÍDA no cartão de crédito', () => {
    const p = parseBankMessage(
      'Olá Tiago. Você acaba de comprar R$ 126,24 em TikTok Shop. A compra foi no crédito nacional, com o cartão final 6830.'
    );
    expect(p).not.toBeNull();
    expect(p!.amountCents).toBe(12624);
    expect(p!.kind).toBe('DEBIT'); // compra = dinheiro SAINDO (é despesa)
    expect(p!.paymentMethod).toBe('CREDITO'); // ...no CARTÃO DE CRÉDITO
    expect(p!.cardFinal).toBe('6830');
    expect(p!.description).toBe('TikTok Shop');
  });

  test('compra no débito com local em caixa alta: extrai o LOCAL inteiro', () => {
    const p = parseBankMessage(
      'Olá Tiago, você acaba de comprar no débito SORVETERIA GYGABOM o valor de R$ 59,47.'
    );
    expect(p).not.toBeNull();
    expect(p!.amountCents).toBe(5947);
    expect(p!.kind).toBe('DEBIT');
    expect(p!.paymentMethod).toBe('DEBITO');
    expect(p!.cardFinal).toBeNull();
    expect(p!.description).toBe('SORVETERIA GYGABOM');
  });

  test('genérico: outro banco e outro usuário (Nubank) também funcionam', () => {
    const p = parseBankMessage('Compra aprovada no crédito CARTÃO FINAL 4444: NETFLIX BR R$ 55,90 em 03/11');
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('DEBIT');
    expect(p!.amountCents).toBe(5590);
    const pix = parseBankMessage('Você recebeu um Pix de ANA MARIA no valor de R$ 1.500,00. Responda já, Maria!');
    expect(pix).not.toBeNull();
    expect(pix!.kind).toBe('CREDIT');
    expect(pix!.amountCents).toBe(150000);
  });

  test('notificação sem valor (marketing/segurança) não vira lançamento', () => {
    expect(parseBankMessage('Olá Tiago, seu boleto está disponível para conferência.')).toBeNull();
    expect(parseValorTexto('1.234,56')).toBe(123456);
  });
});

// ------------------------------------------- área temporária + conciliação ----

describe('v70 · 4 — área temporária: Lançar/Deletar e conciliação sem duplicar', () => {
  test('ingest fica NEW e NUNCA cria lançamento sozinho', async () => {
    const bank = new BankMessageService(ctx.db);
    const r = await bank.ingest(
      null,
      'Olá Tiago, você acaba de comprar no débito SORVETERIA GYGABOM o valor de R$ 59,47.'
    );
    expect(r.inserted).toBe(true);
    const pend = await bank.listPending();
    expect(pend.length).toBe(1);
    expect(pend[0].payment_method).toBe('DEBITO');
    expect(pend[0].card_final).toBeNull();
    const txs = await ctx.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(txs!.n).toBe(0); // ninguém lançou nada sozinho
  });

  test('"Lançar" sobre OFX já importado (NEW_TX) APAGA o duplicado criado pelo OFX', async () => {
    const acc = await seedAccount(ctx.db, 'Inter', 0);
    const ofx = new OfxService(ctx.db);
    await ofx.importOfx(acc, OFX_REAL); // cria lançamento OFX para -59,47 (NEW_TX)
    const bank = new BankMessageService(ctx.db);
    const r = await bank.ingest(
      null,
      'Olá Tiago, você acaba de comprar no débito SORVETERIA GYGABOM o valor de R$ 59,47.'
    );
    expect(r.inserted).toBe(true);
    // determinismo: sem data no texto, a notificação nasce com tx_date = HOJE;
    // a conciliação (±3 dias) precisa apontar para a DATA DO OFX (fixture 2026-11-07)
    await ctx.db.runAsync("UPDATE bank_messages SET tx_date = '2026-11-07' WHERE id = ?", [r.id!]);
    // usuário lança a notificação: cria o lançamento DELE e concilia
    const txRow = await ctx.services.transactions.createAccountExpense({
      description: 'SORVETERIA GYGABOM',
      amountCents: 5947,
      accountId: acc,
    });
    const tx = txRow.id;
    const vinculadas = await bank.markLancado(r.id!, tx, acc);
    expect(vinculadas).toBe(1);
    // o lançamento duplicado do OFX para esse valor FOI APAGADO — resta 1
    const n = await ctx.db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND amount_cents = 5947 AND status != \'VOIDED\'',
      [acc]
    );
    expect(n!.n).toBe(1);
    const msg = await bank.getById(r.id!);
    expect(msg!.status).toBe('LANCADO');
    expect(msg!.transaction_id).toBe(tx);
  });

  test('"Deletar" tira da lista (status DESCARTADA)', async () => {
    const bank = new BankMessageService(ctx.db);
    const r = await bank.ingest(null, 'Compra aprovada: SHOPEE R$ 149,90 em 12/05/2026');
    await bank.discard(r.id!);
    const pend = await bank.listPending();
    expect(pend.length).toBe(0);
    const msg = await bank.getById(r.id!);
    expect(msg!.status).toBe('DESCARTADA');
  });
});