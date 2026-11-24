/**
 * v19.1 — REGRESSÃO: Fluxo preso em "Carregando..." + card Poupança vazio
 * depois de cadastrar plano(s) de poupança com FECHAMENTO DE MÊS.
 *
 * Cenário do usuário: 2 planos MENSAL + 1 plano CLOSING ativos, mês corrente
 * selecionado no Fluxo → a tela nunca terminava de carregar ("Carregando..."
 * eterno) e os cards ficavam vazios ("Nenhum plano de poupança").
 *
 * CAUSA RAIZ: ciclo infinito entre os serviços (prova: instrumentação abaixo).
 *   MonthLedgerService.computeMonth
 *     → SavingsService.getMonthOverview(month, undefined)  // sem versão = SEMPRE recalcula
 *       → computeMonthOverview → getClosingSuggestion      // plano CLOSING ativo, sem entry
 *         → monthEndRemainderBeforeClosing
 *           → computeMonthEndRemainderBeforeClosing
 *             → monthLedger.getMonthLedgerSummary(mesmo mês, em recálculo)
 *               → recalcRange → computeMonth → ... ∞ (OOM no dispositivo)
 *
 * FIX: a chamada do overview dentro de computeMonth era código morto
 * (`savingsOverview` nunca consumido) e foi removida; além disso
 * getMonthLedgerSummary ganhou guarda de reentrância por mês.
 */

import { makeCtx, seedAccount, type TestCtx } from '../helpers';
import { SETTING_KEYS } from '../../services/SettingsService';
import { monthOf, todaySP } from '../../lib/dates';
import { MonthLedgerService } from '../../services/MonthLedgerService';
import { SavingsService } from '../../services/SavingsService';

let ctx: TestCtx;
const month = monthOf(todaySP());

// Instrumentação: conta entradas nos dois lados do ciclo antigo.
let ledgerCalls = 0;
let overviewCalls = 0;
function instrument(): () => void {
  ledgerCalls = 0;
  overviewCalls = 0;
  const origLedger = MonthLedgerService.prototype.getMonthLedgerSummary;
  const origOverview = (SavingsService.prototype as unknown as { computeMonthOverview: unknown })
    .computeMonthOverview;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (MonthLedgerService.prototype as any).getMonthLedgerSummary = function (...args: unknown[]) {
    ledgerCalls++;
    if (ledgerCalls > 25) throw new Error('CICLO: getMonthLedgerSummary > 25 chamadas');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origLedger as any).apply(this, args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (SavingsService.prototype as any).computeMonthOverview = function (...args: unknown[]) {
    overviewCalls++;
    if (overviewCalls > 25) throw new Error('CICLO: computeMonthOverview > 25 chamadas');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origOverview as any).apply(this, args);
  };
  return () => {
    MonthLedgerService.prototype.getMonthLedgerSummary = origLedger;
    (SavingsService.prototype as unknown as { computeMonthOverview: unknown }).computeMonthOverview =
      origOverview;
  };
}

/** Sequência de cargas do Fluxo (app/fluxo.tsx useDataEffect), na mesma ordem. */
async function fluxoLoadSequence(svc: TestCtx['services']): Promise<void> {
  await svc.transactions.promoteDuePendings();
  await svc.recurrences.ensureForecastThrough(month);
  await svc.savings.generateForecast();
  const [show, bFlag, sFlag, wFlag] = await Promise.all([
    svc.settings.getBool(SETTING_KEYS.fluxoSaldoPorDia, false),
    svc.settings.getBool(SETTING_KEYS.budgetsAtivado, false),
    svc.settings.getBool(SETTING_KEYS.poupancaAtivado, false),
    svc.settings.getBool(SETTING_KEYS.wishlistNaHome, false),
  ]);
  if (show || wFlag) await svc.balance.getDailyBalancesDual(month);
  if (show || wFlag || bFlag || sFlag) await svc.monthLedger.getMonthLedgerSummary(month);
  if (bFlag) await svc.budgets.getMonthSummary(month);
  if (sFlag) await svc.savings.getMonthOverview(month);
  if (bFlag || sFlag) {
    const scope = await svc.db.getAllAsync<{ id: string }>(
      'SELECT id FROM accounts WHERE include_in_general_balance = 1 AND archived_at IS NULL'
    );
    const scopeIds = scope.map((r) => r.id);
    if (bFlag) await svc.budgets.getMonthFluxAdjust(month, scopeIds);
    if (sFlag) await svc.savings.getMonthFluxAdjust(month, scopeIds);
  }
  if (wFlag) {
    await svc.wishlist.listOpen();
    await svc.wishlist.getMethodology(month);
    await svc.wishlist.getProjection(month);
  }
  await svc.transactions.listFlow(month);
  await svc.invoices.listInvoicesDueInMonth(month);
  await svc.installments.listAccountInstallmentsDueInMonth(month);
}

