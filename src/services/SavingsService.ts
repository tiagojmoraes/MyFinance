/**
 * SavingsService (v42) — MODO POUPANÇA (pedido do usuário).
 *
 * Duas formas de criar (confirmadas pelo usuário):
 *  · MONTHLY — valor fixo por mês (se repete até desativar): todo mês nasce
 *    uma PREVISÃO (transferência PENDING origem→destino no dia escolhido),
 *    mesma mecânica das contas fixas. Quando a data chega, o app promove
 *    sozinho (promoteDuePendings) e a transferência passa a ser EFETIVADA.
 *  · CLOSING — no FECHAMENTO do mês, o saldo do dia previsto do fim do mês,
 *    se POSITIVO, vira a estimativa de poupança; o usuário CONFIRMA no card
 *    do Fluxo (ou na tela Poupança) e a transferência é criada no último dia
 *    do mês (previsão se futura).
 *
 * Card no Fluxo (recolhido → expandir):
 *  · PROGRAMADO = saldo efetivado do fim do mês menos os lançamentos mensais;
 *  · EFETIVADO = soma das transferências já CONFIRMADAS do mês;
 *  · FALTA     = programado − efetivado.
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { nowIso, todaySP, monthOf, monthAdd, dayInMonth, lastDayNumberOf } from '../lib/dates';
import { BalanceService } from './BalanceService';
import { TransactionService } from './TransactionService';
import { BudgetService } from './BudgetService';
import { SETTING_KEYS } from './SettingsService';
import { subtractAllocationsCents } from '../lib/flowAllocations';

export type SavingsMode = 'MONTHLY' | 'CLOSING';

export interface SavingsPlanRow {
  id: string;
  mode: SavingsMode;
  amount_cents: number | null;
  day_of_month: number | null;
  source_account_id: string | null;
  target_account_id: string | null;
  is_active: number;
  created_at: string;
  source_name: string | null;
  target_name: string | null;
}

/** Ocorrência mensal da poupança (previsão ou efetivada). */
export interface SavingsEntryView {
  id: string;
  planId: string | null;
  month: string;
  kind: SavingsMode;
  amountCents: number;
  /** Estado REAL: a transferência CONFIRMED já é efetivada (entrou no saldo). */
  effected: boolean;
  transactionId: string | null;
  date: string | null;
  description: string | null;
}

export interface SavingsMonthOverview {
  entries: SavingsEntryView[];
  /** Soma das entradas mensais e de fechamento registradas no mês. */
  plannedCents: number;
  /**
   * Programado mensal = saldo efetivado no fim do mês menos as entradas da
   * modalidade mensal; no fechamento, usa a estimativa ou entrada já criada.
   */
  programadoCents: number;
  /** Transferências efetivadas do mês ("Já transferido p/ poupança"). */
  effectedCents: number;
  /** v69 — "Falta transferir" = programado − já transferido (nunca negativo). */
  remainingCents: number;
  /** Estimativa do fechamento do mês (saldo previsto final, se > 0 e ainda não confirmada). */
  closingSuggestion: { amountCents: number } | null;
  /**
   * v70 (BUG 1.3) — primeiro mês regido pela modalidade "Fechamento do Mês"
   * (mês de criação do plano CLOSING mais antigo ativo). Nos meses ANTERIORES
   * o saldo carregado é histórico real; dos meses A PARTIR deste em diante, o
   * saldo carregado foi RETIDO para a poupança e o "Saldo do dia Previsto"
   * não pode começar com ele. null = não há plano CLOSING ativo.
   */
  closingSinceMonth: string | null;
  /** v68 — PLANOS CADASTRADOS (o card do Fluxo mostra cada um):
   *  nome (conta destino), modalidade, valor e guardado/falta NO MÊS. */
  plans: SavingsPlanView[];
}

