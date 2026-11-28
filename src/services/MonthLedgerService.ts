/**
 * v18 — MonthLedgerService.
 *
 * v18: em MESSES FUTUROS o restante do orçamento abate TAMBÉM o compromisso
 * já previsto daquele mês nas categorias orçadas (parcelas em conta com
 * débito no mês + faturas com vencimento no mês —
 * `BudgetService.getFutureDueCommitmentCents`). Antes só a fixa SIMPLE
 * abatia: o orçamento futuro ficava praticamente inteiro por cima de um
 * saldo que já descontou as pendências — a capacidade da Programação de
 * Compras zerava (cabe = 0 mesmo com a falta viajando) e o closing ficava
 * negativo, abrindo o mês seguinte com dívida fantasma no Saldo do dia.
 * `LEDGER_RULES_VERSION` → 2 (livro recalcula do zero).
 *
 * Carrega e mantém o livro-razão mensal em SQLite (`month_ledger`,
 * `month_ledger_wishlist`). A fonte da verdade continuam sendo os
 * lançamentos: o livro é um RETRATO DERIVADO e reconstruível. Quando o
 * livro é válido, o Fluxo lê dele e ignora o cálculo em memória do
 * `applyMonthEndBalanceHierarchy` legado (que vai virar fallback).
 *
 * Regras:
 * 1. marca d'água `ledger_dirty_from` em app_settings: lines abaixo da
 *    marca são potencialmente sujas. Tudo válido por padrão mesmo.
 * 2. TRIGGERS (criados pelas migrations 62 e 63) baixam a marca
 *    automaticamente quando alguma tabela muda. A v17 também dispara
 *    quando uma das chaves de módulo (orcamentos/poupanca/programação)
 *    é gravada em app_settings.
 * 3. Ao abrir o livro em m, se `dirty_from > m`: devolve cache.
 *    Senão: recalcula de `max(dirty_from, m0)` até m em uma transação.
 * 4. Virada de mês: `ledger_today_month` muda → marca = mês anterior.
 * 5. `LEDGER_RULES_VERSION` mudado → marca = '0000-00'.
 * 6. Backup restore → marca = '0000-00' (no BackupService).
 * 7. v17 — após `recalcRange` a marca SOBE para `target + 1` mesmo
 *    quando estava em '0000-00' (antes ficava presa e recalculava tudo
 *    a cada leitura enquanto o usuário não tocasse em outra coisa).
 *    A regra do livro é: tudo abaixo da marca é válido.
 * 8. v17 — `computeMonth` é ENCADEADO: o saldo de Previsto/Efetivado
 *    no dia-alvo é `opening + (dual − opening)` + budAdj + savAdj, e a
 *    capacidade da Programação vem DEPOIS do orçamento. Sem corrente
 *    de abertura duplicada.
 */

import type { DbDriver } from '../db/types';
import type { Ym, Ymd } from '../lib/dates';
import {
  LEDGER_RULES_VERSION,
  DIRTY_ALL,
  applyClosingHierarchy,
  cascadeWishlist,
  minDirty,
  safeMonthOf,
  horizonOf,
  type ClosingHierarchyOutput,
  type WishItemRef,
  type WishItemResult,
} from '../lib/monthLedger';
import { monthAdd, monthOf, todaySP } from '../lib/dates';
import type { BalanceService } from './BalanceService';
import type { BudgetService } from './BudgetService';
import type { SavingsService } from './SavingsService';
import type { SettingsService } from './SettingsService';
import type { WishlistService } from './WishlistService';

/** Chaves em app_settings usadas pelo ledger. */
export const LEDGER_KEYS = {
  dirtyFrom: 'ledger_dirty_from',
  todayMonth: 'ledger_today_month',
  rulesVersion: 'ledger_rules_version',
} as const;

/** Linha persistida em `month_ledger`. */
export interface MonthLedgerRow {
  month: Ym;
  openingPrevCents: number;
  openingEfetCents: number;
  targetDate: Ymd;
  balanceBeforePrevCents: number;
  balanceBeforeEfetCents: number;
  budgetRemainingCents: number;
  wishlistAllocatedCents: number;
  savingsMonthlyCents: number;
  savingsClosingCents: number;
  closingPrevCents: number;
  closingEfetCents: number;
  rulesVersion: number;
  computedAt: string;
}

/** Linha persistida em `month_ledger_wishlist`. */
export interface MonthLedgerWishRow {
  month: Ym;
  itemId: string;
  classificacao: 'PRIORIDADE' | 'NECESSARIO' | 'DESEJO';
  shortageStartCents: number;
  coveredCents: number;
  shortageEndCents: number;
}

