/**
 * (v80) Parte de v70.test.ts — OFX real: parse e importação sem duplicar.
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
// ---------------------------------------------------------- parser OFX ----

describe('v70 · 1 — parser OFX aguenta ARQUIVO OFICIAL (Inter, 71 lançamentos)', () => {
  test('parse completo do arquivo real: 71 linhas, zero erros', () => {
    const parsed = parseOfx(OFX_REAL);
    expect(parsed.lines.length).toBe(71);
    expect(parsed.errors.length).toBe(0);
    expect(parsed.accountId).toBe('9488138');
    expect(parsed.bankId).toBe('077');
    expect(parsed.currency).toBe('BRL');
  });

  test('primeira linha real: data, valor, FITID e MEMO sujo (aspas) intactos', () => {
    const parsed = parseOfx(OFX_REAL);
    const primeira = parsed.lines.find((l) => l.fitid === '202611070771');
    expect(primeira).toBeDefined();
    expect(primeira!.postedOn).toBe('2026-11-07');
    expect(primeira!.amountCents).toBe(-2413); // -24.13
    expect(primeira!.memo).toContain('Nacontatotem');
  });

  test('MEMO com GUID (Recarga) e Pix com "Cp :" não quebram o parse', () => {
    const parsed = parseOfx(OFX_REAL);
    const recarga = parsed.lines.find((l) => l.memo.includes('9147fcf4'));
    expect(recarga).toBeDefined();
    expect(recarga!.amountCents).toBe(-3000);
    const pix = parsed.lines.find((l) => l.memo.includes('Pix recebido'));
    expect(pix).toBeDefined();
    expect(pix!.amountCents).toBeGreaterThan(0);
  });

  test('sem LEDGERBAL/AVAILBAL o parse segue igual (não depende dos saldos finais)', () => {
    const semBal = OFX_REAL.replace(/<LEDGERBAL>[\s\S]*?<\/LEDGERBAL>/gi, '');
    expect(semBal).not.toContain('LEDGERBAL');
    const parsed = parseOfx(semBal);
    expect(parsed.lines.length).toBe(71);
    expect(parsed.errors.length).toBe(0);
  });

  test('CRLF do Windows e BOM não mudam o resultado', () => {
    const crlf = '\uFEFF' + OFX_REAL.replace(/\n/g, '\r\n');
    const parsed = parseOfx(crlf);
    expect(parsed.lines.length).toBe(71);
    expect(parsed.errors.length).toBe(0);
  });

  test('FITID duplicado dentro do arquivo é dedupado', () => {
    const parsed = parseOfx(OFX_REAL);
    const comDuplicata = OFX_REAL.replace(
      '</BANKTRANLIST>',
      `<STMTTRN><TRNTYPE>PAYMENT</TRNTYPE><DTPOSTED>20261107</DTPOSTED><TRNAMT>-24.13</TRNAMT><FITID>${parsed.lines[0].fitid}</FITID><MEMO>Compra duplicada</MEMO></STMTTRN></BANKTRANLIST>`
    );
    const p2 = parseOfx(comDuplicata);
    expect(p2.lines.length).toBe(72);
    const dedup = dedupeByFitid(p2.lines);
    expect(dedup.duplicates).toBe(1);
    expect(dedup.unique.length).toBe(71);
  });

  test('valores: OFX padrão e formato BR negativo ("-1.234,56")', () => {
    expect(parseOfxAmount('-24.13')).toBe(-2413);
    expect(parseOfxAmount('1600.00')).toBe(160000);
    expect(parseOfxAmount('-1.234,56')).toBe(-123456); // v70: sinal separado
    expect(parseOfxAmount('1.234,56')).toBe(123456);
    expect(parseOfxAmount('-59,47')).toBe(-5947);
  });

  test('texto sujo normalizado: entidades, mojibake CP1252 e controles', () => {
    expect(sanitizeOfxText('Mercado &amp; Cia')).toBe('Mercado & Cia');
    expect(sanitizeOfxText('PadariaÃ§a Ã©cio')).toBe('Padariaça écio');
    expect(sanitizeOfxText('quebra\u0000 aqui')).toBe('quebra aqui');
  });
});

// --------------------------------------------------- importação OFX ----

describe('v70 · 2 — importa OFX real SEM duplicar (hash, FITID, NFC-e, data+valor)', () => {
  test('importa 71 linhas; reimportar o MESMO arquivo aborta por SHA-256', async () => {
    const acc = await seedAccount(ctx.db, 'Inter', 0);
    const ofx = new OfxService(ctx.db);
    const res = await ofx.importOfx(acc, OFX_REAL);
    expect(res.totalLines).toBe(71);
    expect(res.newTransactions).toBe(71);
    expect(res.duplicatesInFile).toBe(0);
    await expect(ofx.importOfx(acc, OFX_REAL)).rejects.toThrow(/já importado/);
  });

  test('arquivo ATUALIZADO (mesmos FITIDs + 1 novo) não duplica nada', async () => {
    const acc = await seedAccount(ctx.db, 'Inter', 0);
    const ofx = new OfxService(ctx.db);
    await ofx.importOfx(acc, OFX_REAL);
    const extra =
      '<STMTTRN><TRNTYPE>PAYMENT</TRNTYPE><DTPOSTED>20261108</DTPOSTED><TRNAMT>-42.00</TRNAMT>' +
      '<FITID>202611080771</FITID><MEMO>Compra no debito: "No estabelecimento NOVO MERCADO"</MEMO></STMTTRN>';
    const atualizado = OFX_REAL.replace('</BANKTRANLIST>', `${extra}</BANKTRANLIST>`);
    const res2 = await ofx.importOfx(acc, atualizado);
    expect(res2.totalLines).toBe(72);
    expect(res2.newTransactions).toBe(1); // só a linha nova; as 71 casam por FITID
    const n = await ctx.db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND source_system = 'OFX_BANK'",
      [acc]
    );
    expect(n!.n).toBe(72);
  });

  test('compra JÁ LANÇADA (NFC-e) casa por data+valor — não vira linha nova', async () => {
    const acc = await seedAccount(ctx.db, 'Inter', 0);
    // A fixture tem R$ 59,47 no débito em 2026-11-07 (SORVETERIA GYGABON)
    await ctx.services.transactions.createAccountExpense({
      description: 'SORVETERIA GYGABON (NFC-e)',
      amountCents: 5947,
      accountId: acc,
    });
    const ofx = new OfxService(ctx.db);
    const res = await ofx.importOfx(acc, OFX_REAL);
    expect(res.matchedAuto).toBe(1);
    expect(res.newTransactions).toBe(70);
    // o lançamento continua ÚNICO (nenhuma duplicata criada)
    const n = await ctx.db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND amount_cents = 5947',
      [acc]
    );
    expect(n!.n).toBe(1);
  });
});