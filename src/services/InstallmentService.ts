/**
 * InstallmentService — parcelamentos com VISÃO DUAL (spec v7):
 *   - cash_flow: parcela vencida na data (installments.due_date).
 *   - cost_report: total da compra na data original (transactions.occurred_on).
 *   REGRA DE OURO: nunca somar ambos no mesmo relatório — retornamos estruturas separadas.
 *
 * installment_plans: card_id XOR account_id (CHECK).
 *  - Cartão: cada parcela vira item de fatura no mês do seu vencimento.
 *  - Conta: cada parcela gera financial_move future-dated (saldo só conta a partir da data).
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { addMonths, addDays, monthAdd, nowIso, noonUtcIsoOf, todaySP } from '../lib/dates';
import { divideCents } from '../lib/money';
import { InstallmentPlanRepo, InstallmentRepo, TransactionRepo, FinancialMoveRepo } from '../repos/finance';
import { InvoiceItemRepo } from '../repos/invoices';
import type { InstallmentRow, InstallmentPlanRow } from '../repos/finance';
import { CardInvoiceService } from './CardInvoiceService';

export interface CreatePlanInput {
  description: string;
  mode: 'DIVIDE_TOTAL' | 'FIXED_PER_MONTH';
  totalCents?: number;      // obrigatório em DIVIDE_TOTAL
  fixedAmountCents?: number; // obrigatório em FIXED_PER_MONTH
  totalInstallments: number;
  firstDueDate: string;
  purchaseDate?: string;    // data da compra (cost_report)
  cardId?: string | null;
  accountId?: string | null;
  categoryId?: string | null;
  groupTransactionId?: string | null; // v11: grupo consolidado de origem
  /** v14 (bug 2): direção do plano — EXPENSE (padrão) ou INCOME (receita
   *  parcelada, ex.: aluguel em 36 meses no consolidado). Em CONTA as parcelas
   *  geram movimentos de CRÉDITO; no CARTÃO os itens entram NEGATIVOS na
   *  fatura (abatem o total a pagar). */
  type?: 'EXPENSE' | 'INCOME';
  /** v26: no CARTÃO, "mês da fatura" da 1ª parcela (as demais seguem mês a mês).
   *  Sem isso vale a regra de corte pela data de vencimento. */
  firstInvoiceMonth?: string | null;
  /** v68 "Repetir": cadência das parcelas — meses entre parcelas (1=mensal,
   *  2=bimestral, 3=trimestral, 6=semestral, 12=anual). */
  stepMonths?: number;
  /** v68 "Repetir": cadência em dias (7=semanal) — sobrepõe stepMonths. */
  stepDays?: number | null;
}

export class InstallmentService {
  private plans: InstallmentPlanRepo;
  private installments: InstallmentRepo;
  private transactions: TransactionRepo;
  private moves: FinancialMoveRepo;
  private invoiceItems: InvoiceItemRepo;

  constructor(private db: DbDriver, private invoiceService: CardInvoiceService) {
    this.plans = new InstallmentPlanRepo(db);
    this.installments = new InstallmentRepo(db);
    this.transactions = new TransactionRepo(db);
    this.moves = new FinancialMoveRepo(db);
    this.invoiceItems = new InvoiceItemRepo(db);
  }