/** Opções para `getMonthLedgerSummary`. */
export interface GetMonthOpts {
  /** pula cache em memória; sempre relê do banco. */
  bypassMemCache?: boolean;
  /** meses passados que recebem registro "na ordem" — ignora m0 quando true. */
  includePriorMonths?: boolean;
}

interface BalanceScope {
  scopeIds: string[];
}

interface ComputeMonthCtx {
  todayMonth: Ym;
  scope: BalanceScope;
  openingPrev: number;
  openingEfet: number;
  closingActive: boolean;
  closingSinceMonth: Ym | null;
}

export class MonthLedgerService {
  /** cache em memória: chave 'YYYY-MM' → linha do ledger já carregada. */
  private memCache = new Map<Ym, MonthLedgerRow>();
  /**
   * v19.1 — GUARDA DE REENTRÂNCIA (bug "Fluxo preso no Carregando..."):
   * com plano CLOSING ativo, `getMonthLedgerSummary` voltava a ser chamado
   * DE DENTRO do próprio `recalcRange` (computeMonth → savings.getMonth-
   * Overview → getClosingSuggestion → computeMonthEndRemainderBeforeClosing
   * → este método). A marca `dirtyFrom` só sobe NO FIM do recálculo e o
   * overview só se memoiza QUANDO termina (VersionedCache ignora versão
   * undefined) — sem a guarda, cada re-entrada abria outro recalcRange
   * (SAVEPOINT novo + dual novo): espiral infinita até o heap estourar.
   * No aparelho o JS trava e o Fluxo fica no "Carregando..." para sempre,
   * com os cards vazios ("Nenhum plano de poupança", R$ 0,00).
   * Re-entrada devolve a melhor leitura disponível SEM recalcular: a linha
   * já persistida do mês (null na primeira computação) — o Savings tem o
   * fallback legado exatamente para esse null.
   */
  private recalcEmAndamento = false;

  constructor(
    private db: DbDriver,
    private settings: SettingsService,
    private balance: BalanceService,
    private budgets: BudgetService,
    private savings: SavingsService,
    private wishlist: WishlistService
  ) {}

  // -------------------------------------------------------- helpers -------

  /** Conta a chave suja em SQLite (DEFAULT '0000-00' se nunca leu). */
  async getSetting(key: keyof typeof LEDGER_KEYS): Promise<string> {
    const v = await this.settings.get(LEDGER_KEYS[key]);
    return v ?? '';
  }

  /** Grava a chave suja (com comparação para não piorar a marca). */
  async setSetting(key: keyof typeof LEDGER_KEYS, value: string): Promise<void> {
    await this.settings.set(LEDGER_KEYS[key], value);
  }

  /** Versão das regras gravada no `app_settings`. */
  async getStoredRulesVersion(): Promise<number> {
    const v = await this.getSetting('rulesVersion');
    return Number(v) || 0;
  }

  /** Reseta o livro inteiro (limpa tabelas + marca = '0000-00'). */
  async invalidateAll(): Promise<void> {
    await this.setSetting('dirtyFrom', DIRTY_ALL);
    await this.db.runAsync('DELETE FROM month_ledger_wishlist;', []);
    await this.db.runAsync('DELETE FROM month_ledger;', []);
    this.memCache.clear();
  }

  /** Marca um mês específico como sujo (anterior a ele pode precisar refazer). */
  async markDirty(month: Ym | '0000-00'): Promise<void> {
    const cur = await this.getSetting('dirtyFrom');
    const next = minDirty(cur || DIRTY_ALL, month);
    await this.setSetting('dirtyFrom', next);
    // Memória invalida do mês marcado em diante (em cascata imperfeita,
    // mas segura — o cache é só memo e o banco é a fonte).
    if (month === DIRTY_ALL) {
      this.memCache.clear();
    } else {
      for (const k of Array.from(this.memCache.keys())) {
        if (k >= month) this.memCache.delete(k);
      }
    }
  }

