/**
 * RecurrenceService — recorrências mensais (Fase: lançamentos automáticos).
 * Idempotência por external_ref_id = 'REC:{ruleId}:{YYYY-MM}' (ARQ-003).
 * Chamado no boot do app e manualmente em Ajustes.
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { todaySP, monthOf, monthAdd, dayInMonth, lastDayNumberOf, addDays, noonUtcIsoOf } from '../lib/dates';
import { RecurrenceRepo } from '../repos/misc';
import { TransactionRepo, FinancialMoveRepo } from '../repos/finance';
import type { RecurrenceRuleRow } from '../repos/misc';
import type { TransactionRow as TxRow, FinancialMoveRow } from '../repos/finance';
import type { CardInvoiceService } from './CardInvoiceService';

export interface RunRecurrencesResult {
  processedRules: number;
  createdTransactions: number;
  skippedMonths: number;
}

/** v9: resultado da propagação para meses futuros (previsão). */
export interface RunForecastResult {
  processedRules: number;
  createdForecast: number;
}

export class RecurrenceService {
  private rules: RecurrenceRepo;
  private transactions: TransactionRepo;
  private moves: FinancialMoveRepo;

  constructor(
    private db: DbDriver,
    /** v10: serviço de faturas — contas fixas em CARTÃO entram na fatura do mês. */
    private invoices?: CardInvoiceService
  ) {
    this.rules = new RecurrenceRepo(db);
    this.transactions = new TransactionRepo(db);
    this.moves = new FinancialMoveRepo(db);
  }

  /** Regra tem destino válido (conta OU cartão)? */
  private hasTarget(rule: RecurrenceRuleRow): boolean {
    return !!rule.account_id || !!rule.card_id;
  }

  /**
   * v68 "Repetir" — cadência da regra: step_days (7 = semanal) tem precedência;
   * sem step_days vale step_months (1=mensal, 2=bimestral, 3=trimestral,
   * 6=semestral, 12=anual). Regra antiga (coluna ausente/default) = mensal.
   */
  private stepOf(rule: RecurrenceRuleRow): { stepMonths: number; stepDays: number | null } {
    const sd = rule.step_days ?? null;
    if (sd != null && sd > 0) return { stepMonths: 1, stepDays: Math.trunc(sd) };
    return { stepMonths: Math.max(1, Math.trunc(rule.step_months ?? 1)), stepDays: null };
  }

  /** v68: para regra de passo MENSAL, este mês é mês de ocorrência? (cadência a partir do mês inicial) */
  private isCadenceMonth(rule: RecurrenceRuleRow, month: string, stepMonths: number): boolean {
    if (stepMonths <= 1) return true;
    const toIdx = (ym: string) => parseInt(ym.slice(0, 4), 10) * 12 + parseInt(ym.slice(5, 7), 10);
    return (toIdx(month) - toIdx(monthOf(rule.start_date))) % stepMonths === 0;
  }

  /**
   * v10 — conta fixa em CARTÃO: registra a compra do mês na fatura do cartão
   * (regra de corte pelo dia de fechamento). Erros de fatura fechada não
   * derrubam o processamento em lote — a ocorrência fica sem item de fatura
   * e pode ser registrada depois.
   * v12 — RECEITA fixa no cartão: entra como item NEGATIVO (crédito que abate
   * o total da fatura). O registro é idempotente por transação (CardInvoice).
   */
  private async registerCardOccurrence(rule: RecurrenceRuleRow, txId: string, ymd: string): Promise<void> {
    if (!rule.card_id || !this.invoices) return;
    try {
      const itemAmount = rule.type === 'INCOME' ? -rule.amount_cents : rule.amount_cents;
      // v26: "mês da fatura" escolhido na criação da fixa = deslocamento sobre a
      // regra de corte (vale para todas as ocorrências). 0 = regra padrão.
      let reference: string | undefined;
      const offset = rule.invoice_month_offset ?? 0;
      if (offset !== 0) {
        const card = await this.db.getFirstAsync<{ closing_day: number }>('SELECT closing_day FROM cards WHERE id = ?', [rule.card_id]);
        if (card) reference = monthAdd(this.invoices.referenceMonthForDate(card, ymd), offset);
      }
      await this.invoices.registerPurchase(rule.card_id, txId, itemAmount, noonUtcIsoOf(ymd), reference);
    } catch {
      // fatura fechada/limite de meses — o lançamento existe; a fatura pode ser ajustada depois
    }
  }

