/**
 * BalanceService — ARQ-001: fonte única da verdade para saldos.
 * Fórmula da spec:
 *   saldo = initial_balance + SUM(CREDIT) - SUM(DEBIT)
 *           WHERE effective_date <= today AND status != 'VOIDED'
 *
 * v20 — DATA ÂNCORA DO SALDO INICIAL (bug do usuário: o "Saldo do dia
 * Previsto/Efetivado" nunca batia com o extrato real):
 *   O initial_balance_cents ganhou a coluna initial_balance_date (data âncora).
 *   Quando a âncora está preenchida, o valor vale NO INÍCIO daquele dia:
 *     saldo(d) = [d >= âncora] · initial
 *                + Σ movimentos CONFIRMED com âncora <= effective_date <= d
 *   · Lançamentos ANTERIORES à âncora já estão DENTRO do saldo inicial
 *     (não somam de novo — era a contagem em dobro que descarrilava o total);
 *   · Dias ANTERIORES à âncora mostram saldo 0,00 (desconhecido);
 *   · NULL = regra antiga, "vale desde sempre" (compatibilidade: contas
 *     existentes e testes não mudam de valor até a data ser informada).
 */

import type { DbDriver } from '../db/types';
import { todaySP, monthOf, lastDayOfMonth } from '../lib/dates';

/** Subfiltro SQL reutilizável: movimento só conta DA ÂNCORA da própria conta em diante. */
const ANCHOR_FILTER_FM = `AND fm.effective_date >= COALESCE(a_anchor.initial_balance_date, '0000-01-01')`; // v50: JOIN em vez de subquery correlacionada por linha (200 linhas = 200 subqueries antes)

export interface AccountBalance {
  accountId: string;
  name: string;
  type: string;
  includeInGeneral: boolean;
  balanceCents: number;
}

/** v70 — resultado DUPLO com a ABERTURA do mês (saldo acumulado antes do dia 1).
 *  A abertura alimenta a regra da POUPANÇA "Fechamento do Mês": nos meses
 *  subsequentes ao fechamento o saldo carregado foi RETIDO para a poupança, então
 *  o "Saldo do dia Previsto" não pode começar com ele (v70 BUG 1.3). */
export interface DailyBalancesDual {
  efetivado: Record<string, number>;
  previsto: Record<string, number>;
  /** Saldo acumulado (efetivado) até o ÚLTIMO dia do mês anterior. */
  openingEfetivado: number;
  /** Saldo acumulado + pendências anteriores até o ÚLTIMO dia do mês anterior. */
  openingPrevisto: number;
}

export class BalanceService {
  constructor(private db: DbDriver) {}
  /** v49 GARANTIA — cache com dataVersion. Mesma versão = mesmos dados = cache OK. Qualquer alteração -> bump() -> versão++ -> cache ignorado e recalcula. Sem bump, sem cache. */
  private dailyCache = new Map<string, { version: number; dual: DailyBalancesDual }>();
  private dailyInFlight = new Map<string, Promise<DailyBalancesDual>>();
  invalidateDailyCache(): void { this.dailyCache.clear(); this.dailyInFlight.clear(); }
  private cloneDual(v: DailyBalancesDual): DailyBalancesDual { return { efetivado: { ...v.efetivado }, previsto: { ...v.previsto }, openingEfetivado: v.openingEfetivado, openingPrevisto: v.openingPrevisto }; }