  /**
   * Sincroniza a marca d'água antes de uma leitura:
   *  - bumpa rules_version quando o código mudou,
   *  - detecta virada de mês (ledger_today_month) e baixa a marca.
   * NÃO chama IO pesado — só app_settings.
   */
  async syncDirty(today: string = todaySP()): Promise<{ dirtyFrom: Ym | '0000-00'; todayMonth: Ym | null }> {
    const storedRv = await this.getStoredRulesVersion();
    if (storedRv !== LEDGER_RULES_VERSION) {
      await this.setSetting('rulesVersion', String(LEDGER_RULES_VERSION));
      await this.setSetting('dirtyFrom', DIRTY_ALL);
      this.memCache.clear();
    }
    const todayMonth = monthOf(today);
    const prevTodayMonth = (await this.getSetting('todayMonth')) || '';
    if (prevTodayMonth && prevTodayMonth !== todayMonth) {
      // Virada de mês: a programação começa do mês novo, basta baixar
      // a marca para o MÊS ANTERIOR (qualquer coisa acima do que mudou
      // vai ser revisada).
      const prev = monthAdd(prevTodayMonth, -1);
      await this.setSetting('dirtyFrom', prev);
      this.memCache.clear();
    }
    await this.setSetting('todayMonth', todayMonth);
    const dirtyFrom = (await this.getSetting('dirtyFrom')) || DIRTY_ALL;
    return { dirtyFrom: dirtyFrom as Ym | '0000-00', todayMonth };
  }

  // ---------------------------------------------------- leitura ----------

  /**
   * Garante que o livro está atualizado para `target` e devolve a linha do
   * mês. Se houver cache válido (linha existe em SQLite e está acima da
   * marca), devolve direto.
   */
  async getMonthLedgerSummary(
    target: Ym,
    opts: GetMonthOpts = {}
  ): Promise<MonthLedgerRow | null> {
    // v19.1 — re-entrada durante o recálculo do próprio livro: não recalcula
    // (o resultado desta leitura ainda não existe — é justamente o que o
    // recálculo de fora está produzindo). Devolve a linha persistida, se houver.
    if (this.recalcEmAndamento) return this.readRow(target);
    await this.syncDirty();
    const dirtyFrom = (await this.getSetting('dirtyFrom')) || DIRTY_ALL;
    const todayMonth = monthOf(todaySP());
    const m0 = await this.computeM0(todayMonth);
    if (!m0) return null;
    const ledgerM0Limit = horizonOf(todayMonth, m0);

    // Linha já calculada para um mês entre m0 e target
    if (!opts.bypassMemCache) {
      const cached = this.memCache.get(target);
      if (cached && dirtyFrom > target) return cached;
    }

    // Caso esteja tudo cacheado: lê do banco.
    if (dirtyFrom > target && m0 <= target) {
      const row = await this.readRow(target);
      if (row) {
        this.memCache.set(target, row);
        return row;
      }
    }

    // Caso contrário: precisa recalcular de max(dirtyFrom, m0) até target.
    const fromMonth = dirtyFrom === DIRTY_ALL
      ? m0
      : (dirtyFrom < m0 ? m0 : dirtyFrom);

    if (target < ledgerM0Limit) {
      // target anterior ao limite histórico — não escrevemos linha (regra:
      // meses anteriores a m0 não têm linha no livro, mostram saldo bruto).
      return null;
    }

    // v17: usa o dual da ABERTURA do fromMonth quando possível (evita um
    // getDailyBalancesDual extra só para descobrir openingPrev/openingEfet).
    const initialDual =
      fromMonth === m0 ? await this.balance.getDailyBalancesDual(fromMonth, undefined) : null;
    this.recalcEmAndamento = true;
    try {
      await this.recalcRange(
        fromMonth,
        target,
        opts,
        initialDual
          ? {
              openingPrev: initialDual.openingPrevisto ?? 0,
              openingEfet: initialDual.openingEfetivado ?? 0,
            }
          : null
      );
    } finally {
      // v19.1: a guarda NUNCA fica presa em true (recalcRange pode lançar —
      // leitura/escrita falha, transação abortada — e a próxima leitura
      // precisa poder recalcular de novo).
      this.recalcEmAndamento = false;
    }
    const row = await this.readRow(target);
    if (row) this.memCache.set(target, row);
    return row;
  }