  /** Cria plano + transação consolidada + parcelas (tudo em uma transação — ARQ-004).
   *  v14 (bug 2): planos do tipo INCOME (receita parcelada) — em CONTA as
   *  parcelas geram movimentos de CRÉDITO; no CARTÃO os itens entram NEGATIVOS
   *  na fatura (abatem o total a pagar, igual à receita fixa no cartão). */
  async createPlan(input: CreatePlanInput): Promise<{ planId: string; transactionId: string }> {
    const n = input.totalInstallments;
    if (n < 1) throw new Error('Número de parcelas inválido');
    if (input.mode === 'DIVIDE_TOTAL') {
      if (!input.totalCents || input.totalCents <= 0) throw new Error('Informe o valor total');
    } else {
      if (!input.fixedAmountCents || input.fixedAmountCents <= 0) throw new Error('Informe o valor da parcela');
    }
    if (!input.cardId && !input.accountId) throw new Error('Escolha um cartão ou uma conta');
    if (input.cardId && input.accountId) throw new Error('Escolha apenas cartão OU conta');
    const planType = input.type ?? 'EXPENSE';

    const amounts =
      input.mode === 'DIVIDE_TOTAL'
        ? divideCents(input.totalCents!, n)
        : new Array(n).fill(input.fixedAmountCents!);
    const planTotal =
      input.mode === 'DIVIDE_TOTAL' ? input.totalCents! : amounts.reduce((a, b) => a + b, 0);

    const purchaseDate = input.purchaseDate ?? input.firstDueDate;

    return this.db.transactionAsync(async () => {
      // Transação original CONSOLIDATED (evento; sem move imediato)
      const txId = genId();
      await this.transactions.insert({
        id: txId,
        kind: 'CONSOLIDATED',
        type: planType,
        amount_cents: planTotal,
        occurred_on: purchaseDate,
        occurred_at: noonUtcIsoOf(purchaseDate),
        description: input.description,
        category_id: input.categoryId ?? null,
        account_id: null,
        transfer_account_id: null,
        card_id: input.cardId ?? null,
        source_system: 'INSTALLMENT',
        external_ref_id: `PLAN:${txId}`,
        recurrence_rule_id: null,
        status: 'CONFIRMED',
      });

      const planId = genId();
      // v68 "Repetir": cadência das parcelas — semanal (7 em 7 dias) ou a cada
      // N meses (bimestral/trimestral/semestral/anual). Padrão: mensal.
      const stepMonths = input.stepDays && input.stepDays > 0 ? 1 : Math.max(1, input.stepMonths ?? 1);
      const stepDays = input.stepDays && input.stepDays > 0 ? Math.trunc(input.stepDays) : null;
      const dueOf = (i: number): string =>
        stepDays ? addDays(input.firstDueDate, i * stepDays) : addMonths(input.firstDueDate, i * stepMonths);
      await this.plans.insert({
        id: planId,
        original_transaction_id: txId,
        total_installments: n,
        mode: input.mode,
        total_cents: input.mode === 'DIVIDE_TOTAL' ? input.totalCents! : null,
        fixed_amount_cents: input.mode === 'FIXED_PER_MONTH' ? input.fixedAmountCents! : null,
        first_due_date: input.firstDueDate,
        card_id: input.cardId ?? null,
        account_id: input.accountId ?? null,
        group_transaction_id: input.groupTransactionId ?? null,
        step_months: stepMonths,
        step_days: stepDays,
      });

      for (let i = 0; i < n; i++) {
        const dueDate = dueOf(i);
        const instId = genId();
        await this.installments.insert({
          id: instId,
          plan_id: planId,
          sequence_number: i + 1,
          amount_cents: amounts[i],
          due_date: dueDate,
          invoice_id: null,
          status: 'PENDING',
        });
        if (input.cardId) {
          // Cartão: item na fatura do mês do vencimento (receita = item NEGATIVO)
          const signed = planType === 'INCOME' ? -amounts[i] : amounts[i];
          // v68: com cadência mensal múltipla o "mês da fatura" salta N por N;
          // semanal segue a regra de corte pela própria data de vencimento.
          const refMonth =
            input.firstInvoiceMonth
              ? stepDays
                ? undefined
                : monthAdd(input.firstInvoiceMonth, i * stepMonths)
              : undefined;
          await this.invoiceService.registerInstallment(
            input.cardId, instId, signed, dueDate, refMonth
          );
        } else if (input.accountId) {
          // Conta: move future-dated vinculada à parcela (receita = CRÉDITO)
          await this.moves.insert({
            id: genId(),
            transaction_id: null,
            installment_id: instId,
            invoice_payment_id: null,
            account_id: input.accountId,
            direction: planType === 'INCOME' ? 'CREDIT' : 'DEBIT',
            amount_cents: amounts[i],
            effective_date: dueDate,
            status: 'CONFIRMED',
          });
        }
      }
      return { planId, transactionId: txId };
    });
  }

  /** v14: tipo do plano (EXPENSE/INCOME) — derivado do lançamento de origem
   *  (âncora). Planos desvinculados (só com parcelas pagas) tratam como EXPENSE
   *  — eles nunca chegam às edições de parcelas em aberto. */
  private async planTypeOf(plan: InstallmentPlanRow): Promise<'EXPENSE' | 'INCOME'> {
    if (!plan.original_transaction_id) return 'EXPENSE';
    const tx = await this.transactions.getById(plan.original_transaction_id);
    return tx?.type === 'INCOME' ? 'INCOME' : 'EXPENSE';
  }