async function seedScenario(monthlyCount: number, withClosing: boolean): Promise<{ origem: string; destino: string }> {
  const origem = await seedAccount(ctx.db, 'Conta Corrente', 5_000_00);
  const destino = 'acc-poupanca-regressao';
  await ctx.db.runAsync(
    'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?,?,?,1)',
    [destino, 'Poupança Sul', 'SAVINGS', 0]
  );
  await ctx.services.transactions.createAccountIncome({
    date: `${month}-05`,
    description: 'Salário',
    amountCents: 3_000_00,
    accountId: origem,
  });
  await ctx.services.transactions.createAccountExpense({
    date: `${month}-10`,
    description: 'Supermercado',
    amountCents: 450_00,
    accountId: origem,
  });
  for (let i = 0; i < monthlyCount; i++) {
    await ctx.services.savings.createMonthlyPlan({
      amountCents: 300_00 + i * 50_00,
      dayOfMonth: 5 + i,
      fromAccountId: origem,
      toAccountId: destino,
    });
  }
  if (withClosing) {
    await ctx.services.savings.createClosingPlan({ fromAccountId: origem, toAccountId: destino });
  }
  return { origem, destino };
}

beforeEach(async () => {
  ctx = await makeCtx();
  await ctx.services.settings.setBool(SETTING_KEYS.poupancaAtivado, true);
  await ctx.services.settings.setBool(SETTING_KEYS.budgetsAtivado, true);
  await ctx.services.settings.setBool(SETTING_KEYS.wishlistNaHome, true);
  await ctx.services.settings.setBool(SETTING_KEYS.fluxoSaldoPorDia, true);
});

describe('v19.1 · Fluxo não trava com poupança MENSAL + FECHAMENTO', () => {
  test('2 mensais SEM fechamento: overview resolve normalmente (comportamento intacto)', async () => {
    await seedScenario(2, false);
    const restore = instrument();
    try {
      const o = await ctx.services.savings.getMonthOverview(month);
      expect(o.plans.length).toBe(2);
      expect(o.programadoCents).toBeGreaterThanOrEqual(350_00);
      expect(overviewCalls).toBeLessThanOrEqual(2);
    } finally {
      restore();
    }
  }, 20_000);

  test('2 mensais + 1 fechamento: overview resolve SEM ciclo (era OOM infinito)', async () => {
    await seedScenario(2, true);
    const restore = instrument();
    try {
      const o = await ctx.services.savings.getMonthOverview(month);
      expect(o.plans.length).toBe(3); // 2 mensais + 1 fechamento visíveis no card
      expect(o.programadoCents).toBeGreaterThanOrEqual(350_00); // nunca mais "R$ 0,00" com planos ativos
      expect(o.closingSinceMonth).toBe(month); // o fechamento rege a partir de agora
      expect(overviewCalls).toBeLessThanOrEqual(3); // o ciclo antigo passava de 40 (infinito)
    } finally {
      restore();
    }
  }, 20_000);

  test('carga COMPLETA do Fluxo (ordem real da tela) termina com os 3 planos cadastrados', async () => {
    await seedScenario(2, true);
    const restore = instrument();
    try {
      await fluxoLoadSequence(ctx.services);
      // segunda carga (bump do cadastro) também termina
      await ctx.services.savings.createClosingPlan({
        fromAccountId: (await ctx.db.getAllAsync<{ id: string }>("SELECT id FROM accounts WHERE type = 'CHECKING'"))[0].id,
        toAccountId: 'acc-poupanca-regressao',
      });
      await fluxoLoadSequence(ctx.services);
      expect(overviewCalls).toBeLessThanOrEqual(6);
    } finally {
      restore();
    }
  }, 30_000);

  test('fechamento do mês continua funcionando: sugestão e efetivação', async () => {
    const { origem, destino } = await seedScenario(1, true);
    // sobra positiva → a sugestão aparece no card
    const sug = await ctx.services.savings.getClosingSuggestion(month);
    expect(sug).not.toBeNull();
    expect(sug!.amountCents).toBeGreaterThan(0);
    // efetivar cria a transferência e a deixa CONFIRMED
    const r = await ctx.services.savings.efetivarFechamento(month);
    expect(r.efetivadas).toBe(1);
    const destinoBal = await ctx.db.getFirstAsync<{ bal: number }>(
      `SELECT initial_balance_cents
         + (SELECT COALESCE(SUM(CASE WHEN fm.direction='CREDIT' THEN fm.amount_cents ELSE -fm.amount_cents END),0)
              FROM financial_moves fm WHERE fm.account_id = ? AND fm.status='CONFIRMED') AS bal
        FROM accounts WHERE id = ?`,
      [destino, destino]
    );
    // destino recebe o fechamento (r.amountCents) + a mensal do cenário (300,00,
    // dia 5 já vencido no mês corrente → confirmada)
    expect(destinoBal!.bal).toBe(r.amountCents + 30_000);
    // após efetivado, a sugestão do mês já confirmada é null
    const sug2 = await ctx.services.savings.getClosingSuggestion(month);
    expect(sug2).toBeNull();
    void origem;
  }, 20_000);
});