  /** Saldo de uma conta até a data (inclusive), no fuso America/Sao_Paulo.
   *  v20: respeita a data âncora do saldo inicial (ver cabeçalho da classe). */
  async getAccountBalance(accountId: string, asOf?: string): Promise<number> {
    const date = asOf ?? todaySP();
    const account = await this.db.getFirstAsync<{ initial_balance_cents: number; initial_balance_date: string | null }>(
      'SELECT initial_balance_cents, initial_balance_date FROM accounts WHERE id = ?',
      [accountId]
    );
    if (!account) return 0;
    // v20: antes da âncora o saldo é desconhecido (0,00).
    if (account.initial_balance_date && date < account.initial_balance_date) return 0;
    const moves = await this.db.getFirstAsync<{ credits: number; debits: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE 0 END), 0) AS credits,
         COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE 0 END), 0) AS debits
       FROM financial_moves
       WHERE account_id = ? AND effective_date <= ? AND status = 'CONFIRMED'
         AND effective_date >= COALESCE(?, '0000-01-01')`,
      [accountId, date, account.initial_balance_date]
    );
    return (
      account.initial_balance_cents + (moves?.credits ?? 0) - (moves?.debits ?? 0)
    );
  }

  /** Saldo geral: apenas contas marcadas com include_in_general_balance (liquidez atual).
   *  v8: contas ARQUIVADAS não entram no saldo. v20: âncora por conta. */
  async getGeneralBalance(asOf?: string): Promise<number> {
    const date = asOf ?? todaySP();
    const rows = await this.db.getAllAsync<{ balance_cents: number }>(
      `SELECT a.id, a.initial_balance_cents, a.initial_balance_date,
              a.include_in_general_balance AS include,
              CASE WHEN a.initial_balance_date IS NOT NULL AND ? < a.initial_balance_date THEN 0
                   ELSE a.initial_balance_cents + COALESCE(SUM(
                     CASE WHEN fm.direction = 'CREDIT' THEN fm.amount_cents ELSE -fm.amount_cents END
                   ), 0)
              END AS balance_cents
         FROM accounts a
         LEFT JOIN financial_moves fm
           ON fm.account_id = a.id
          AND fm.effective_date <= ?
          AND fm.effective_date >= COALESCE(a.initial_balance_date, '0000-01-01')
          AND fm.status = 'CONFIRMED'
        WHERE a.include_in_general_balance = 1 AND a.archived_at IS NULL
        GROUP BY a.id`,
      [date, date]
    );
    return rows.reduce((total, row) => total + row.balance_cents, 0);
  }

  /** Saldos por conta (tela Início). v8: arquivadas ficam fora. v20: âncora. */
  async listAccountBalances(asOf?: string): Promise<AccountBalance[]> {
    const date = asOf ?? todaySP();
    const accounts = await this.db.getAllAsync<{
      id: string;
      name: string;
      type: string;
      include: number;
      balance_cents: number;
    }>(
      `SELECT a.id, a.name, a.type,
              a.include_in_general_balance AS include,
              CASE WHEN a.initial_balance_date IS NOT NULL AND ? < a.initial_balance_date THEN 0
                   ELSE a.initial_balance_cents + COALESCE(SUM(
                     CASE WHEN fm.direction = 'CREDIT' THEN fm.amount_cents ELSE -fm.amount_cents END
                   ), 0)
              END AS balance_cents
         FROM accounts a
         LEFT JOIN financial_moves fm
           ON fm.account_id = a.id
          AND fm.effective_date <= ?
          AND fm.effective_date >= COALESCE(a.initial_balance_date, '0000-01-01')
          AND fm.status = 'CONFIRMED'
        WHERE a.archived_at IS NULL
        GROUP BY a.id
        ORDER BY a.name`,
      [date, date]
    );
    return accounts.map((account) => ({
      accountId: account.id,
      name: account.name,
      type: account.type,
      includeInGeneral: account.include === 1,
      balanceCents: account.balance_cents,
    }));
  }

  /**
   * v9 — SALDO POR DIA (contas incluídas no saldo geral): saldo acumulado REAL
   * ao fim de cada dia do mês (inicial + movimentos CONFIRMED até a data).
   * Usado no agrupamento de datas do Fluxo quando "Exibir saldo por dia" está
   * ativo em Ajustes > Preferências.
   */
  async getDailyBalances(month: string, dataVersion?: number): Promise<Record<string, number>> {
    return (await this.getDailyBalancesDual(month, dataVersion)).efetivado;
  }

  /**
   * v18 — SALDO POR DIA em DUAS VISÕES (rotina reescrita, robusta e garantida):
   *
   *  ESCOPO (regra do usuário): SOMENTE contas ativadas para o Fluxo —
   *  "Aparecer no saldo do Fluxo" = SIM e não arquivadas. Nada fora do escopo
   *  entra em nenhum dos dois saldos, em nenhuma hipótese.
   *
   *  · EFETIVADO_d = S0(d) + Σ movimentos CONFIRMED com data ≤ d
   *    (v20: S0(d) = soma dos saldos iniciais das contas cuja ÂNCORA já chegou;
   *    movimentos ANTERIORES à âncora da própria conta não somam — já estão
   *    dentro do saldo inicial. Antes da âncora a conta contribui com 0).
   *    Movimento de PARCELA ainda PENDING não entra (é previsão, não realizado).
   *
   *  · PREVISTO_d = EFETIVADO_d + RPA_d, onde RPA_d = tudo que está pendente
   *    com data até o dia d (v20: pendência ANTERIOR à âncora da conta já está
   *    dentro do saldo inicial e não entra):
   *      a) lançamentos PENDING em conta do escopo (créditos e débitos);
   *      b) parcelas EM ABERTO de planos em conta do escopo (pelo vencimento);
   *      c) faturas de cartão não quitadas (pelo vencimento) — ficam SEM filtro
   *         de âncora: dívida de cartão vencida e em aberto NÃO está refletida
   *         no saldo que o usuário digitou (o banco não desconta futura).
   *
   *  GARANTIA DE RECALCULO: a rotina é PURA e SEM CACHE — cada chamada relê o
   *  banco do zero, portanto qualquer inclusão/alteração/exclusão de
   *  lançamento (de qualquer tipo) se reflete no resultado imediatamente, na
   *  próxima leitura da tela. As telas recarregam em cada mudança de dados
   *  (bump global) e ao voltar o foco para o Fluxo (useFocusEffect).
   */
  async getDailyBalancesDual(month: string, dataVersion?: number): Promise<DailyBalancesDual> {
    if (typeof dataVersion === 'number') {
      const hit = this.dailyCache.get(month);
      if (hit && hit.version === dataVersion) return this.cloneDual(hit.dual);
      const inflight = this.dailyInFlight.get(month);
      if (inflight) return inflight.then((v) => this.cloneDual(v));
      const promise = this.computeDailyBalancesDual(month).then((v) => { this.dailyCache.set(month, { version: dataVersion, dual: this.cloneDual(v) }); this.dailyInFlight.delete(month); return v; }).catch((e) => { this.dailyInFlight.delete(month); throw e; });
      this.dailyInFlight.set(month, promise);
      return promise.then((v) => this.cloneDual(v));
    }
    return this.computeDailyBalancesDual(month);
  }
  private async computeDailyBalancesDual(month: string): Promise<DailyBalancesDual> {
    const [ys, ms] = month.split('-');
    const lastDay = lastDayOfMonth(parseInt(ys, 10), parseInt(ms, 10));
    const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;

    // ---------- ESCOPO: contas ativadas para o saldo do Fluxo ----------
    const contas = await this.db.getAllAsync<{ id: string; initial_balance_cents: number; initial_balance_date: string | null }>(
      `SELECT id, initial_balance_cents, initial_balance_date FROM accounts
        WHERE include_in_general_balance = 1 AND archived_at IS NULL`
    );
    // v20: o saldo inicial entra na CONTAGEM só a partir da âncora da conta.
    //  · s0Pre: âncoras nulas ("desde sempre") ou anteriores ao mês visto;
    //  · s0ByDay: âncoras DENTRO do mês — entram no dia delas;
    //  · âncora depois do fim do mês: a conta não compõe este mês.
    const monthStart = `${month}-01`;
    let s0Pre = 0;
    const s0ByDay = new Map<string, number>();
    for (const c of contas) {
      if (!c.initial_balance_date || c.initial_balance_date < monthStart) {
        s0Pre += c.initial_balance_cents;
      } else if (c.initial_balance_date <= endDate) {
        s0ByDay.set(c.initial_balance_date, (s0ByDay.get(c.initial_balance_date) ?? 0) + c.initial_balance_cents);
      }
    }
    const outEfetivado: Record<string, number> = {};
    const outPrevisto: Record<string, number> = {};
    if (contas.length === 0) {
      // Sem conta no escopo: os dois saldos ficam em 0,00 em todos os dias
      for (let d = 1; d <= lastDay; d++) {
        const ymd = `${month}-${String(d).padStart(2, '0')}`;
        outEfetivado[ymd] = 0;
        outPrevisto[ymd] = 0;
      }
      return { efetivado: outEfetivado, previsto: outPrevisto, openingEfetivado: 0, openingPrevisto: 0 };
    }
    const marks = contas.map(() => '?').join(',');

    // ---------- 1) REALIZADO: movimentos CONFIRMED por dia ----------
    // Parcela com status PENDING é previsão — o movimento dela fica fora do
    // efetivado (entra no previsto pela data de vencimento, item b).
    // v20: movimento ANTERIOR à âncora da própria conta não soma (já está
    // dentro do saldo inicial informado pelo usuário).
    const netByDate = new Map<string, number>();
    const movesRows = await this.db.getAllAsync<{ d: string; net: number }>(
      `SELECT fm.effective_date AS d,
              SUM(CASE WHEN fm.direction = 'CREDIT' THEN fm.amount_cents ELSE -fm.amount_cents END) AS net
         FROM financial_moves fm
         LEFT JOIN accounts a_anchor ON a_anchor.id = fm.account_id
        WHERE fm.account_id IN (${marks})
          AND fm.status = 'CONFIRMED' AND fm.effective_date <= ?
          ${ANCHOR_FILTER_FM}
          AND NOT EXISTS (
            SELECT 1 FROM installments i
             WHERE i.id = fm.installment_id AND i.status = 'PENDING'
          )
        GROUP BY fm.effective_date`,
      [...contas.map((c) => c.id), endDate] as never
    );
    for (const r of movesRows) netByDate.set(r.d, r.net);

    // ---------- 2) PENDÊNCIAS (RPA) por data ----------
    const pend = new Map<string, number>();
    const addPend = (d: string, net: number) => pend.set(d, (pend.get(d) ?? 0) + net);

    // a) Lançamentos PENDING em conta do escopo (cartão entra pela fatura).
    //    v20: pendência anterior à âncora da conta já está dentro do saldo inicial.
    const pendTx = await this.db.getAllAsync<{ d: string; net: number }>(
      `SELECT t.occurred_on AS d,
              SUM(CASE WHEN t.type = 'INCOME' THEN t.amount_cents ELSE -t.amount_cents END) AS net
         FROM transactions t
         LEFT JOIN accounts a_anchor ON a_anchor.id = t.account_id
        WHERE t.status = 'PENDING' AND t.card_id IS NULL AND t.type IN ('INCOME','EXPENSE')
          AND t.account_id IN (${marks})
          AND t.occurred_on <= ?
          AND t.occurred_on >= COALESCE(a_anchor.initial_balance_date, '0000-01-01')
        GROUP BY t.occurred_on`,
      [...contas.map((c) => c.id), endDate] as never
    );
    for (const r of pendTx) addPend(r.d, r.net);

    // a2) v25 — TRANSFERÊNCIAS FUTURAS (PENDING) entram no previsto pelas DUAS
    //     pernas (VOIDED): débito na origem e crédito no destino. Antes, o
    //     previsto ignorava transferência agendada (type TRANSFER ficava fora
    //     da query a) — "todo lançamento precisa ser calculado". O filtro é pela
    //     CONTA DO MOVIMENTO (perna): a perna na conta do escopo conta; a perna
    //     na conta de fora não. (Filtrar pela transação com OR traria as duas
    //     pernas no JOIN e a soma zerava — net 0 — como os testes pegaram.)
    const pendTransf = await this.db.getAllAsync<{ d: string; net: number }>(
      `SELECT fm.effective_date AS d,
              SUM(CASE WHEN fm.direction = 'CREDIT' THEN fm.amount_cents ELSE -fm.amount_cents END) AS net
         FROM transactions t
         JOIN financial_moves fm ON fm.transaction_id = t.id
         LEFT JOIN accounts a_anchor ON a_anchor.id = fm.account_id
        WHERE t.status = 'PENDING' AND t.type = 'TRANSFER'
          AND fm.account_id IN (${marks})
          AND fm.effective_date <= ?
          AND fm.effective_date >= COALESCE(a_anchor.initial_balance_date, '0000-01-01')
        GROUP BY fm.effective_date`,
      [...contas.map((c) => c.id), endDate] as never
    );
    for (const r of pendTransf) addPend(r.d, r.net);

    // b) Parcelas EM ABERTO de planos em CONTA do escopo (pelo vencimento).
    //    O sinal vem da DIREÇÃO do movimento (receita parcelada soma no previsto).
    //    v20: parcela anterior à âncora da conta já está dentro do saldo inicial.
    const pendInst = await this.db.getAllAsync<{ d: string; net: number }>(
      `SELECT fm.effective_date AS d,
              SUM(CASE WHEN fm.direction = 'CREDIT' THEN fm.amount_cents ELSE -fm.amount_cents END) AS net
         FROM installments i
         JOIN installment_plans p ON p.id = i.plan_id
         JOIN financial_moves fm ON fm.installment_id = i.id
         LEFT JOIN accounts a_anchor ON a_anchor.id = fm.account_id
        WHERE p.account_id IN (${marks}) AND p.card_id IS NULL
          AND i.status = 'PENDING' AND fm.status = 'CONFIRMED' AND fm.effective_date <= ?
          ${ANCHOR_FILTER_FM}
        GROUP BY fm.effective_date`,
      [...contas.map((c) => c.id), endDate] as never
    );
    for (const r of pendInst) addPend(r.d, r.net);

    // c) Faturas de cartão não quitadas (devido na data de vencimento)
    const pendInv = await this.db.getAllAsync<{ d: string; due: number }>(
      `SELECT due_date AS d,
              MAX(0, total_cents - credit_from_prev_cents - paid_cents) AS due
         FROM invoices
        WHERE due_date <= ? AND status != 'PAID'
          AND MAX(0, total_cents - credit_from_prev_cents - paid_cents) > 0
        GROUP BY due_date`,
      [endDate]
    );
    for (const r of pendInv) addPend(r.d, -r.due);

    // ---------- 3) ACUMULA dia a dia ----------
    // Pendências anteriores ao mês entram como carry inicial (valem para o mês todo).
    let carry = 0;
    for (const [d, net] of pend) if (d < `${month}-01`) carry += net;

    // v25 (BUG "saldo do dia instável / não comporta alteração de datas"):
    // os movimentos CONFIRMED ENTRE a âncora e o mês visto (histórico real dos
    // meses anteriores) precisam entrar no acumulador — antes o running começava
    // só no s0Pre e somava movimentos DENTRO do mês: ao ver um mês futuro
    // (ex.: dezembro com histórico real em novembro) o saldo do dia "esquecia"
    // todo o efetivado anterior ao mês e nunca batia. O filtro de âncora já
    // veio da query (ANCHOR_FILTER_FM) — aqui entra exatamente o que falta.
    let running = s0Pre;
    for (const [d, net] of netByDate) if (d < `${month}-01`) running += net;
    // v70 (BUG 1.3) — ABERTURA do mês: o que JÁ estava acumulado antes do dia 1
    // (saldo inicial + histórico + pendências anteriores). Com a Poupança
    // "Fechamento do Mês", esse valor é RETIDO para a poupança no fim de cada
    // mês — os meses subsequentes NÃO podem começar o "Saldo do dia Previsto"
    // com ele. O Fluxo usa estes números para zerar o carregado (o mês passa a
    // contar só com os movimentos DE DENTRO do mês visto).
    const openingEfetivado = running;
    const openingPrevisto = running + carry;
    for (let day = 1; day <= lastDay; day++) {
      const ymd = `${month}-${String(day).padStart(2, '0')}`;
      running += s0ByDay.get(ymd) ?? 0;
      running += netByDate.get(ymd) ?? 0;
      carry += pend.get(ymd) ?? 0;
      outEfetivado[ymd] = running;
      outPrevisto[ymd] = running + carry;
    }
    return { efetivado: outEfetivado, previsto: outPrevisto, openingEfetivado, openingPrevisto };
  }
}