  /**
   * Edita os valores do plano A PARTIR DA PARCELA ATUAL (v7.0.5):
   *  - Plano de parcela fixa: `fixedAmountCents` vira o valor de todas as pendentes.
   *  - Plano de dividir total: `remainingTotalCents` é distribuído entre as pendentes
   *    (resto na última, sem perder centavos).
   *  - Parcelas PAID/CANCELED, seus itens de fatura e moves NÃO são alterados (ARQ-005).
   *  - O lançamento consolidado é recalculado para pagas + novo restante,
   *    mantendo o relatório de custo verdadeiro.
   *  v14 (bug 2): itens de fatura de planos INCOME permanecem NEGATIVOS.
   *  v17 (bug 3): a EDIÇÃO aceita os DOIS modos de cálculo (igual ao Novo
   *    Lançamento) — o usuário escolhe "Dividir total" OU "Parcela fixa" na
   *    hora de alterar, independentemente do modo de origem do plano; o modo
   *    escolhido passa a valer para o plano (total_cents/fixed_amount_cents
   *    são regravados na métrica nova).
   */
  async updateFromCurrent(planId: string, input: {
    mode?: 'DIVIDE_TOTAL' | 'FIXED_PER_MONTH'; // v17: modo escolhido na edição
    fixedAmountCents?: number;    // modo FIXED_PER_MONTH
    remainingTotalCents?: number; // modo DIVIDE_TOTAL
    fromSequence?: number;        // default: primeira parcela em aberto
  }): Promise<{ fromSequence: number; updatedCount: number; newTotalCents: number; mode: 'DIVIDE_TOTAL' | 'FIXED_PER_MONTH' }> {
    const plan = await this.plans.getById(planId);
    if (!plan) throw new Error('Plano não encontrado');
    const all = await this.installments.getByPlan(planId);

    const firstPending = all.find((i) => i.status === 'PENDING');
    if (!firstPending) throw new Error('Não há parcelas em aberto para alterar');

    const from = input.fromSequence ?? firstPending.sequence_number;
    if (from < 1 || from > plan.total_installments) throw new Error('Parcela inicial inválida');

    const pending = all.filter((i) => i.status === 'PENDING' && i.sequence_number >= from);
    if (pending.length === 0) throw new Error('Não há parcelas em aberto a partir dessa parcela');

    const paidSum = all.filter((i) => i.status === 'PAID').reduce((a, b) => a + b.amount_cents, 0);

    // v17 (bug 3): o modo pode ser TROCADO na edição — default é o modo do plano.
    const mode = input.mode ?? plan.mode;
    let newAmounts: number[];
    if (mode === 'FIXED_PER_MONTH') {
      const fixed = input.fixedAmountCents ?? 0;
      if (fixed <= 0) throw new Error('Informe o novo valor da parcela');
      newAmounts = pending.map(() => fixed);
    } else {
      const remaining = input.remainingTotalCents ?? 0;
      if (remaining <= 0) throw new Error('Informe o novo total restante');
      newAmounts = divideCents(remaining, pending.length);
    }
    const newGrandTotal = paidSum + newAmounts.reduce((a, b) => a + b, 0);

    await this.db.transactionAsync(async () => {
      const income = (await this.planTypeOf(plan)) === 'INCOME';
      for (let k = 0; k < pending.length; k++) {
        const inst = pending[k];
        await this.installments.updateAmount(inst.id, newAmounts[k]);
        if (plan.card_id) {
          await this.invoiceService.updateInstallmentAmount(inst.id, income ? -newAmounts[k] : newAmounts[k]);
        } else if (plan.account_id) {
          await this.moves.updateAmountByInstallment(inst.id, newAmounts[k]);
        }
      }
      await this.plans.updateAmounts(
        planId,
        mode === 'DIVIDE_TOTAL' ? newGrandTotal : null,
        mode === 'FIXED_PER_MONTH' ? (input.fixedAmountCents ?? null) : null
      );
      // v17: o modo escolhido passa a valer para o plano (o quadro "divide
      // total / valor fixo" da lista passa a refletir a última edição).
      if (mode !== plan.mode) {
        await this.plans.setMode(planId, mode);
      }
      if (plan.original_transaction_id) {
        await this.transactions.updateAmount(plan.original_transaction_id, newGrandTotal);
      }
    });

    return { fromSequence: from, updatedCount: pending.length, newTotalCents: newGrandTotal, mode };
  }

  /**
   * v21 (bug 1) — EDIÇÃO COMPLETA DO PLANO (tela específica do parcelamento):
   *  o "Alterar" de um lançamento parcelado abre a tela do PRÓPRIO plano e cada
   *  campo alterado reflete estritamente nele, SEM tocar no que não mudou:
   *   · descrição/categoria/data da compra → transação-âncora;
   *   · modo (Dividir total / Parcela fixa) e valor → apenas parcelas EM ABERTO
   *     (pagas ficam intocadas — ARQ-005);
   *   · número de parcelas → cria novas continuando os vencimentos, ou cancela
   *     as em aberto que sobrarem além do novo total (pagas nunca são tocadas);
   *   · data da 1ª parcela em aberto → desloca os vencimentos das em aberto
   *     (itens de fatura e movimentos da conta acompanham);
   *   · destino (conta ↔ cartão) → movimentos/itens das em aberto migram.
   *  O total da âncora é regravado = pagas + restante (relatório de custo real).
   */
  /**
   * v26: o consolidado mudou de data — o parcelamento do grupo acompanha. Para
   * cada plano do grupo cuja 1ª parcela EM ABERTO vence no mês da data antiga,
   * a nova data vira a âncora da cadência (mesma regra do "Alterar" da parcela).
   */
  async followGroupDate(groupId: string, oldDate: string, newDate: string): Promise<void> {
    const plans = await this.db.getAllAsync<{ id: string }>(
      'SELECT id FROM installment_plans WHERE group_transaction_id = ?',
      [groupId]
    );
    for (const p of plans) {
      const first = await this.db.getFirstAsync<{ due_date: string }>(
        "SELECT due_date FROM installments WHERE plan_id = ? AND status = 'PENDING' ORDER BY sequence_number LIMIT 1",
        [p.id]
      );
      if (first && first.due_date.slice(0, 7) === oldDate.slice(0, 7)) {
        await this.updatePlanFields(p.id, { firstPendingDueDate: newDate });
      }
    }
  }

