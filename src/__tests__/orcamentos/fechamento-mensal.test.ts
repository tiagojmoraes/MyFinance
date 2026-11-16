/**
 * (v80) Parte de v70.test.ts — Fechamento Mensal recalcula na hora + abertura do mês.
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
import { SETTING_KEYS } from '../../services/SettingsService';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'ofx-inter-oficial.ofx');
const OFX_REAL = fs.readFileSync(FIXTURE, 'utf8');

let ctx: TestCtx;

beforeEach(async () => {
  ctx = await makeCtx();
});
// ------------------------------------------------ fechamento mensal ----

describe('v70 · 5 — Fechamento Mensal RECALCULA na hora (nada travado)', () => {
  test('a estimativa de Fechamento recebe só a sobra após Orçamento e Programação de Compras', async () => {
    const origem = await seedAccount(ctx.db, 'Hierarquia fechamento', 100_000);
    const destino = await seedAccount(ctx.db, 'Poupança fechamento', 0);
    await ctx.services.settings.setBool(SETTING_KEYS.budgetsAtivado, true);
    await ctx.services.settings.setBool(SETTING_KEYS.wishlistNaHome, true);
    const category = await ctx.services.categories.create({
      name: 'Orçamento fechamento', direction: 'DEBIT', icon: '🛒', parentId: null,
    });
    await ctx.services.budgets.save(category.id, 20_000);
    await ctx.services.wishlist.addItem({
      classificacao: 'PRIORIDADE', description: 'Compra prioritária', targetCents: 50_000,
    });

    const savings = new SavingsService(ctx.db, ctx.services.transactions, ctx.services.balance);
    await savings.createClosingPlan({ fromAccountId: origem, toAccountId: destino });
    const overview = await savings.getMonthOverview('2026-11');

    expect(overview.closingSuggestion?.amountCents).toBe(30_000);
  });

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