/** v68 — plano cadastrado com os números do mês visto. */
export interface SavingsPlanView {
  planId: string;
  mode: SavingsMode;
  /** Nome de exibição (a conta de destino dá o nome — plano não tem título). */
  name: string;
  /** "Mensal (todo dia X)" ou "Fechamento do mês". */
  modalityLabel: string;
  /** Valor cadastrado (CLOSING = null — vira o restante do mês). */
  amountCents: number | null;
  dayOfMonth: number | null;
  /** Já guardado no mês visto (transferências CONFIRMADAS do plano). */
  guardadoCents: number;
  /** Falta guardar no mês (programado − guardado). */
  faltaCents: number;
}

const FORECAST_MONTHS_AHEAD = 24;

export class SavingsService {
  private balance: BalanceService;

  constructor(
    private db: DbDriver,
    private transactions: TransactionService,
    balance?: BalanceService
  ) {
    this.balance = balance ?? new BalanceService(db);
  }

  // ------------------------------------------------------------- planos ----

  async listPlans(): Promise<SavingsPlanRow[]> {
    return this.db.getAllAsync<SavingsPlanRow>(
      `SELECT sp.id, sp.mode, sp.amount_cents, sp.day_of_month,
              sp.source_account_id, sp.target_account_id, sp.is_active, sp.created_at,
              a.name AS source_name, b.name AS target_name
         FROM savings_plans sp
         LEFT JOIN accounts a ON a.id = sp.source_account_id
         LEFT JOIN accounts b ON b.id = sp.target_account_id
        ORDER BY sp.created_at DESC`
    );
  }

  /** Plano MENSAL: valor todo mês no dia escolhido (origem → destino). */
  async createMonthlyPlan(input: {
    amountCents: number;
    dayOfMonth: number;
    fromAccountId: string;
    toAccountId: string;
  }): Promise<string> {
    if (input.amountCents <= 0) throw new Error('O valor da poupança deve ser maior que zero');
    if (!input.dayOfMonth || input.dayOfMonth < 1 || input.dayOfMonth > 31)
      throw new Error('Dia do mês deve estar entre 1 e 31');
    if (input.fromAccountId === input.toAccountId)
      throw new Error('A conta de origem e o destino devem ser diferentes');
    return this.db.transactionAsync(async () => {
      const id = genId();
      await this.db.runAsync(
        `INSERT INTO savings_plans (id, mode, amount_cents, day_of_month, source_account_id, target_account_id, is_active, created_at)
         VALUES (?, 'MONTHLY', ?, ?, ?, ?, 1, ?)`,
        [id, input.amountCents, Math.trunc(input.dayOfMonth), input.fromAccountId, input.toAccountId, nowIso()]
      );
      await this.generateForecast(todaySP());
      return id;
    });
  }

  /** Plano FECHAMENTO DE MÊS: o saldo previsto positivo do fim do mês vira estimativa. */
  async createClosingPlan(input: { fromAccountId: string; toAccountId: string }): Promise<string> {
    if (input.fromAccountId === input.toAccountId)
      throw new Error('A conta de origem e o destino devem ser diferentes');
    return this.db.transactionAsync(async () => {
      const id = genId();
      await this.db.runAsync(
        `INSERT INTO savings_plans (id, mode, amount_cents, day_of_month, source_account_id, target_account_id, is_active, created_at)
         VALUES (?, 'CLOSING', NULL, NULL, ?, ?, 1, ?)`,
        [id, input.fromAccountId, input.toAccountId, nowIso()]
      );
      return id;
    });
  }

  async setActive(planId: string, active: boolean): Promise<void> {
    await this.db.runAsync('UPDATE savings_plans SET is_active = ? WHERE id = ?', [active ? 1 : 0, planId]);
    if (active) await this.generateForecast(todaySP());
  }