  /** Lê a linha do banco, ou null se não existir. */
  private async readRow(month: Ym): Promise<MonthLedgerRow | null> {
    const row = await this.db.getFirstAsync<{
      month: string;
      opening_prev_cents: number;
      opening_efet_cents: number;
      target_date: string;
      balance_before_prev_cents: number;
      balance_before_efet_cents: number;
      budget_remaining_cents: number;
      wishlist_allocated_cents: number;
      savings_monthly_cents: number;
      savings_closing_cents: number;
      closing_prev_cents: number;
      closing_efet_cents: number;
      rules_version: number;
      computed_at: string;
    }>(
      `SELECT * FROM month_ledger WHERE month = ?`,
      [month]
    );
    if (!row) return null;
    return {
      month: row.month,
      openingPrevCents: row.opening_prev_cents,
      openingEfetCents: row.opening_efet_cents,
      targetDate: row.target_date,
      balanceBeforePrevCents: row.balance_before_prev_cents,
      balanceBeforeEfetCents: row.balance_before_efet_cents,
      budgetRemainingCents: row.budget_remaining_cents,
      wishlistAllocatedCents: row.wishlist_allocated_cents,
      savingsMonthlyCents: row.savings_monthly_cents,
      savingsClosingCents: row.savings_closing_cents,
      closingPrevCents: row.closing_prev_cents,
      closingEfetCents: row.closing_efet_cents,
      rulesVersion: row.rules_version,
      computedAt: row.computed_at,
    };
  }

  /** Aloca entries da wishlist no banco para o mês (cascade persistido). */
  private async readWishlistAlloc(month: Ym): Promise<MonthLedgerWishRow[]> {
    const rows = await this.db.getAllAsync<{
      item_id: string;
      classificacao: 'PRIORIDADE' | 'NECESSARIO' | 'DESEJO';
      shortage_start_cents: number;
      covered_cents: number;
      shortage_end_cents: number;
    }>(
      `SELECT * FROM month_ledger_wishlist WHERE month = ?`,
      [month]
    );
    return rows.map((r) => ({
      month: month,
      itemId: r.item_id,
      classificacao: r.classificacao,
      shortageStartCents: r.shortage_start_cents,
      coveredCents: r.covered_cents,
      shortageEndCents: r.shortage_end_cents,
    }));
  }

  // ---------------------------------------------------- cálculo ----------

  /** Lista de ids de contas do escopo (mesmo filtro do Fluxo legado). */
  private async getScope(): Promise<BalanceScope> {
    const scopeRows = await this.db.getAllAsync<{ id: string }>(
      `SELECT id FROM accounts WHERE include_in_general_balance = 1 AND archived_at IS NULL`
    );
    return { scopeIds: scopeRows.map((r) => r.id) };
  }

  /**
   * v17 — Primeiro mês com alguma "atividade de ledger": primeira
   * transação, primeiro orçamento ativo, primeiro plano de poupança
   * ativo, primeiro item aberto OU 24 meses atrás do mês atual (o que
   * for mais tarde). Retorna `null` se NENHUM módulo está ativo — o
   * Fluxo usa o saldo bruto do BalanceService (legado) nesse caso.
   */
  private async computeM0(todayMonth: Ym): Promise<Ym | null> {
    const minTx = safeMonthOf(
      (await this.db.getFirstAsync<{ v: string | null }>(
        `SELECT MIN(occurred_on) AS v FROM transactions WHERE status != 'VOIDED'`
      ))?.v ?? null
    );
    const minBudget = safeMonthOf(
      (await this.db.getFirstAsync<{ v: string | null }>(
        `SELECT MIN(created_at) AS v FROM budgets WHERE is_active = 1`
      ))?.v ?? null
    );
    const minPlan = safeMonthOf(
      (await this.db.getFirstAsync<{ v: string | null }>(
        `SELECT MIN(created_at) AS v FROM savings_plans WHERE is_active = 1`
      ))?.v ?? null
    );
    const minWish = safeMonthOf(
      (await this.db.getFirstAsync<{ v: string | null }>(
        `SELECT MIN(created_at) AS v FROM wishlist_items WHERE status = 'OPEN'`
      ))?.v ?? null
    );
    const cand: Array<Ym | null> = [minTx, minBudget, minPlan, minWish];
    let m0: Ym | null = null;
    for (const c of cand) {
      if (!c) continue;
      if (!m0 || c < m0) m0 = c;
    }
    const floorMonth = monthAdd(todayMonth, -24);
    if (m0 && m0 < floorMonth) m0 = floorMonth;
    return m0;
  }