  async updatePlanFields(planId: string, patch: {
    description?: string;
    categoryId?: string | null;
    purchaseDate?: string;
    mode?: 'DIVIDE_TOTAL' | 'FIXED_PER_MONTH';
    divideTotalCents?: number;
    fixedAmountCents?: number;
    totalInstallments?: number;
    firstPendingDueDate?: string;
    accountId?: string | null;
    cardId?: string | null;
  }): Promise<{ updatedCount: number; newTotalCents: number }> {
    const plan = await this.plans.getById(planId);
    if (!plan) throw new Error('Plano não encontrado');
    const anchor = plan.original_transaction_id
      ? await this.transactions.getById(plan.original_transaction_id)
      : null;
    const planType = await this.planTypeOf(plan);
    const income = planType === 'INCOME';

    let all = await this.installments.getByPlan(planId);
    let pendings = all.filter((i) => i.status === 'PENDING');
    /** v21: total restante ANTES da mudança de contagem — redistribuir por mais
     *  parcelas NÃO pode mudar o total restante do usuário. */
    let restanteAntesDeContagem: number | null = null;

    // ---------- 1) Âncora: descrição, categoria e data da compra ----------
    if (anchor) {
      const newDesc = patch.description?.trim();
      const newDate = patch.purchaseDate && patch.purchaseDate !== anchor.occurred_on ? patch.purchaseDate : null;
      if (newDesc || patch.categoryId !== undefined || newDate) {
        await this.db.runAsync(
          `UPDATE transactions SET
             description = COALESCE(?, description),
             category_id = COALESCE(?, category_id),
             occurred_on = COALESCE(?, occurred_on),
             occurred_at = COALESCE(?, occurred_at)
           WHERE id = ?`,
          [newDesc ?? null, patch.categoryId !== undefined ? patch.categoryId : null, newDate, newDate ? noonUtcIsoOf(newDate) : null, anchor.id]
        );
      }
    }

    // ---------- 2) Data da 1ª parcela EM ABERTO: reposiciona os vencimentos ----------
    // v22 (bug 2): a nova data é a ÂNCORA da cadência das em aberto — vale para
    // mudança de MÊS e também de DIA dentro do mesmo mês (antes o delta era
    // calculado só em meses: mudar o dia não fazia NADA na tela). Os vencimentos
    // seguem mensais a partir da nova data; em CARTÃO o item da fatura acompanha
    // (sai da fatura antiga e nasce na fatura do mês do novo vencimento) e em
    // CONTA o movimento acompanha. Parcelas pagas nunca são tocadas.
    if (patch.firstPendingDueDate && pendings.length > 0) {
      const firstP = pendings[0];
      const newDue = patch.firstPendingDueDate;
      if (newDue !== firstP.due_date) {
        for (let k = 0; k < pendings.length; k++) {
          const inst = pendings[k];
          const novoVenc = addMonths(newDue, k);
          if (novoVenc === inst.due_date) continue;
          if (plan.card_id) {
            // CARTÃO: move o item para a fatura do mês do novo vencimento
            const affected = await this.db.getAllAsync<{ invoice_id: string }>(
              'SELECT DISTINCT invoice_id FROM invoice_items WHERE installment_id = ?',
              [inst.id]
            );
            await this.invoiceItems.deleteByInstallments([inst.id]);
            for (const inv of affected) await this.invoiceService.rebuildTotals(inv.invoice_id);
            await this.installments.setInvoiceId(inst.id, null);
            const signed = income ? -inst.amount_cents : inst.amount_cents;
            await this.invoiceService.registerInstallment(plan.card_id, inst.id, signed, novoVenc);
          } else {
            await this.moves.updateDateByInstallment(inst.id, novoVenc);
          }
          await this.installments.updateDueDate(inst.id, novoVenc);
        }
        all = await this.installments.getByPlan(planId);
        pendings = all.filter((i) => i.status === 'PENDING');
      }
    }

    // ---------- 3) Número de parcelas: cria/cancela (em aberto apenas) ----------
    if (patch.totalInstallments != null) {
      const novoTotal = patch.totalInstallments;
      if (!Number.isInteger(novoTotal) || novoTotal < 1) throw new Error('Número de parcelas inválido');
      const existentes = all.filter((i) => i.status !== 'CANCELED');
      const atual = existentes.length;
      restanteAntesDeContagem = pendings.reduce((a, b) => a + b.amount_cents, 0);
      const lastDue = existentes.reduce((acc, i) => (i.due_date > acc ? i.due_date : acc), plan.first_due_date);
      if (novoTotal > atual) {
        // Novas parcelas continuam a sequência e os vencimentos mensais
        for (let k = 0; k < novoTotal - atual; k++) {
          const dueDate = addMonths(lastDue, k + 1);
          const instId = genId();
          await this.installments.insert({
            id: instId,
            plan_id: planId,
            sequence_number: atual + k + 1,
            amount_cents: 1, // regravado na redistribuição abaixo
            due_date: dueDate,
            invoice_id: null,
            status: 'PENDING',
          });
        }
        all = await this.installments.getByPlan(planId);
        pendings = all.filter((i) => i.status === 'PENDING');
      } else if (novoTotal < atual) {
        // Cancela (fisicamente) as em aberto além do novo total — pagas ficam
        const cancelaveis = pendings.filter((i) => i.sequence_number > novoTotal);
        if (cancelaveis.length > 0) {
          const targetIds = cancelaveis.map((i) => i.id);
          if (plan.card_id) {
            const affected = await this.db.getAllAsync<{ invoice_id: string }>(
              `SELECT DISTINCT invoice_id FROM invoice_items WHERE installment_id IN (${targetIds.map(() => '?').join(',')})`,
              targetIds as never
            );
            await this.invoiceItems.deleteByInstallments(targetIds);
            for (const inv of affected) await this.invoiceService.rebuildTotals(inv.invoice_id);
          }
          for (const inst of cancelaveis) {
            await this.moves.deleteByInstallment(inst.id);
            await this.installments.delete(inst.id);
          }
          all = await this.installments.getByPlan(planId);
          pendings = all.filter((i) => i.status === 'PENDING');
        }
      }
    }

    if (pendings.length === 0) {
      throw new Error('Não há parcelas em aberto neste plano — o que pode mudar agora é só descrição/categoria/data da compra');
    }

    // ---------- 4) Destino (conta ↔ cartão): migra as EM ABERTO ----------
    const newAccountId = patch.accountId !== undefined ? patch.accountId : null;
    const newCardId = patch.cardId !== undefined ? patch.cardId : null;
    const destinoMudou =
      (newCardId != null && newCardId !== (plan.card_id ?? null)) ||
      (newAccountId != null && newAccountId !== (plan.account_id ?? null)) ||
      (newCardId != null && !!plan.account_id) ||
      (newAccountId != null && !!plan.card_id);
    if (destinoMudou && (newCardId || newAccountId)) {
      // limpa os efeitos atuais das em aberto (moves + itens de fatura)
      const targetIds = pendings.map((i) => i.id);
      if (plan.card_id) {
        const affected = await this.db.getAllAsync<{ invoice_id: string }>(
          `SELECT DISTINCT invoice_id FROM invoice_items WHERE installment_id IN (${targetIds.map(() => '?').join(',')})`,
          targetIds as never
        );
        await this.invoiceItems.deleteByInstallments(targetIds);
        for (const inv of affected) await this.invoiceService.rebuildTotals(inv.invoice_id);
      }
      for (const inst of pendings) {
        await this.moves.deleteByInstallment(inst.id);
        await this.installments.setInvoiceId(inst.id, null);
      }
      // regrava o destino do plano (XOR garantido pelo CHECK do schema)
      await this.plans.updateTarget(planId, newAccountId ?? null, newCardId ?? null);
      plan.account_id = newAccountId ?? null;
      plan.card_id = newCardId ?? null;
      // recria os efeitos no destino novo
      for (const inst of pendings) {
        if (plan.card_id) {
          await this.installments.setInvoiceId(inst.id, null);
          const signed = income ? -inst.amount_cents : inst.amount_cents;
          await this.invoiceService.registerInstallment(plan.card_id, inst.id, signed, inst.due_date);
        } else if (plan.account_id) {
          await this.moves.insert({
            id: genId(),
            transaction_id: null,
            installment_id: inst.id,
            invoice_payment_id: null,
            account_id: plan.account_id,
            direction: income ? 'CREDIT' : 'DEBIT',
            amount_cents: inst.amount_cents,
            effective_date: inst.due_date,
            status: 'CONFIRMED',
          });
        }
      }
    }

    // ---------- 5) Modo e valor: regrava as EM ABERTO ----------
    const mode = patch.mode ?? plan.mode;
    let newAmounts: number[] | null = null;
    // v21: a redistribuição também roda quando o NÚMERO de parcelas mudou
    // (as parcelas novas nascem com o valor correto do modo atual)
    const precisaRedistribuir =
      patch.mode !== undefined ||
      patch.divideTotalCents !== undefined ||
      patch.fixedAmountCents !== undefined ||
      patch.totalInstallments !== undefined;
    if (precisaRedistribuir) {
      if (mode === 'FIXED_PER_MONTH') {
        const fixed = patch.fixedAmountCents ?? plan.fixed_amount_cents ?? 0;
        if (fixed <= 0) throw new Error('Informe o valor da parcela');
        newAmounts = pendings.map(() => fixed);
      } else {
        // v21: sem total explícito, mantém o restante de antes da mudança de
        // contagem (o mesmo valor, espalhado pelo novo número de parcelas)
        const totalRestante =
          patch.divideTotalCents
          ?? (restanteAntesDeContagem != null && restanteAntesDeContagem > 0
            ? restanteAntesDeContagem
            : pendings.reduce((a, b) => a + b.amount_cents, 0));
        if (totalRestante <= 0) throw new Error('Informe o total restante');
        newAmounts = divideCents(totalRestante, pendings.length);
      }
      for (let k = 0; k < pendings.length; k++) {
        await this.installments.updateAmount(pendings[k].id, newAmounts[k]);
        if (plan.card_id) {
          await this.invoiceService.updateInstallmentAmount(pendings[k].id, income ? -newAmounts[k] : newAmounts[k]);
        } else if (plan.account_id) {
          await this.moves.updateAmountByInstallment(pendings[k].id, newAmounts[k]);
        }
      }
      if (mode !== plan.mode) await this.plans.setMode(planId, mode);
    }

    // ---------- 6) Totais regravados: pagas + restante ----------
    all = await this.installments.getByPlan(planId);
    const paidSum = all.filter((i) => i.status === 'PAID').reduce((a, b) => a + b.amount_cents, 0);
    const restante = all.filter((i) => i.status === 'PENDING').reduce((a, b) => a + b.amount_cents, 0);
    const newGrandTotal = paidSum + restante;
    await this.plans.updateAmounts(
      planId,
      mode === 'DIVIDE_TOTAL' ? newGrandTotal : null,
      mode === 'FIXED_PER_MONTH' ? (newAmounts ? newAmounts[0] : (plan.fixed_amount_cents ?? null)) : null
    );
    if (anchor) {
      await this.transactions.updateAmount(anchor.id, newGrandTotal);
    }

    return { updatedCount: pendings.length, newTotalCents: newGrandTotal };
  }