  /** Executa todas as regras ativas até o mês atual. Idempotente (pode rodar N vezes).
   *  v68 "Repetir": regras BIMESTRAL/TRIMESTRAL/SEMESTRAL/ANUAL só geram nos
   *  meses da cadência; SEMANAL itera de 7 em 7 dias a partir do início. */
  async runDueRecurrences(today?: string): Promise<RunRecurrencesResult> {
    const todayYmd = today ?? todaySP();
    const currentMonth = monthOf(todayYmd);
    const result: RunRecurrencesResult = { processedRules: 0, createdTransactions: 0, skippedMonths: 0 };

    const active = await this.rules.getActive();
    for (const rule of active) {
      if (!this.hasTarget(rule)) continue;
      result.processedRules++;
      const { stepMonths, stepDays } = this.stepOf(rule);

      if (stepDays) {
        // ---------- SEMANAL: uma ocorrência a cada step_days, pelo dia exato ----------
        let ymd = rule.start_date;
        let guard = 0;
        while (ymd <= todayYmd && !(rule.end_date && ymd > rule.end_date) && guard < 600) {
          guard++;
          const created = await this.ensureMonthTransaction(rule, monthOf(ymd), ymd, `REC:${rule.id}:D:${ymd}`);
          if (created) result.createdTransactions++; else result.skippedMonths++;
          ymd = addDays(ymd, stepDays);
        }
        continue;
      }

      const endMonth = rule.end_date ? monthOf(rule.end_date) : currentMonth;
      let month = monthOf(rule.start_date);
      let guard = 0;
      while (month <= currentMonth && month <= endMonth && guard < 120) {
        guard++;
        if (!this.isCadenceMonth(rule, month, stepMonths)) {
          month = monthAdd(month, 1);
          continue;
        }
        const day = Math.min(rule.day_of_month, lastDayNumberOf(month));
        const ymd = dayInMonth(month, day);
        if (ymd > todayYmd || (rule.end_date && ymd > rule.end_date)) {
          result.skippedMonths++;
          month = monthAdd(month, 1);
          continue;
        }

        const created = await this.ensureMonthTransaction(rule, month, ymd);
        if (created) result.createdTransactions++;
        month = monthAdd(month, 1);
      }
    }
    return result;
  }