  /**
   * Recalcula em cadeia do mês `fromMonth` até `target`. Assume `fromMonth`
   * ≤ `target`. Persiste cada mês em SQLite. Tudo dentro de uma transação.
   *
   * v17: quando `initialDual` é passado (caso do primeiro mês com m0),
   * reaproveitamos o `dual` que já foi aberto por `getMonthLedgerSummary`
   * para descobrir o opening. Sem isso, o `computeMonth` do fromMonth
   * chamaria `getDailyBalancesDual` duas vezes (uma para opening, uma
   * para balancePrev).
   */
  private async recalcRange(
    fromMonth: Ym,
    target: Ym,
    _opts: GetMonthOpts,
    initialOpening: { openingPrev: number; openingEfet: number } | null
  ): Promise<void> {
    const todayMonth = monthOf(todaySP());
    const scope = await this.getScope();
    const closingPlans = await this.savings.listPlans().catch(() => []);
    const closingPlan = closingPlans.find((p) => p.mode === 'CLOSING' && p.is_active === 1);
    const closingSinceMonth = closingPlan?.created_at ? safeMonthOf(closingPlan.created_at) : null;
    const closingActive = !!closingPlan;

    // Cache do `getDailyBalancesDual` por mês do loop: o primeiro mês usa
    // o dual já aberto (parâmetro); os demais abrem uma vez por mês dentro
    // de `computeMonth`. Aqui só guardamos o dual do fromMonth para passar
    // adiante — o da ABERTURA, não o do balanceDaily do próprio mês.
    let openingPrev = initialOpening?.openingPrev ?? 0;
    let openingEfet = initialOpening?.openingEfet ?? 0;
    if (!initialOpening) {
      const prev = monthAdd(fromMonth, -1);
      const prevRow = await this.readRow(prev);
      if (prevRow) {
        openingPrev = prevRow.closingPrevCents;
        openingEfet = prevRow.closingEfetCents;
      } else {
        const dual = await this.balance.getDailyBalancesDual(fromMonth, undefined);
        openingPrev = dual.openingPrevisto ?? 0;
        openingEfet = dual.openingEfetivado ?? 0;
      }
    }

    await this.db.transactionAsync(async () => {
      let m = fromMonth;
      while (m <= target) {
        const rec = await this.computeMonth(m, {
          todayMonth,
          scope,
          openingPrev,
          openingEfet,
          closingActive,
          closingSinceMonth,
        });
        await this.persistRow(rec.row);
        // Persistir a cascade da wishlist (cada item coberto/restante).
        if (rec.wishlist.length > 0) {
          await this.persistWishlistAlloc(m, rec.wishlist);
        }
        openingPrev = rec.row.closingPrevCents;
        openingEfet = rec.row.closingEfetCents;
        if (m === target) break;
        m = monthAdd(m, 1);
      }
    });

    // v17 — MARCA D'ÁGUA sempre sobe para target + 1: o livro é válido
    // para meses < marca. A regra anterior (`if (current !== DIRTY_ALL`)
    // deixava a marca presa em '0000-00' e o Fluxo recalculava em cada
    // leitura. Como o `recalcRange` sempre começa de `max(m0, dirtyFrom)`
    // e percorre até `target`, qualquer mês entre m0 e target AGORA está
    // válido — a marca pode subir livremente.
    if (target >= fromMonth) {
      const nextDirty = monthAdd(target, 1);
      await this.setSetting('dirtyFrom', nextDirty);
    }
    // Limpa memCache das entradas regravadas.
    for (let m = fromMonth; m <= target; m = monthAdd(m, 1)) {
      this.memCache.delete(m);
    }
  }