  /**
   * Exclui parcelas EM ABERTO (v7.0.6) — pagas NUNCA são tocadas (ARQ-005):
   *  - onlyCurrent: cancela apenas a 1ª parcela PENDING (a "atual").
   *  - Caso contrário: cancela a 1ª PENDING e todas as seguintes.
   *  - Cartão: itens derivados saem das faturas (totais recalculados).
   *  - Conta: débitos future-dated das parcelas canceladas são APAGADOS
   *    (v18 (bug 2): exclusão física — igual à regra v10; antes ficava um
   *    movimento VOIDED, o que mantinha a parcela "viva" em alguns pontos).
   *  - Lançamento consolidado é recalculado = pagas + restante em aberto.
   */
  async cancelFromCurrent(planId: string, opts: { onlyCurrent: boolean }): Promise<{
    canceledCount: number;
    firstSequence: number;
    paidCount: number;
    remainingCount: number;
    newTotalCents: number;
  }> {
    const plan = await this.plans.getById(planId);
    if (!plan) throw new Error('Plano não encontrado');
    const all = await this.installments.getByPlan(planId);

    const firstPending = all.find((i) => i.status === 'PENDING');
    if (!firstPending) throw new Error('Não há parcelas em aberto para excluir');

    const targets = opts.onlyCurrent
      ? [firstPending]
      : all.filter((i) => i.status === 'PENDING' && i.sequence_number >= firstPending.sequence_number);
    const targetIds = targets.map((i) => i.id);

    const paidSum = all.filter((i) => i.status === 'PAID').reduce((a, b) => a + b.amount_cents, 0);
    const remainingAfter = all.filter((i) => i.status === 'PENDING' && !targetIds.includes(i.id));
    const newTotal = paidSum + remainingAfter.reduce((a, b) => a + b.amount_cents, 0);

    await this.db.transactionAsync(async () => {
      for (const inst of targets) {
        await this.installments.setStatus(inst.id, 'CANCELED');
        await this.moves.deleteByInstallment(inst.id); // v18 (bug 2): exclusão física — o débito some de vez
      }
      // Fatura: remove itens derivados e recalcula os totais afetados
      if (plan.card_id && targetIds.length) {
        const affected = await this.db.getAllAsync<{ invoice_id: string }>(
          `SELECT DISTINCT invoice_id FROM invoice_items WHERE installment_id IN (${targetIds.map(() => '?').join(',')})`,
          targetIds as never
        );
        await this.invoiceItems.deleteByInstallments(targetIds);
        for (const inv of affected) {
          await this.invoiceService.rebuildTotals(inv.invoice_id);
        }
      }
      // v18 (bug 4): se não sobrou NENHUMA parcela (nenhuma paga), o plano e o
      // cabeçalho da compra são apagados — antes o total virava 0 e estourava
      // "CHECK constraint failed: amount_cents > 0" ao excluir TODAS as parcelas
      // em aberto de um parcelamento sem nenhuma paga. (countByPlan conta
      // também as CANCELADAS — por isso o critério é o NOVO TOTAL zerado.)
      if (newTotal <= 0) {
        // Nenhuma paga e nada restante: parcelas, plano e cabeçalho da compra
        // são apagados FISICAMENTE (as linhas CANCELED precisam sair antes do
        // plano — FK installments.plan_id → installment_plans).
        for (const inst of await this.installments.getByPlan(planId)) {
          if (inst.status !== 'PAID') await this.installments.delete(inst.id);
        }
        await this.plans.deletePlan(planId);
        if (plan.original_transaction_id) {
          await this.transactions.delete(plan.original_transaction_id);
        }
      } else {
        // Consolidado = pagas + restante (relatório de custo verdadeiro)
        await this.plans.updateAmounts(
          planId,
          plan.mode === 'DIVIDE_TOTAL' ? newTotal : null,
          plan.mode === 'FIXED_PER_MONTH' ? plan.fixed_amount_cents : null
        );
        if (plan.original_transaction_id) {
          await this.transactions.updateAmount(plan.original_transaction_id, newTotal);
        }
      }
    });

    return {
      canceledCount: targets.length,
      firstSequence: firstPending.sequence_number,
      paidCount: all.filter((i) => i.status === 'PAID').length,
      remainingCount: remainingAfter.length,
      newTotalCents: newTotal,
    };
  }