  /** Exclui o plano e as ocorrências. Previsões (PENDING) são apagadas de vez;
   *  transferências já CONFIRMADAS ficam no histórico do Fluxo. */
  async removePlan(planId: string): Promise<void> {
    await this.db.transactionAsync(async () => {
      const pend = await this.db.getAllAsync<{ transaction_id: string | null }>(
        `SELECT transaction_id FROM savings_entries
          WHERE plan_id = ? AND transaction_id IS NOT NULL
            AND transaction_id IN (SELECT id FROM transactions WHERE status = 'PENDING')`,
        [planId]
      );
      await this.db.runAsync('DELETE FROM savings_entries WHERE plan_id = ?', [planId]);
      for (const row of pend) {
        if (!row.transaction_id) continue;
        await this.db.runAsync('DELETE FROM financial_moves WHERE transaction_id = ?', [row.transaction_id]);
        await this.db.runAsync('DELETE FROM transactions WHERE id = ?', [row.transaction_id]);
      }
      await this.db.runAsync('DELETE FROM savings_plans WHERE id = ?', [planId]);
    });
  }

  // ------------------------------------------------- previsão mensal ----

  /**
   * Gera as PREVISÕES dos planos MENSAL ativos (idempotente — UNIQUE por
   * plano/mês). Janela: do mês corrente (se o dia escolhido ainda não passou)
   * até +24 meses, igual ao padrão das contas fixas. Dias 29/30/31 em mês
   * curto caem no ÚLTIMO dia.
   */
  async generateForecast(today?: string): Promise<number> {
    const todayYmd = today ?? todaySP();
    const curMonth = monthOf(todayYmd);
    const plans = await this.db.getAllAsync<{ id: string; amount_cents: number | null; day_of_month: number | null }>(
      `SELECT id, amount_cents, day_of_month FROM savings_plans
        WHERE mode = 'MONTHLY' AND is_active = 1
          AND amount_cents IS NOT NULL AND day_of_month IS NOT NULL`
    );
    let created = 0;
    for (const plan of plans) {
      const day = Math.min(31, Math.max(1, plan.day_of_month ?? 1));
      const accounts = await this.planAccount(plan.id);
      // Mês corrente só se o dia ainda não venceu; senão começa no próximo.
      const curDay = dayInMonth(curMonth, day);
      const startOffset = curDay >= todayYmd ? 0 : 1;
      for (let i = startOffset; i <= FORECAST_MONTHS_AHEAD; i++) {
        const month = monthAdd(curMonth, i);
        const date = dayInMonth(month, day);
        const exists = await this.db.getFirstAsync<{ id: string }>(
          `SELECT id FROM savings_entries WHERE plan_id = ? AND month = ? AND kind = 'MONTHLY'`,
          [plan.id, month]
        );
        if (exists) continue;
        const tx = await this.transactions.createTransfer({
          fromAccountId: accounts.source_account_id,
          toAccountId: accounts.target_account_id,
          amountCents: plan.amount_cents!,
          date,
          description: 'Poupança mensal',
        });
        await this.db.runAsync(
          `INSERT INTO savings_entries (id, plan_id, month, kind, amount_cents, status, transaction_id, created_at)
           VALUES (?, ?, ?, 'MONTHLY', ?, 'FORECAST', ?, ?)`,
          [genId(), plan.id, month, plan.amount_cents!, tx.id, nowIso()]
        );
        created++;
      }
    }
    return created;
  }

  private async planAccount(planId: string): Promise<{ source_account_id: string; target_account_id: string }> {
    const row = await this.db.getFirstAsync<{ source_account_id: string; target_account_id: string }>(
      'SELECT source_account_id, target_account_id FROM savings_plans WHERE id = ?',
      [planId]
    );
    if (!row || !row.source_account_id || !row.target_account_id)
      throw new Error('Plano de poupança sem conta de origem/destino');
    return row;
  }

  // ------------------------------------------------ fechamento do mês ----