  /**
   * v9 — PROPAGAÇÃO PARA MESES FUTUROS (Fluxo): contas fixas (Fixo) nascem nos
   * próximos meses como PREVISÃO — transação com status PENDING e SEM movimento
   * financeiro (não afetam o saldo até serem marcadas como Pago/Recebido).
   * Idempotente pela mesma chave REC:{ruleId}:{YYYY-MM} (ARQ-003).
   * Roda no boot do app, ao criar uma conta fixa e manualmente via Ajustes.
   * v11: horizonte padrão ampliado para 24 meses (o Fluxo navega ±18 meses).
   * v16 (bugs 1 e 2): a propagação passa a incluir TAMBÉM o MÊS VIGENTE —
   * quando o dia da fixa ainda não chegou (ymd > hoje), a ocorrência do mês
   * atual nasce como PREVISÃO (PENDING) e aparece no Fluxo do mês corrente com
   * o botão Pago/Não pago (Recebido/Não recebido). Antes o mês vigente ficava
   * sem lançamento quando o dia era futuro (runDueRecurrences pulava e a
   * previsão começava só no mês seguinte). Meses ANTERIORES ao início da regra
   * não geram previsão (guarda start_date).
   * v68 "Repetir": cadências BIMESTRAL+ geram só nos meses delas; SEMANAL
   * itera de 7 em 7 dias (ref por DATA — pode haver mais de 1 no mês).
   */
  async runForecast(monthsAhead = 24, today?: string): Promise<RunForecastResult> {
    const todayYmd = today ?? todaySP();
    const result: RunForecastResult = { processedRules: 0, createdForecast: 0 };
    const active = await this.rules.getActive();
    for (const rule of active) {
      if (!this.hasTarget(rule)) continue;
      result.processedRules++;
      const { stepMonths, stepDays } = this.stepOf(rule);
      const horizon = monthAdd(monthOf(todayYmd), monthsAhead);

      if (stepDays) {
        // ---------- SEMANAL: previsões de 7 em 7 dias até o horizonte ----------
        let ymd = rule.start_date;
        let guard = 0;
        while (ymd <= horizon && !(rule.end_date && ymd > rule.end_date) && guard < 600) {
          guard++;
          if (ymd > todayYmd) {
            const created = await this.ensureForecastTransaction(rule, monthOf(ymd), ymd, `REC:${rule.id}:D:${ymd}`);
            if (created) result.createdForecast++;
          }
          ymd = addDays(ymd, stepDays);
        }
        continue;
      }

      const lastMonth = rule.end_date ? monthOf(rule.end_date) : horizon;
      // v16 (bugs 1 e 2): a propagação começa NO MÊS VIGENTE — a ocorrência do
      // mês atual com dia ainda não vencido nasce como previsão (PENDING).
      let month = monthOf(todayYmd);
      let guard = 0;
      while (month <= lastMonth && guard <= monthsAhead + 1) {
        guard++;
        // v68: fora da cadência (bimestral/trimestral/semestral/anual) não nasce
        if (!this.isCadenceMonth(rule, month, stepMonths)) {
          month = monthAdd(month, 1);
          continue;
        }
        const day = Math.min(rule.day_of_month, lastDayNumberOf(month));
        const ymd = dayInMonth(month, day);
        if (rule.end_date && ymd > rule.end_date) {
          month = monthAdd(month, 1);
          continue;
        }
        // v16: antes do início da regra não existe previsão (guarda start_date)
        if (ymd < rule.start_date) {
          month = monthAdd(month, 1);
          continue;
        }
        // v16: no MÊS VIGENTE, ocorrência já vencida (ymd <= hoje) é papel do
        // runDueRecurrences (nasce efetivada) — não vira previsão.
        if (month === monthOf(todayYmd) && ymd <= todayYmd) {
          month = monthAdd(month, 1);
          continue;
        }
        const created = await this.ensureForecastTransaction(rule, month, ymd);
        if (created) result.createdForecast++;
        month = monthAdd(month, 1);
      }
    }
    return result;
  }

  /** Cria a transação do mês se ainda não existir (idempotente).
   *  v9: ocorrência prevista (PENDING) que chegou ao vencimento é PROMOVIDA —
   *  vira CONFIRMED e ganha o movimento financeiro (entra no saldo).
   *  v10: meses EXCLUÍDOS pelo usuário (exclusão física) não são recriados.
   *  v68: refKey permite ref por DATA (conta fixa SEMANAL). */
  private async ensureMonthTransaction(rule: RecurrenceRuleRow, month: string, ymd: string, refKey?: string): Promise<boolean> {
    if (await this.isMonthExcluded(rule.id, month)) return false;
    const externalRef = refKey ?? `REC:${rule.id}:${month}`;
    const existing = await this.transactions.findByExternalRef('RECURRENCE', externalRef);
    if (existing) {
      if (existing.status === 'PENDING') {
        return this.promotePending(existing.id, rule, ymd);
      }
      return false;
    }

    return this.db.transactionAsync(async () => {
      // Double-check dentro da transação (proteção contra corrida)
      const again = await this.transactions.findByExternalRef('RECURRENCE', externalRef);
      if (again) return false;
      const tx: TxRow = {
        id: genId(),
        kind: 'SIMPLE',
        type: rule.type,
        amount_cents: rule.amount_cents,
        occurred_on: ymd,
        occurred_at: noonUtcIsoOf(ymd),
        description: rule.description,
        category_id: rule.category_id ?? null,
        account_id: rule.account_id,
        transfer_account_id: null,
        card_id: rule.card_id ?? null,
        source_system: 'RECURRENCE',
        external_ref_id: externalRef,
        recurrence_rule_id: rule.id,
        status: 'CONFIRMED',
      };
      await this.transactions.insert(tx);
      if (rule.card_id) {
        // v10: fixo em CARTÃO não gera move — a compra entra na FATURA do mês
        await this.registerCardOccurrence(rule, tx.id, ymd);
        return true;
      }
      const move: FinancialMoveRow = {
        id: genId(),
        transaction_id: tx.id,
        installment_id: null,
        invoice_payment_id: null,
        account_id: rule.account_id!,
        direction: rule.type === 'INCOME' ? 'CREDIT' : 'DEBIT',
        amount_cents: rule.amount_cents,
        effective_date: ymd,
        status: 'CONFIRMED',
      };
      await this.moves.insert(move);
      return true;
    });
  }