  /**
   * Visão dual — sempre separadas (regra de ouro).
   * v18 (bug 2): o "Fluxo mensal (caixa)" NÃO lista mais parcelas CANCELADAS —
   * a exclusão feita no Fluxo (ou aqui) se reflete NOS DOIS LUGARES na hora:
   * parcela excluída sai do Fluxo principal E desta lista simultaneamente.
   * O total do relatório de custo continua verdadeiro (pagas + restantes).
   */
  async getDualView(planId: string) {
    const plan = await this.plans.getById(planId);
    if (!plan) return null;
    const all = await this.installments.getByPlan(planId);
    const installments = all.filter((inst: InstallmentRow) => inst.status !== 'CANCELED');
    const original = plan.original_transaction_id
      ? await this.transactions.getById(plan.original_transaction_id)
      : null;

    const cashFlow = installments.map((inst: InstallmentRow) => ({
      sequence: inst.sequence_number,
      dueDate: inst.due_date,
      amountCents: inst.amount_cents,
      status: inst.status,
    }));

    const costReport = {
      occurredOn: original?.occurred_on ?? plan.first_due_date,
      totalCents: original?.amount_cents ?? cashFlow.reduce((a, b) => a + b.amountCents, 0),
      description: original?.description ?? '',
    };

    return {
      plan,
      cashFlow,          // visão 1: fluxo por vencimento
      costReport,        // visão 2: custo total na data da compra
      remainingCents: cashFlow.filter((c) => c.status === 'PENDING').reduce((a, b) => a + b.amountCents, 0),
      createdAt: nowIso(),
    };
  }