  /**
   * v70 (BUG 1.2) — RECALCULO do Fechamento Mensal NA HORA.
   *
   * A transferência confirmada no fechamento é uma ESTIMATIVA congelada no dia
   * em que o usuário tocou no botão. Se depois ele editar qualquer lançamento
   * (data, valor), criar, excluir ou transferir, a estimativa fica ANTIGA —
   * o valor ficava TRAVADO. Esta rotina refaz o cálculo sempre que o mês é
   * lido (Fluxo/Poupança recarregam a cada mudança de dados):
   *  · transferência ainda PENDENTE → o valor é atualizado para o saldo
   *    previsto do fim do mês SEM a própria transferência (o que sobrar de
   *    verdade é o que vira poupança);
   *  · saldo ficou ≤ 0 (não sobra nada para guardar) → a transferência
   *    pendente sai (nada é retido); se depois sobrar de novo, a sugestão
   *    volta a aparecer no card para o usuário confirmar;
   *  · transferência já CONFIRMADA (mês fechado de verdade) → fica como
   *    histórico, ninguém mexe.
   * Roda DENTRO de getMonthOverview — qualquer alteração de data/valor/
   * lançamento/transferência dispara bump() → telas recarregam → recalcula.
   */
  async recalcClosing(month: string, reservedCents?: number): Promise<void> {
    const plan = await this.db.getFirstAsync<{ id: string; source_account_id: string | null; target_account_id: string | null }>(
      `SELECT id, source_account_id, target_account_id FROM savings_plans
        WHERE mode = 'CLOSING' AND is_active = 1 ORDER BY created_at DESC LIMIT 1`
    );
    if (!plan) return;
    const entry = await this.db.getFirstAsync<{ id: string; transaction_id: string | null; amount_cents: number }>(
      `SELECT id, transaction_id, amount_cents FROM savings_entries WHERE month = ? AND kind = 'CLOSING'`,
      [month]
    );
    if (!entry || !entry.transaction_id) return; // nada confirmado ainda — a sugestão já é calculada viva
    const tx = await this.db.getFirstAsync<{ id: string; status: string }>(
      'SELECT id, status FROM transactions WHERE id = ?',
      [entry.transaction_id]
    );
    if (!tx || tx.status !== 'PENDING') return; // executada/mês fechado = histórico

    // Saldo previsto do FIM do mês EXCLUINDO a própria transferência de
    // fechamento: pega o saldo do extrato e devolve o impacto que a perna de
    // débito da transferência causou nas contas do escopo (o que ela TIROU).
    const dual = await this.balance.getDailyBalancesDual(month);
    const endDate = `${month}-${String(lastDayNumberOf(month)).padStart(2, '0')}`;
    const saldoFinal = dual.previsto[endDate] ?? 0;
    const scope = await this.db.getAllAsync<{ id: string }>(
      'SELECT id FROM accounts WHERE include_in_general_balance = 1 AND archived_at IS NULL'
    );
    const scopeIds = scope.map((r) => r.id);
    const marks = scopeIds.length ? scopeIds.map(() => '?').join(',') : "''";
    const impact = await this.db.getFirstAsync<{ net: number }>(
      `SELECT COALESCE(SUM(CASE WHEN fm.direction = 'CREDIT' THEN fm.amount_cents ELSE -fm.amount_cents END), 0) AS net
         FROM financial_moves fm
        WHERE fm.transaction_id = ?
          AND fm.account_id IN (${marks})`,
      [entry.transaction_id, ...scopeIds] as never
    );
    // impacto NEGATIVO = a transferência tirou da conta → devolve para comparar
    // (v70: SEM filtro de status — pernas de transferência futura nascem VOIDED,
    // CONFIRMED nas executadas; o valor da perna é o que importa)
    const allocations = reservedCents ?? await this.getClosingAllocationsCents(month);
    const estimativa = subtractAllocationsCents(
      saldoFinal + Math.abs(Math.min(0, impact?.net ?? 0)),
      [allocations]
    );
    if (estimativa > 0) {
      if (estimativa === entry.amount_cents) return; // nada mudou
      // Atualiza o VALOR nos três lugares (transação, pernas do movimento e entrada)
      await this.db.transactionAsync(async () => {
        await this.db.runAsync('UPDATE transactions SET amount_cents = ? WHERE id = ?', [estimativa, entry.transaction_id!]);
        await this.db.runAsync('UPDATE savings_entries SET amount_cents = ? WHERE id = ?', [estimativa, entry.id]);
        // pernas: a leg DEBIT da origem e o CRÉDITO do destino (sem filtro de
        // status — futura nasce VOIDED, executada fica CONFIRMED)
        await this.db.runAsync(
          `UPDATE financial_moves SET amount_cents = ? WHERE transaction_id = ?`,
          [estimativa, entry.transaction_id!]
        );
      });
    } else {
      // Não sobrou nada para guardar — a transferência pendente sai (nada retido).
      // v70: ORDEM IMPORTA — a entrada referencia a transação (FK): sai antes.
      await this.db.transactionAsync(async () => {
        await this.db.runAsync('DELETE FROM savings_entries WHERE id = ?', [entry.id]);
        await this.db.runAsync('DELETE FROM financial_moves WHERE transaction_id = ?', [entry.transaction_id!]);
        await this.db.runAsync('DELETE FROM transactions WHERE id = ?', [entry.transaction_id!]);
      });
    }
  }