  /** Persistir uma linha do ledger (REPLACE para idempotência). */
  private async persistRow(row: MonthLedgerRow): Promise<void> {
    await this.db.runAsync(
      `INSERT OR REPLACE INTO month_ledger
        (month, opening_prev_cents, opening_efet_cents, target_date,
         balance_before_prev_cents, balance_before_efet_cents,
         budget_remaining_cents, wishlist_allocated_cents,
         savings_monthly_cents, savings_closing_cents,
         closing_prev_cents, closing_efet_cents,
         rules_version, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.month,
        row.openingPrevCents,
        row.openingEfetCents,
        row.targetDate,
        row.balanceBeforePrevCents,
        row.balanceBeforeEfetCents,
        row.budgetRemainingCents,
        row.wishlistAllocatedCents,
        row.savingsMonthlyCents,
        row.savingsClosingCents,
        row.closingPrevCents,
        row.closingEfetCents,
        row.rulesVersion,
        row.computedAt,
      ]
    );
  }

  private async persistWishlistAlloc(
    month: Ym,
    rows: WishItemResult[]
  ): Promise<void> {
    await this.db.runAsync(`DELETE FROM month_ledger_wishlist WHERE month = ?`, [month]);
    for (const r of rows) {
      await this.db.runAsync(
        `INSERT INTO month_ledger_wishlist
          (month, item_id, classificacao, shortage_start_cents, covered_cents, shortage_end_cents)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          month,
          r.itemId,
          r.classificacao,
          r.shortageStartCents,
          r.coveredCents,
          r.shortageEndCents,
        ]
      );
    }
  }

  /** Calcula UM mês (puro em relação à escrita). */
  private async computeMonth(
    month: Ym,
    ctx: ComputeMonthCtx
  ): Promise<{ row: MonthLedgerRow; wishlist: WishItemResult[] }> {
    const isCurrentOrFuture = month >= ctx.todayMonth;
    // 1) dual + last activity (UMA chamada por mês).
    const dual = await this.balance.getDailyBalancesDual(month, undefined);
    const lastActivity = await this.balance.getLastActivityDate(month);
    const lastDay = (() => {
      const [yy, mm] = month.split('-').map((x) => Number(x));
      return new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    })();
    const targetDate: Ymd = lastActivity ?? `${month}-${String(lastDay).padStart(2, '0')}`;

    // 2) orçamentos — summary + adjust.
    const budgetsOn = await this.settings.getBool('orcamentos_ativado');
    let budgetSummary = null;
    let budgetAdjust: { previsto: Record<string, number>; efetivado: Record<string, number> } | null = null;
    if (budgetsOn) {
      budgetSummary = await this.budgets.getMonthSummary(month, undefined);
      budgetAdjust = await this.budgets.getMonthFluxAdjust(month, ctx.scope.scopeIds, undefined);
    }

    // 3) poupança — savAdj diário. (v19.1: o `savings.getMonthOverview`
    //    que era chamado aqui NUNCA tinha seu valor usado — código morto —
    //    e era o gatilho da recursão com o próprio livro: getMonthOverview →
    //    getClosingSuggestion → getMonthLedgerSummary DENTRO do recalcRange.
    //    O efeito colateral desejado, recalcClosing da estimativa pendente,
    //    continua garantido: o Fluxo chama getMonthOverview logo após a
    //    leitura do livro, fora da transação do recálculo.)
    const savingsOn = await this.settings.getBool('poupanca_ativado');
    const savingsAdjust = savingsOn
      ? await this.savings.getMonthFluxAdjust(month, ctx.scope.scopeIds, undefined)
      : null;

    // 4) v17 — ENCADEADO: `opening + (dual.alvo − dual.opening) + ajustes`.
    // No primeiro mês da cadeia `opening == dual.opening`, então a fórmula
    // recai no comportamento v16 (apenas os ajustes somam). Nos meses
    // posteriores a abertura é o `closing` do mês anterior — a carga bate
    // automaticamente.
    const dualOpeningPrev = dual.openingPrevisto ?? 0;
    const dualOpeningEfet = dual.openingEfetivado ?? 0;
    const balancePrev =
      ctx.openingPrev +
      ((dual.previsto[targetDate] ?? 0) - dualOpeningPrev) +
      (budgetAdjust?.previsto[targetDate] ?? 0) +
      (budgetAdjust?.efetivado[targetDate] ?? 0) +
      (savingsAdjust?.previsto[targetDate] ?? 0) +
      (savingsAdjust?.efetivado[targetDate] ?? 0);
    const balanceEfet =
      ctx.openingEfet +
      ((dual.efetivado[targetDate] ?? 0) - dualOpeningEfet) +
      (budgetAdjust?.efetivado[targetDate] ?? 0) +
      (savingsAdjust?.efetivado[targetDate] ?? 0);

    // 5) v17 — capacidade da cascata calculada DEPOIS do orçamento e do
    // saldo. O orçamento é subtraído POR INTEIRO do saldo previsto; a
    // Programação só recebe o que SOBRAR do saldo. Sem isso a cascade
    // poderia querer alocar além da disponibilidade real.
    // v18 — MESSES FUTUROS: o restante do orçamento abate TAMBÉM o
    // compromisso já previsto daquele mês nas categorias orçadas (parcelas
    // em conta com débito no mês + faturas com vencimento no mês — a fixa
    // SIMPLE pendente já está no remainingCents). Antes, no mês futuro só a
    // fixa abatia (a parcela conta no mês da COMPRA — âncora v72 — e a
    // fatura não abatia nada): o orçamento ficava praticamente inteiro POR
    // CIMA de um saldo que JÁ descontou as pendências — a capacidade da
    // Programação zerava (cabe = 0 mesmo com a falta viajando do mês
    // anterior) e o closing ficava negativo: a dívida fantasma abria o mês
    // seguinte sem zerar o Saldo do dia Efetivado/Previsto.
    let budgetRemainingRaw = budgetSummary?.remainingCents ?? 0;
    if (budgetSummary && month > ctx.todayMonth) {
      const dueCommitment = await this.budgets.getFutureDueCommitmentCents(month);
      budgetRemainingRaw = Math.max(0, budgetSummary.remainingCents - dueCommitment);
    }
    const budgetRemaining = Math.max(0, budgetRemainingRaw);
    const wishlistCapacity = Math.max(0, balancePrev - budgetRemaining);

    // 6) cascade da wishlist (P → N → D) — só do mês corrente em diante.
    let wishlistResults: WishItemResult[] = [];
    let wishlistTotal = 0;
    if (isCurrentOrFuture) {
      wishlistResults = await this.cascadeWishlistForMonth(month, ctx, wishlistCapacity);
      wishlistTotal = wishlistResults.reduce((s, r) => s + r.coveredCents, 0);
    }

    // 7) poupança mensal do mês: ENTRY MONTHLY > plano ativo (amount_cents).
    const monthlySavings = await this.resolveMonthlySavings(month);

    // 8) fechamento ativo.
    const regimeActive = ctx.closingActive && (
      !ctx.closingSinceMonth || month >= ctx.closingSinceMonth
    );

    const hier: ClosingHierarchyOutput = applyClosingHierarchy({
      balancePrevCents: balancePrev,
      balanceEfetCents: balanceEfet,
      budgetRemainingCents: budgetRemainingRaw,
      wishlistTotalCents: wishlistTotal,
      monthlySavingsCents: monthlySavings,
      closingModeActive: regimeActive,
      isCurrentOrFuture,
    });

    const row: MonthLedgerRow = {
      month,
      // Opening_prev/efet — vem do chain (carry da iteração anterior ou
      // do dual opening na primeira passada).
      openingPrevCents: ctx.openingPrev,
      openingEfetCents: ctx.openingEfet,
      targetDate,
      balanceBeforePrevCents: balancePrev,
      balanceBeforeEfetCents: balanceEfet,
      budgetRemainingCents: budgetRemainingRaw,
      wishlistAllocatedCents: hier.wishlistAllocatedCents,
      savingsMonthlyCents: hier.savingsMonthlyCents,
      savingsClosingCents: hier.savingsClosingCents,
      closingPrevCents: hier.closingPrevCents,
      closingEfetCents: hier.closingEfetCents,
      rulesVersion: LEDGER_RULES_VERSION,
      computedAt: new Date().toISOString(),
    };
    return { row, wishlist: wishlistResults };
  }

  /**
   * Cascade da wishlist para o mês m. Usa o carryover do ledger[m-1] quando
   * houver (sinaliza o que sobrou dos meses anteriores); senão usa a falta
   * fresca `max(0, target - reserved)` (primeira passagem / sem histórico).
   *
   * v17 (c): o carry é usado SEMPRE que existir — mesmo com valor 0. Antes
   * a regra `carry != null && carry > 0` zerava o carry quando era 0, o
   * que reativava items que já tinham sido totalmente cobertos no mês
   * anterior (a falta fresca é max(0, target - reserved) e ignora o
   * trabalho do mês anterior).
   *
   * v27 (fix "fila recomeça do zero"): item SEM linha no mês anterior
   * (`carry == undefined`) significa que ele NÃO estava mais na fila — a
   * falta dele zerou em algum mês anterior e a cascade o omitiu
   * (`faltaInicio <= 0 → continue`, sem linha persistida). O fallback para
   * `fresh` ressuscitava o item com a falta inteira: ao avançar os meses a
   * fila REINICIAVA (ex.: P 900k fechando em fev/2027 voltava com 900k em
   * abr/2027), empurrando Necessário/Desejo para trás e o plano nunca
   * chegava a "done". Nos meses futuros, carry ausente = 0.
   */
  private async cascadeWishlistForMonth(
    month: Ym,
    ctx: ComputeMonthCtx,
    capacity: number
  ): Promise<WishItemResult[]> {
    const prev = monthAdd(month, -1);
    const prevAlloc = await this.readWishlistAlloc(prev);
    const prevByItem = new Map<string, number>();
    for (const r of prevAlloc) prevByItem.set(r.itemId, r.shortageEndCents);

    // Itens abertos HOJE.
    const wishOn = await this.settings.getBool('wishlist_na_home');
    if (!wishOn) return [];

    const classes = await this.wishlist.listOpen(undefined);
    if (classes.every((c) => c.itemCount === 0)) {
      // sem itens abertos: nada a alocar.
      return [];
    }
    // Para o mês corrente: usa a falta fresca (target - reserved). Para
    // meses futuros (>current): usa o carryover (shortage_end do mês
    // anterior). v27: carry AUSENTE (item sem linha no mês anterior) = o
    // item já tinha saído da fila (falta zerou) → 0, nunca volta para a
    // falta fresca — a falta fresca só vale para o mês corrente (estado
    // real de hoje).
    const items: WishItemRef[] = [];
    for (const cl of classes) {
      for (const item of cl.items) {
        const target_ = item.target_cents;
        const reserved = item.reserved_cents;
        const fresh = Math.max(0, target_ - reserved);
        const carry = prevByItem.get(item.id);
        const faltaInicio =
          month === ctx.todayMonth
            ? fresh
            : (carry != null ? carry : 0);
        if (faltaInicio <= 0) continue;
        items.push({
          itemId: item.id,
          classificacao: cl.cls,
          faltaInicioCents: faltaInicio,
        });
      }
    }
    if (items.length === 0) return [];

    return cascadeWishlist(items, capacity);
  }

  /**
   * Resolve a Poupança Mensal do mês (de entries MONTHLY OU dos planos ativos).
   * Aceita entry confirmada (já existe transferência) e projected (FORECAST).
   * v19.1 — SOMA de TODOS os planos: antes era `LIMIT 1` (uma entrada/plano
   * só), o que subestimava a poupança mensal de quem tem MAIS DE UM plano
   * (ex.: 2 mensais + fechamento) e inflava a estimativa do Fechamento —
   * a sobra aparecia maior porque só 1 dos planos era abatido. Mesma regra
   * do v87 do SavingsService: entries de plano ativo (ou órfãs).
   */
  private async resolveMonthlySavings(month: Ym): Promise<number> {
    const savingsOn = await this.settings.getBool('poupanca_ativado');
    if (!savingsOn) return 0;
    const row = await this.db.getFirstAsync<{ total: number | null }>(
      `SELECT COALESCE(SUM(se.amount_cents), 0) AS total
         FROM savings_entries se
         LEFT JOIN savings_plans sp ON sp.id = se.plan_id
        WHERE se.month = ? AND se.kind = 'MONTHLY' AND se.status != 'CANCELED'
          AND (se.plan_id IS NULL OR sp.is_active = 1)`,
      [month]
    );
    if (row?.total && row.total > 0) return row.total;
    // Sem entry no mês: usa os planos ATIVOS (modo MONTHLY) como previsão.
    const plan = await this.db.getFirstAsync<{ total: number | null }>(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM savings_plans
        WHERE mode = 'MONTHLY' AND is_active = 1
          AND amount_cents IS NOT NULL`
    );
    return plan?.total ?? 0;
  }

  // ---------------------------------------------------- inspeção --------

  /**
   * Helper de leitura para o card de Programação de Compra (Fluxo):
   * entries do cascade do mês (ou null se mês anterior a m0 / sem dados).
   * Caso o livro esteja sujo ou incompleto, dispara o recálculo automaticamente.
   */
  async getMonthWishlistEntries(month: Ym): Promise<MonthLedgerWishRow[] | null> {
    await this.syncDirty();
    const dirtyFrom = (await this.getSetting('dirtyFrom')) || DIRTY_ALL;
    const todayMonth = monthOf(todaySP());
    const m0 = await this.computeM0(todayMonth);
    if (!m0) return null;

    // Meses anteriores a m0: nada foi computado, sem rows.
    if (month < m0) return null;

    // Linha já cacheada em memória e marca acima do mês → resposta direta.
    if (!this.memCache.has(month) && dirtyFrom > month) {
      return this.readWishlistAlloc(month);
    }

    // Garanta a linha do mês (e sua cascade) e devolva.
    await this.getMonthLedgerSummary(month);
    return this.readWishlistAlloc(month);
  }

  /**
   * Saldo bruto (não persistido) de um mês para exibir antes do m0 — o
   * mesmo `getDailyBalancesDual` do legado, com abertura zerá do regime
   * do Fechamento aplicado in-memory.
   */
  async getPreLedgerBalance(month: Ym): Promise<{
    openingPrev: number;
    openingEfet: number;
    dual: { prev: Record<string, number>; ef: Record<string, number> };
  }> {
    const dual = await this.balance.getDailyBalancesDual(month, undefined);
    return {
      openingPrev: dual.openingPrevisto ?? 0,
      openingEfet: dual.openingEfetivado ?? 0,
      dual: { prev: dual.previsto ?? {}, ef: dual.efetivado ?? {} },
    };
  }
}