  async listPlans() {
    return this.plans.listWithSummary();
  }

  /**
   * v10 — STATUS DA PARCELA NO FLUXO (toggle Pago/Não pago, igual aos
   * lançamentos comuns):
   *  - paid = true  -> parcela PAID; o débito da conta passa a valer A PARTIR
   *    DE HOJE (o pagamento aconteceu agora — entra no saldo atual).
   *  - paid = false -> parcela PENDING (Não pago); o débito volta para a DATA
   *    DE VENCIMENTO (previsão).
   *  Aplica-se a parcelas de planos em CONTA. Parcelas de cartão são pagas
   *  pela fatura e não passam por aqui.
   */
  async setPaymentStatus(installmentId: string, paid: boolean): Promise<void> {
    const inst = await this.installments.getById(installmentId);
    if (!inst) throw new Error('Parcela não encontrada');
    if (inst.status === 'CANCELED') throw new Error('Parcela excluída — status indisponível');
    await this.db.transactionAsync(async () => {
      await this.installments.setStatus(installmentId, paid ? 'PAID' : 'PENDING');
      const moves = await this.moves.getByInstallment(installmentId);
      for (const m of moves) {
        if (m.status !== 'CONFIRMED') continue;
        await this.moves.updateMove(m.id, { effective_date: paid ? todaySP() : inst.due_date });
      }
    });
  }