  /**
   * v70 (BUG 1.3) — mês a partir do qual o "Fechamento do Mês" rege o saldo:
   * o mês de criação do plano CLOSING ativo mais antigo (o saldo carregado dos
   * meses seguintes foi retido para a poupança). null = sem plano ativo.
   */
  private async closingSinceMonth(): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ created_at: string }>(
      `SELECT created_at FROM savings_plans WHERE mode = 'CLOSING' AND is_active = 1 ORDER BY created_at ASC LIMIT 1`
    );
    if (!row) return null;
    return row.created_at.slice(0, 10).slice(0, 7);
  }

  /**
   * Estimativa do FECHAMENTO: saldo do dia previsto NO FIM do mês visto;
   * positivo e ainda sem estimativa confirmada no mês → sugerir.
   */
  async getClosingSuggestion(month: string, reservedCents?: number): Promise<{ amountCents: number } | null> {
    const hasClosingPlan = await this.db.getFirstAsync<{ id: string }>(
      `SELECT id FROM savings_plans WHERE mode = 'CLOSING' AND is_active = 1 LIMIT 1`
    );
    if (!hasClosingPlan) return null;
    const confirmed = await this.db.getFirstAsync<{ id: string }>(
      `SELECT id FROM savings_entries WHERE month = ? AND kind = 'CLOSING'`,
      [month]
    );
    if (confirmed) return null;
    const endDate = `${month}-${String(lastDayNumberOf(month)).padStart(2, '0')}`;
    const dual = await this.balance.getDailyBalancesDual(month);
    const allocations = reservedCents ?? await this.getClosingAllocationsCents(month);
    const finalBalance = subtractAllocationsCents(dual.previsto[endDate] ?? 0, [allocations]);
    if (finalBalance <= 0) return null;
    return { amountCents: finalBalance };
  }

  private async getClosingAllocationsCents(month: string): Promise<number> {
    const [budgetSetting, wishlistSetting] = await Promise.all([
      this.db.getFirstAsync<{ value: string | null }>(
        'SELECT value FROM app_settings WHERE key = ?',
        [SETTING_KEYS.budgetsAtivado]
      ),
      this.db.getFirstAsync<{ value: string | null }>(
        'SELECT value FROM app_settings WHERE key = ?',
        [SETTING_KEYS.wishlistNaHome]
      ),
    ]);

    const allocations: number[] = [];
    if (budgetSetting?.value === '1') {
      const budgetSummary = await new BudgetService(this.db).getMonthSummary(month);
      allocations.push(budgetSummary.remainingCents);
    }
    if (wishlistSetting?.value === '1') {
      const wishlist = await this.db.getFirstAsync<{ remaining: number }>(
        `SELECT COALESCE(SUM(MAX(0, target_cents - reserved_cents)), 0) AS remaining
           FROM wishlist_items
          WHERE status = 'OPEN'`
      );
      allocations.push(wishlist?.remaining ?? 0);
    }
    return allocations.reduce(
      (total, amount) => total + (Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)) : 0),
      0
    );
  }

  /** Confirma a estimativa do fechamento: cria a transferência (previsão se futura). */
  async confirmClosing(month: string, amountCents: number): Promise<void> {
    const plan = await this.db.getFirstAsync<{ id: string; source_account_id: string | null; target_account_id: string | null }>(
      `SELECT id, source_account_id, target_account_id FROM savings_plans
        WHERE mode = 'CLOSING' AND is_active = 1 ORDER BY created_at DESC LIMIT 1`
    );
    if (!plan || !plan.source_account_id || !plan.target_account_id)
      throw new Error('Nenhum plano de fechamento de mês ativo — cadastre em Ações › Poupança');
    if (amountCents <= 0) throw new Error('Estimativa deve ser maior que zero');
    await this.db.transactionAsync(async () => {
      const already = await this.db.getFirstAsync<{ id: string }>(
        `SELECT id FROM savings_entries WHERE month = ? AND kind = 'CLOSING'`,
        [month]
      );
      if (already) throw new Error('A estimativa deste mês já foi confirmada');
      const date = dayInMonth(month, lastDayNumberOf(month));
      const tx = await this.transactions.createTransfer({
        fromAccountId: plan.source_account_id!,
        toAccountId: plan.target_account_id!,
        amountCents,
        date,
        description: 'Poupança · fechamento do mês',
      });
      await this.db.runAsync(
        `INSERT INTO savings_entries (id, plan_id, month, kind, amount_cents, status, transaction_id, created_at)
         VALUES (?, ?, ?, 'CLOSING', ?, 'FORECAST', ?, ?)`,
        [genId(), plan.id, month, amountCents, tx.id, nowIso()]
      );
    });
  }

  // ------------------------------------------------------- resumo ----

  /** Resumo do mês para o card no Fluxo (previsão · falta · efetivadas). */
  async getMonthOverview(month: string): Promise<SavingsMonthOverview> {
    // v70 (BUG 1.2) — RECALCULO NA HORA do Fechamento Mensal: com plano CLOSING
    // ativo e estimativa já confirmada (transferência pendente), o valor é
    // refeito A CADA leitura — alterou data/valor/lançamento/transferência →
    // o número acompanha (nada de valor travado/antigo). Antes de ler qualquer
    // coisa: as leituras abaixo já saem atualizadas.
    const closingPlanExists = await this.db.getFirstAsync<{ id: string }>(
      `SELECT id FROM savings_plans WHERE mode = 'CLOSING' AND is_active = 1 LIMIT 1`
    );
    const closingAllocations = closingPlanExists ? await this.getClosingAllocationsCents(month) : 0;
    try {
      await this.recalcClosing(month, closingAllocations);
    } catch {
      // recálculo é best-effort — nunca derruba o resumo
    }
    const rows = await this.db.getAllAsync<{
      id: string;
      plan_id: string | null;
      month: string;
      kind: SavingsMode;
      amount_cents: number;
      transaction_id: string | null;
      tx_status: string | null;
      tx_date: string | null;
      tx_description: string | null;
    }>(
      `SELECT se.id, se.plan_id, se.month, se.kind, se.amount_cents,
              se.transaction_id, t.status AS tx_status,
              t.occurred_on AS tx_date, t.description AS tx_description
         FROM savings_entries se
         LEFT JOIN transactions t ON t.id = se.transaction_id
        WHERE se.month = ? AND se.transaction_id IS NOT NULL
        ORDER BY t.occurred_on`,
      [month]
    );
    const entries: SavingsEntryView[] = rows.map((r) => ({
      id: r.id,
      planId: r.plan_id,
      month: r.month,
      kind: r.kind,
      amountCents: r.amount_cents,
      effected: r.tx_status === 'CONFIRMED',
      transactionId: r.transaction_id,
      date: r.tx_date,
      description: r.tx_description,
    }));
    let planned = entries.reduce((a, b) => a + b.amountCents, 0);
    const effectedEntries = entries.filter((e) => e.effected).reduce((a, b) => a + b.amountCents, 0);
    // v68 — planos cadastrados com os números do mês (nome, modalidade, valor,
    // guardado/falta) — é o que o card do Fluxo passa a mostrar ao expandir.
    const planRows = await this.listPlans();
    const plans: SavingsPlanView[] = planRows
      .filter((p) => p.is_active === 1)
      .map((p) => {
        const own = entries.filter((e) => e.planId === p.id);
        const guardado = own.filter((e) => e.effected).reduce((a, b) => a + b.amountCents, 0);
        const programado = own.reduce((a, b) => a + b.amountCents, 0);
        return {
          planId: p.id,
          mode: p.mode,
          name: p.target_name ? `Poupança · ${p.target_name}` : 'Poupança',
          modalityLabel:
            p.mode === 'MONTHLY'
              ? `Mensal (todo dia ${p.day_of_month ?? 1})`
              : 'Fechamento do mês',
          amountCents: p.mode === 'MONTHLY' ? p.amount_cents : null,
          dayOfMonth: p.day_of_month,
          guardadoCents: guardado,
          faltaCents: Math.max(0, programado - guardado),
        };
      });
    let closingSuggestion: { amountCents: number } | null = null;
    try {
      closingSuggestion = await this.getClosingSuggestion(month, closingAllocations);
    } catch {
      closingSuggestion = null;
    }
    // v70 (BUG 1.3) — mês em que o "Fechamento do Mês" passou a reger o saldo
    let closingSince: string | null = null;
    try {
      closingSince = await this.closingSinceMonth();
    } catch {
      closingSince = null;
    }
    const monthlyProgrammed = entries
      .filter((entry) => entry.kind === 'MONTHLY')
      .reduce((total, entry) => total + entry.amountCents, 0);
    const closingEntryAmount = entries
      .filter((entry) => entry.kind === 'CLOSING')
      .reduce((total, entry) => total + entry.amountCents, 0);
    const hasMonthlyPlan = plans.some((plan) => plan.mode === 'MONTHLY');
    const hasClosingPlan = plans.some((plan) => plan.mode === 'CLOSING');
    let programado = 0;
    if (hasMonthlyPlan) {
      const endDate = `${month}-${String(lastDayNumberOf(month)).padStart(2, '0')}`;
      const daily = await this.balance.getDailyBalancesDual(month);
      const endBalance = hasClosingPlan
        ? closingSuggestion?.amountCents ?? closingEntryAmount
        : daily.efetivado[endDate] ?? 0;
      programado = Math.max(0, endBalance - monthlyProgrammed);
    } else if (hasClosingPlan) {
      programado = closingSuggestion?.amountCents ?? closingEntryAmount;
    }
    // v69 — "Já transferido p/ poupança" também conta as TRANSFERÊNCIAS AVULSAS
    // do usuário (CONFIRMADAS no mês) cujo DESTINO é a conta de poupança de um
    // plano ativo — sem contar duas vezes (entries) e sem misturar com as
    // reservas da Lista de Desejos (que ficam separadas).
    let avulsas = 0;
    try {
      const row = await this.db.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(t.amount_cents), 0) AS total
           FROM transactions t
          WHERE t.type = 'TRANSFER' AND t.status = 'CONFIRMED'
            AND substr(t.occurred_on, 1, 7) = ?
            AND t.transfer_account_id IN (
              SELECT target_account_id FROM savings_plans WHERE is_active = 1 AND target_account_id IS NOT NULL
            )
            AND t.id NOT IN (SELECT transaction_id FROM savings_entries WHERE transaction_id IS NOT NULL)
            AND t.id NOT IN (SELECT transaction_id FROM wishlist_reserves WHERE transaction_id IS NOT NULL)`,
        [month]
      );
      avulsas = row?.total ?? 0;
    } catch {
      avulsas = 0;
    }
    const effected = effectedEntries + avulsas;
    return {
      entries,
      plannedCents: planned,
      programadoCents: programado,
      effectedCents: effected,
      // v69 — "Falta transferir": programado − já transferido (ex.: preciso
      // transferir 10 mil e já transferei 500 → falta 9.500).
      remainingCents: Math.max(0, programado - effected),
      closingSuggestion,
      closingSinceMonth: closingSince,
      plans,
    };
  }

  /**
   * v68 — AJUSTE DIÁRIO do "Saldo do dia" pela POUPANÇA (regra do usuário:
   * "... + previsto na Poupança" — o dinheiro da poupança continua sendo do
   * usuário, então a transferência programada/efetivada NÃO diminui o saldo
   * do dia: ela VOLTA ao número a partir da data em que o saldo base a subtraiu).
   *
   * Na modalidade FECHAMENTO DO MÊS não nasce transferência programada — nada
   * entra no previsto (o restante do saldo é que vira poupança); quando o
   * usuário confirma a estimativa, a transferência criada volta ao número
   * pela mesma regra (o restante é da poupança).
   *
   * Devolve, por dia do mês, o quanto DEVOLVE ao saldo: só compensa o que a
   * transferência tirou das contas do escopo (origem fora = 0; origem no
   * escopo e destino também = 0 — ficou dentro do escopo).
   */
  async getMonthFluxAdjust(month: string, scopeAccountIds: string[]): Promise<{
    previsto: Record<string, number>;
    efetivado: Record<string, number>;
  }> {
    const out = { previsto: {} as Record<string, number>, efetivado: {} as Record<string, number> };
    const lastDay = lastDayNumberOf(month);
    for (let day = 1; day <= lastDay; day++) {
      const ymd = `${month}-${String(day).padStart(2, '0')}`;
      out.previsto[ymd] = 0;
      out.efetivado[ymd] = 0;
    }
    const rows = await this.db.getAllAsync<{
      id: string; tx_status: string | null; tx_date: string | null;
      impact_prev: number | null; impact_efet: number | null;
    }>(
      `SELECT se.id, t.status AS tx_status, t.occurred_on AS tx_date,
              (SELECT COALESCE(SUM(CASE WHEN fm.direction = 'CREDIT' THEN fm.amount_cents ELSE -fm.amount_cents END), 0)
                 FROM financial_moves fm
                WHERE fm.transaction_id = t.id
                  AND fm.account_id IN (${scopeAccountIds.length ? scopeAccountIds.map(() => '?').join(',') : "''"})) AS impact_prev,
              (SELECT COALESCE(SUM(CASE WHEN fm.direction = 'CREDIT' THEN fm.amount_cents ELSE -fm.amount_cents END), 0)
                 FROM financial_moves fm
                WHERE fm.transaction_id = t.id AND fm.status = 'CONFIRMED'
                  AND fm.account_id IN (${scopeAccountIds.length ? scopeAccountIds.map(() => '?').join(',') : "''"})) AS impact_efet
         FROM savings_entries se
         JOIN transactions t ON t.id = se.transaction_id
        WHERE se.month = ?`,
      [
        ...scopeAccountIds, ...scopeAccountIds, month,
      ] as never
    );
    for (const r of rows) {
      if (!r.tx_date) continue;
      const pendingImpact = r.impact_prev ?? 0;
      const efetImpact = r.impact_efet ?? 0;
      // Compensa só o que a transferência TIROU do escopo (impacto negativo).
      const back = (v: number) => (v < 0 ? -v : 0);
      for (let day = 1; day <= lastDay; day++) {
        const ymd = `${month}-${String(day).padStart(2, '0')}`;
        if (ymd < r.tx_date) continue;
        if (r.tx_status === 'PENDING') {
          out.previsto[ymd] += back(pendingImpact);
        } else if (r.tx_status === 'CONFIRMED') {
          out.efetivado[ymd] += back(efetImpact);
        }
      }
    }
    return out;
  }
}