  /** v9: promoção de previsão (PENDING) para efetivado (CONFIRMED + move/fatura). */
  private async promotePending(txId: string, rule: RecurrenceRuleRow, ymd: string): Promise<boolean> {
    return this.db.transactionAsync(async () => {
      const moves = await this.moves.getByTransaction(txId);
      const hasConfirmed = moves.some((m) => m.status === 'CONFIRMED');
      await this.transactions.setStatus(txId, 'CONFIRMED');
      if (rule.card_id) {
        // v10: fixo em CARTÃO — garante o item na fatura (sem movimento)
        await this.registerCardOccurrence(rule, txId, ymd);
        return true;
      }
      if (!hasConfirmed) {
        await this.moves.insert({
          id: genId(),
          transaction_id: txId,
          installment_id: null,
          invoice_payment_id: null,
          account_id: rule.account_id!,
          direction: rule.type === 'INCOME' ? 'CREDIT' : 'DEBIT',
          amount_cents: rule.amount_cents,
          effective_date: ymd,
          status: 'CONFIRMED',
        });
      }
      return true;
    });
  }

  /** v9: cria a ocorrência de PREVISÃO do mês futuro (PENDING, sem move).
   *  v10: meses EXCLUÍDOS pelo usuário (exclusão física) não são recriados. */
  private async ensureForecastTransaction(rule: RecurrenceRuleRow, month: string, ymd: string, refKey?: string): Promise<boolean> {
    if (await this.isMonthExcluded(rule.id, month)) return false;
    const externalRef = refKey ?? `REC:${rule.id}:${month}`;
    const existing = await this.transactions.findByExternalRef('RECURRENCE', externalRef);
    if (existing) return false;
    return this.db.transactionAsync(async () => {
      const again = await this.transactions.findByExternalRef('RECURRENCE', externalRef);
      if (again) return false;
      const tx: TxRow = {
        id: genId(),
        kind: 'SIMPLE',
        type: rule.type,
        amount_cents: rule.amount_cents,
        occurred_on: ymd,
        occurred_at: noonUtcIsoOf(ymd),
        description: rule.description,
        category_id: rule.category_id ?? null,
        account_id: rule.account_id,
        transfer_account_id: null,
        card_id: rule.card_id ?? null,
        source_system: 'RECURRENCE',
        external_ref_id: externalRef,
        recurrence_rule_id: rule.id,
        status: 'PENDING', // previsão: não afeta o saldo até ser marcada Pago/Recebido
      };
      await this.transactions.insert(tx);
      // v12 (bug B): fixa no CARTÃO — a previsão JÁ entra na fatura do mês
      // futuro (idempotente; a promoção do mês não duplica o item)
      if (rule.card_id) {
        await this.registerCardOccurrence(rule, tx.id, ymd);
      }
      return true;
    });
  }