  /**
   * v10 — EXCLUSÃO "DA PARCELA EM DIANTE" (tela de fatura): cancela as
   * parcelas PENDING com sequência >= fromSequence. Pagas ficam intocadas.
   * v21 (bug 4): opção onlyOne — cancela APENAS a parcela indicada (usada
   *  pelo diálogo de confirmação "Excluir apenas esta").
   */
  async cancelFromSequence(planId: string, fromSequence: number, opts?: { onlyOne?: boolean }): Promise<{
    canceledCount: number;
    firstSequence: number;
    paidCount: number;
    remainingCount: number;
    newTotalCents: number;
  }> {
    const all = await this.installments.getByPlan(planId);
    const firstPending = all.find((i) => i.status === 'PENDING');
    if (!firstPending) throw new Error('Não há parcelas em aberto para excluir');
    const from = Math.max(fromSequence, firstPending.sequence_number);
    const targets = opts?.onlyOne
      ? all.filter((i) => i.status === 'PENDING' && i.sequence_number === from)
      : all.filter((i) => i.status === 'PENDING' && i.sequence_number >= from);
    if (targets.length === 0) throw new Error('Não há parcelas em aberto a partir dessa parcela');
    const targetIds = targets.map((i) => i.id);

    const paidSum = all.filter((i) => i.status === 'PAID').reduce((a, b) => a + b.amount_cents, 0);
    const remainingAfter = all.filter((i) => i.status === 'PENDING' && !targetIds.includes(i.id));
    const newTotal = paidSum + remainingAfter.reduce((a, b) => a + b.amount_cents, 0);

    await this.db.transactionAsync(async () => {
      for (const inst of targets) {
        await this.installments.setStatus(inst.id, 'CANCELED');
        await this.moves.deleteByInstallment(inst.id); // v10: exclusão física
      }
      const plan = await this.plans.getById(planId);
      if (plan?.card_id && targetIds.length) {
        const affected = await this.db.getAllAsync<{ invoice_id: string }>(
          `SELECT DISTINCT invoice_id FROM invoice_items WHERE installment_id IN (${targetIds.map(() => '?').join(',')})`,
          targetIds as never
        );
        await this.invoiceItems.deleteByInstallments(targetIds);
        for (const inv of affected) {
          await this.invoiceService.rebuildTotals(inv.invoice_id);
        }
      }
      // v18 (bug 4): plano sem nenhuma parcela restante sai de vez (com o
      // cabeçalho da compra) — sem total 0 no banco (mesma correção do acima)
      if (newTotal <= 0) {
        for (const inst of await this.installments.getByPlan(planId)) {
          if (inst.status !== 'PAID') await this.installments.delete(inst.id);
        }
        await this.plans.deletePlan(planId);
        if (plan?.original_transaction_id) {
          await this.transactions.delete(plan.original_transaction_id);
        }
      } else {
        await this.plans.updateAmounts(
          planId,
          plan?.mode === 'DIVIDE_TOTAL' ? newTotal : null,
          plan?.mode === 'FIXED_PER_MONTH' ? (plan.fixed_amount_cents ?? null) : null
        );
        if (plan?.original_transaction_id) {
          await this.transactions.updateAmount(plan.original_transaction_id, newTotal);
        }
      }
    });

    return {
      canceledCount: targets.length,
      firstSequence: from,
      paidCount: all.filter((i) => i.status === 'PAID').length,
      remainingCount: remainingAfter.length,
      newTotalCents: newTotal,
    };
  }

  /**
   * v21 (bug 1): dados do plano para a tela de edição específica — âncora
   *  (descrição, categoria, data da compra) + parcelas + destino.
   */
  async getPlanEditData(planId: string) {
    const plan = await this.plans.getById(planId);
    if (!plan) return null;
    const anchor = plan.original_transaction_id
      ? await this.transactions.getById(plan.original_transaction_id)
      : null;
    const all = await this.installments.getByPlan(planId);
    const live = all.filter((i) => i.status !== 'CANCELED');
    return {
      plan,
      anchor: anchor
        ? { id: anchor.id, description: anchor.description, categoryId: anchor.category_id, occurredOn: anchor.occurred_on, type: anchor.type }
        : null,
      installments: live.map((i) => ({
        id: i.id,
        sequence: i.sequence_number,
        dueDate: i.due_date,
        amountCents: i.amount_cents,
        status: i.status,
      })),
      firstPending: live.find((i) => i.status === 'PENDING') ?? null,
      pendingCount: live.filter((i) => i.status === 'PENDING').length,
      paidCount: live.filter((i) => i.status === 'PAID').length,
    };
  }

  /**
   * v9 — PROPAGAÇÃO DO PARCELADO NO FLUXO (planos em CONTA): as parcelas
   * com vencimento no mês aparecem no Fluxo com status Pago/Não pago
   * (toggle dinâmico — v10). Planos no CARTÃO aparecem aglutinados na fatura.
   * v14 (bug 2): traz o TIPO do plano (EXPENSE/INCOME — receita parcelada
   * recebe +/verde no Fluxo) e o nome da CONTA (layout unificado do card).
   */
  async listAccountInstallmentsDueInMonth(month: string): Promise<Array<{
    installmentId: string;
    planId: string;
    description: string;
    sequenceNumber: number;
    totalInstallments: number;
    amountCents: number;
    dueDate: string;
    status: 'PENDING' | 'PAID' | 'CANCELED';
    type: 'EXPENSE' | 'INCOME';
    accountName: string | null;
  }>> {
    return this.db.getAllAsync(
      `SELECT ins.id AS installmentId,
              ins.plan_id AS planId,
              COALESCE(t.description, 'Parcelamento') AS description,
              ins.sequence_number AS sequenceNumber,
              p.total_installments AS totalInstallments,
              ins.amount_cents AS amountCents,
              ins.due_date AS dueDate,
              ins.status AS status,
              COALESCE(t.type, 'EXPENSE') AS type,
              a.name AS accountName
         FROM installments ins
         JOIN installment_plans p ON p.id = ins.plan_id
         LEFT JOIN transactions t ON t.id = p.original_transaction_id
         LEFT JOIN accounts a ON a.id = p.account_id
        WHERE p.account_id IS NOT NULL AND p.card_id IS NULL
          AND ins.status != 'CANCELED' AND ins.due_date LIKE ?
        ORDER BY ins.due_date`,
      [`${month}-%`]
    );
  }
}
