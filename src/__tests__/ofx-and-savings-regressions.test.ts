/**
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
import { makeCtx, seedAccount, type TestCtx } from './helpers';
import { parseOfx, dedupeByFitid, parseOfxAmount, sanitizeOfxText } from '../parsers/ofx';
import { OfxService } from '../services/OfxService';
import {
  BankMessageService, parseBankMessage, parseValorTexto,
} from '../services/BankMessageService';
import { SavingsService } from '../services/SavingsService';
import { BalanceService } from '../services/BalanceService';

const FIXTURE = path.join(__dirname, 'fixtures', 'ofx-inter-oficial.ofx');
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

// ------------------------------------------------ fechamento mensal ----

describe('v70 · 5 — Fechamento Mensal RECALCULA na hora (nada travado)', () => {
  test('alterou o mês (despesa nova) → a transferência confirmada acompanha', async () => {
    const acc = await seedAccount(ctx.db, 'Corrente', 100000); // R$ 1.000,00
    const poup = await seedAccount(ctx.db, 'Poupança', 0);
    const sav = new SavingsService(ctx.db, ctx.services.transactions, ctx.services.balance);
    const planId = await sav.createClosingPlan({ fromAccountId: acc, toAccountId: poup });
    expect(planId).toBeDefined();
    const hoje = new Date().toISOString().slice(0, 10);
    const month = hoje.slice(0, 7);
    await sav.confirmClosing(month, 100000); // estimativa: tudo para a poupança
    // usuário GASTA R$ 200 depois — a estimativa confirmada ficou ANTIGA
    await ctx.services.transactions.createAccountExpense({
      description: 'Mercado', amountCents: 20000, accountId: acc,
    });
    const overview = await sav.getMonthOverview(month); // leitura recalcula (v70 1.2)
    const closingEntry = overview.entries.find((e) => e.kind === 'CLOSING');
    expect(closingEntry).toBeDefined();
    expect(closingEntry!.amountCents).toBe(80000); // 1.000 - 200 = 800
    const txRow = await ctx.db.getFirstAsync<{ amount_cents: number }>(
      'SELECT amount_cents FROM transactions WHERE id = ?',
      [closingEntry!.transactionId!]
    );
    expect(txRow!.amount_cents).toBe(80000);
  });

  test('sem sobra nenhuma → transferência pendente sai (nada retido)', async () => {
    const acc = await seedAccount(ctx.db, 'Corrente', 0);
    const poup = await seedAccount(ctx.db, 'Poupança', 0);
    const sav = new SavingsService(ctx.db, ctx.services.transactions, ctx.services.balance);
    await sav.createClosingPlan({ fromAccountId: acc, toAccountId: poup });
    const month = new Date().toISOString().slice(0, 10).slice(0, 7);
    // força uma estimativa confirmada com valor (não deveria existir sobra)
    await sav.confirmClosing(month, 50000);
    const overview = await sav.getMonthOverview(month);
    expect(overview.entries.find((e) => e.kind === 'CLOSING')).toBeUndefined();
    expect(overview.closingSuggestion).toBeNull();
  });

  test('closingSinceMonth marca o início da regência (v70 1.3)', async () => {
    const acc = await seedAccount(ctx.db, 'Corrente', 1000);
    const poup = await seedAccount(ctx.db, 'Poupança', 0);
    const sav = new SavingsService(ctx.db, ctx.services.transactions, ctx.services.balance);
    const before = await sav.getMonthOverview('2026-01');
    expect(before.closingSinceMonth).toBeNull();
    await sav.createClosingPlan({ fromAccountId: acc, toAccountId: poup });
    const month = new Date().toISOString().slice(0, 10).slice(0, 7);
    const after = await sav.getMonthOverview(month);
    expect(after.closingSinceMonth).toBe(month);
  });
});

// ----------------------------------------------------- abertura do mês ----

describe('v70 · 6 — ABERTURA do mês para a retenção do Fechamento (1.3)', () => {
  test('openingPrevisto = saldo carregado antes do dia 1 (histórico + pendências)', async () => {
    const acc = await seedAccount(ctx.db, 'Corrente', 100000);
    await ctx.services.transactions.createAccountExpense({
      description: 'Passado', amountCents: 30000, accountId: acc,
    }); // CONFIRMED em data passada... hoje
    const bal = new BalanceService(ctx.db);
    const month = new Date().toISOString().slice(0, 10).slice(0, 7);
    const dual = await bal.getDailyBalancesDual(month);
    // abertura do mês = saldo inicial (a despesa é DESTE mês, não entra na abertura)
    expect(dual.openingPrevisto).toBe(100000);
    // previsto no dia 1 ainda sem a despesa do dia de hoje... = 100000 (abertura)
    const primeiro = `${month}-01`;
    expect(dual.previsto[primeiro]).toBe(100000);
  });

  test('mês seguinte carrega a abertura (o Fluxo zera quando o fechamento rege)', async () => {
    const acc = await seedAccount(ctx.db, 'Corrente', 100000);
    const bal = new BalanceService(ctx.db);
    const dual = await bal.getDailyBalancesDual('2027-01');
    expect(dual.openingPrevisto).toBe(100000);
    expect(dual.previsto['2027-01-15']).toBe(100000); // carregado mês a mês
  });
});

// ------------------------------------------------------ versão/limpeza ----

describe('v70 · 7 — versão coerente, splash e LIMPEZA da raiz', () => {
  const root = path.join(__dirname, '..', '..');

  // v71: a versão EXATA do momento é travada no teste da versão corrente
  // (bank-notifications.test.ts) — aqui o contrato é package.json e app.json ALINHADOS.
  test('package.json e app.json na MESMA versão (seguindo X.Y.Z)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(appJson.expo.version).toBe(pkg.version);
  });

  test('splash configurado com imagem (abertura nunca em branco)', () => {
    const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
    expect(appJson.expo.splash.image).toBeDefined();
    expect(fs.existsSync(path.join(root, appJson.expo.splash.image))).toBe(true);
  });

  test('raiz limpa: guias antigos em docs/arquivo/ e CHANGELOG unificado', () => {
    const raiz = fs.readdirSync(root).filter((f) => /^BATERIA-v|^OTIMIZACAO-v|^GARANTIA-|^NFCE-/.test(f));
    expect(raiz).toEqual([]); // nenhum guia antigo solto na raiz
    expect(fs.existsSync(path.join(root, 'docs', 'CHANGELOG.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'docs', 'arquivo', 'OTIMIZACAO-v43.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'docs', 'arquivo', 'BATERIA-v67-GUIA.md'))).toBe(true);
    // essenciais permanecem na raiz
    expect(fs.existsSync(path.join(root, 'COMEÇAR-AQUI.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'BATERIA-COMO-RODAR.md'))).toBe(true);
  });

  test('migração v53: bank_messages com payment_method e card_final', async () => {
    const v = await ctx.db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(v!.user_version).toBeGreaterThanOrEqual(53);
    const cols = (await ctx.db.getAllAsync<{ name: string }>("PRAGMA table_info('bank_messages')")).map((c) => c.name);
    expect(cols).toContain('payment_method');
    expect(cols).toContain('card_final');
  });
});