  /** v10: o mês foi excluído pelo usuário? (tabela recurrence_exclusions) */
  private async isMonthExcluded(ruleId: string, month: string): Promise<boolean> {
    const row = await this.db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM recurrence_exclusions WHERE rule_id = ? AND occurred_month = ?',
      [ruleId, month]
    );
    return (row?.n ?? 0) > 0;
  }

  async createRule(input: {
    description: string;
    type: 'INCOME' | 'EXPENSE';
    amountCents: number;
    dayOfMonth: number;
    startDate?: string;
    endDate?: string | null;
    accountId?: string | null;
    cardId?: string | null;
    categoryId?: string | null; // v7.1
    groupTransactionId?: string | null; // v11: grupo consolidado de origem
    /** v26: cartão — "mês da fatura" da 1ª ocorrência (vira deslocamento sobre o corte). */
    invoiceMonth?: string | null;
    /** v68 "Repetir": cadência — 1=mensal (padrão), 2=bimestral, 3=trimestral,
     *  6=semestral, 12=anual. */
    stepMonths?: number;
    /** v68 "Repetir": cadência em dias (7=semanal) — sobrepõe stepMonths. */
    stepDays?: number | null;
  }): Promise<RecurrenceRuleRow> {
    if (input.dayOfMonth < 1 || input.dayOfMonth > 31) throw new Error('Dia do mês deve estar entre 1 e 31');
    if (input.amountCents <= 0) throw new Error('Valor deve ser maior que zero');
    const row: RecurrenceRuleRow = {
      id: genId(),
      description: input.description,
      type: input.type,
      amount_cents: input.amountCents,
      frequency: 'MONTHLY',
      day_of_month: input.dayOfMonth,
      start_date: input.startDate ?? todaySP(),
      end_date: input.endDate ?? null,
      account_id: input.accountId ?? null,
      card_id: input.cardId ?? null,
      is_active: 1,
      category_id: input.categoryId ?? null,
      group_transaction_id: input.groupTransactionId ?? null,
      step_months: input.stepDays && input.stepDays > 0 ? 1 : Math.max(1, input.stepMonths ?? 1),
      step_days: input.stepDays && input.stepDays > 0 ? Math.trunc(input.stepDays) : null,
    };
    if (input.cardId && input.invoiceMonth) {
      const card = await this.db.getFirstAsync<{ closing_day: number }>('SELECT closing_day FROM cards WHERE id = ?', [input.cardId]);
      if (card && this.invoices) {
        const suggested = this.invoices.referenceMonthForDate(card, row.start_date);
        const [sy, sm] = suggested.split('-').map(Number);
        const [cy, cm] = input.invoiceMonth.split('-').map(Number);
        row.invoice_month_offset = (cy * 12 + cm) - (sy * 12 + sm);
      }
    }
    await this.rules.insert(row);
    return row;
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await this.rules.setActive(id, active);
  }

  /**
   * Exclui as ocorrências da regra A PARTIR de fromYmd, inclusive (v7.0.6):
   *  - v10: as transações da regra com occurred_on >= fromYmd são APAGADAS
   *    fisicamente do banco (movimentos junto) — sem marca "Cancelado".
   *  - Ocorrências anteriores ficam intocadas (histórico preservado).
   *  - A regra recebe end_date = véspera de fromYmd: os próximos meses deixam
   *    de nascer.
   *  v18 (bug 4): ocorrências em CARTÃO tinham item de fatura (invoice_items)
   *  apontando para a transação — apagar a transação estourava
   *  "FOREIGN KEY constraint failed" e NADA era excluído (o erro aparecia no
   *  app ao excluir conta fixa no cartão). Agora o item sai primeiro e o total
   *  da fatura é recalculado, igual na exclusão de uma linha comum.
   */
  async excludeFrom(ruleId: string, fromYmd: string): Promise<{ voided: number }> {
    const rule = await this.rules.getById(ruleId);
    if (!rule) throw new Error('Regra não encontrada');
    return this.db.transactionAsync(async () => {
      const rows = await this.db.getAllAsync<{ id: string; card_id: string | null }>(
        'SELECT id, card_id FROM transactions WHERE recurrence_rule_id = ? AND occurred_on >= ?',
        [ruleId, fromYmd]
      );
      for (const tx of rows) {
        // Libera referências cruzadas antes de apagar (OFX, despensa, NFC-e)
        await this.db.runAsync('UPDATE ofx_statement_lines SET matched_transaction_id = NULL WHERE matched_transaction_id = ?', [tx.id]);
        await this.db.runAsync('UPDATE pantry_ledger SET transaction_id = NULL WHERE transaction_id = ?', [tx.id]);
        await this.db.runAsync('UPDATE nfce_documents SET transaction_id = NULL WHERE transaction_id = ?', [tx.id]);
        // v18 (bug 4): item de fatura da ocorrência em cartão sai ANTES da transação
        if (tx.card_id) {
          const item = await this.db.getFirstAsync<{ invoice_id: string }>(
            'SELECT invoice_id FROM invoice_items WHERE transaction_id = ?',
            [tx.id]
          );
          await this.db.runAsync('DELETE FROM invoice_items WHERE transaction_id = ?', [tx.id]);
          if (item) await this.invoices?.rebuildTotals(item.invoice_id);
        }
        await this.moves.deleteByTransaction(tx.id);
        await this.transactions.delete(tx.id);
      }
      await this.rules.setEndDate(ruleId, addDays(fromYmd, -1));
      return { voided: rows.length };
    });
  }

  /**
   * Edita a regra de conta fixa (v7.0.5) — "da competência atual em diante":
   *  - Lançamentos de meses ANTERIORES nunca são tocados (histórico imutável, ARQ-005).
   *  - A competência do mês corrente, se já existir com o valor antigo e estiver
   *    CONFIRMED, é reposicionada para o novo valor (applyToCurrentMonth, default true).
   *  - As próximas competências passam a nascer com o novo valor automaticamente.
   * v17 (bug 2): o Fluxo reflete a alteração DE IMEDIATO — todas as
   *  ocorrências da competência atual em diante são SINCRONIZADAS na hora:
   *  novo valor, novo dia (data reposicionada em cada mês, com o movimento
   *  financeiro acompanhando) e nova descrição. Antes só o valor da
   *  competência CONFIRMED do mês corrente mudava; as previsões (PENDING) do
   *  mês vigente e dos meses seguintes continuavam com valor/dia antigos e o
   *  Fluxo mostrava o dado velho até a tela ser reaberta.
   */
  async updateRule(id: string, input: {
    amountCents?: number;
    dayOfMonth?: number;
    description?: string;
    applyToCurrentMonth?: boolean;
    today?: string; // injeção para testes/consistência com runDueRecurrences
  }): Promise<void> {
    const rule = await this.rules.getById(id);
    if (!rule) throw new Error('Regra não encontrada');
    if (input.amountCents != null && input.amountCents <= 0) throw new Error('Valor deve ser maior que zero');
    if (input.dayOfMonth != null && (input.dayOfMonth < 1 || input.dayOfMonth > 31)) {
      throw new Error('Dia do mês deve estar entre 1 e 31');
    }

    await this.rules.updateRule(id, {
      amount_cents: input.amountCents,
      day_of_month: input.dayOfMonth,
      description: input.description?.trim() || undefined,
    });

    const todayYmd = input.today ?? todaySP();
    const curMonth = monthOf(todayYmd);
    const newAmount = input.amountCents ?? rule.amount_cents;
    const newDay = input.dayOfMonth ?? rule.day_of_month;
    const newDescription = input.description?.trim() || rule.description;
    const amountChanged = input.amountCents != null && input.amountCents !== rule.amount_cents;
    // Regra EFETIVA pós-update (regravada na posição nova) — usada ao re-registrar
    // o item de fatura das ocorrências de cartão.
    const effectiveRule: RecurrenceRuleRow = {
      ...rule,
      amount_cents: newAmount,
      day_of_month: newDay,
      description: newDescription,
    };
    /** Nova data da ocorrência do mês: dia novo, limitado ao último dia do mês. */
    const reposiciona = (month: string): string =>
      dayInMonth(month, Math.min(newDay, lastDayNumberOf(month)));

    // --- v17: sincroniza valor/dia/descrição de uma ocorrência (linha do Fluxo).
    const syncOcorrencia = async (txId: string, ymd: string, opts: { confirmed: boolean }) => {
      if (opts.confirmed) {
        if (amountChanged && (input.applyToCurrentMonth ?? true)) {
          await this.transactions.updateAmount(txId, newAmount);
          await this.moves.updateAmountByTransaction(txId, newAmount);
        }
        await this.db.runAsync('UPDATE transactions SET description = ? WHERE id = ?', [newDescription, txId]);
      } else {
        await this.db.runAsync(
          'UPDATE transactions SET amount_cents = ?, description = ? WHERE id = ?',
          [newAmount, newDescription, txId]
        );
      }
      if (rule.card_id) {
        // Cartão: o item da fatura acompanha valor/data (idempotente; muda de
        // fatura quando o novo dia cruza o fechamento).
        await this.registerCardOccurrence(effectiveRule, txId, ymd);
      }
    };

    // 1) COMPETÊNCIA DO MÊS CORRENTE — valor/dia/descrição novos na tela Fluxo.
    const cur = await this.transactions.findByExternalRef('RECURRENCE', `REC:${id}:${curMonth}`);
    if (cur && cur.status !== 'VOIDED') {
      const novoYmd = reposiciona(curMonth);
      const confirmed = cur.status === 'CONFIRMED';
      await syncOcorrencia(cur.id, novoYmd, { confirmed });
      if (novoYmd !== cur.occurred_on) {
        // Reposiciona a DATA — a transação e o movimento financeiro junto.
        await this.db.runAsync(
          'UPDATE transactions SET occurred_on = ?, occurred_at = ? WHERE id = ?',
          [novoYmd, noonUtcIsoOf(novoYmd), cur.id]
        );
        if (confirmed) {
          await this.db.runAsync(
            'UPDATE financial_moves SET effective_date = ? WHERE transaction_id = ?',
            [novoYmd, cur.id]
          );
        }
      }
    }

    // 2) PREVISÕES DOS MESES SEGUINTES (PENDING) — novo valor/dia/descrição.
    const pendentes = await this.db.getAllAsync<{ id: string; occurred_on: string }>(
      `SELECT id, occurred_on FROM transactions
        WHERE recurrence_rule_id = ? AND status = 'PENDING' AND occurred_on >= ?`,
      [id, dayInMonth(monthAdd(curMonth, 1), 1)]
    );
    for (const row of pendentes) {
      const month = row.occurred_on.slice(0, 7);
      const novoYmd = reposiciona(month);
      await syncOcorrencia(row.id, novoYmd, { confirmed: false });
      if (novoYmd !== row.occurred_on) {
        await this.db.runAsync(
          'UPDATE transactions SET occurred_on = ?, occurred_at = ? WHERE id = ?',
          [novoYmd, noonUtcIsoOf(novoYmd), row.id]
        );
      }
    }
  }

  async listRules(): Promise<RecurrenceRuleRow[]> {
    return this.rules.getAll();
  }

  /**
   * v11 (bug “Fixo/Parcelado somem nos meses seguintes”): garante que a
   * PREVISÃO das contas fixas cubra o mês que o usuário está vendo no Fluxo.
   * Idempotente (mesma chave REC:{ruleId}:{YYYY-MM}) — criar de novo não duplica.
   */
  async ensureForecastThrough(targetMonth: string, today?: string): Promise<RunForecastResult> {
    const current = monthOf(today ?? todaySP());
    // v16 (bugs 1 e 2): targetMonth == current TAMBÉM propaga — a previsão do
    // mês vigente (dia ainda não vencido) passa a existir desde a abertura do
    // Fluxo, não só a dos meses seguintes.
    if (targetMonth < current) return { processedRules: 0, createdForecast: 0 };
    const toIdx = (ym: string) => parseInt(ym.slice(0, 4), 10) * 12 + parseInt(ym.slice(5, 7), 10);
    const diff = Math.min(Math.max(toIdx(targetMonth) - toIdx(current), 1), 36);
    return this.runForecast(diff, today);
  }
}
