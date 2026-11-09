/**
 * CardInvoiceService — faturas por cartão.
 *
 * REGRA DE CORTE EXATA (spec v7):
 *   "Compra até 23:59:59 do dia de corte (America/Sao_Paulo) entra na fatura ATUAL.
 *    Dia seguinte entra na PRÓXIMA."
 *
 * Pagamento parcial: status PARTIALLY_PAID enquanto devido > 0.
 * Crédito excedente: pagamento maior que o devido gera credit_from_prev_cents na fatura seguinte.
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import {
  monthAdd, monthOf, effectiveClosingDay, dayInMonth, addDays,
  monthLabel, firstDayOf, lastDayNumberOf, spDateOfIso, todaySP,
} from '../lib/dates';
import { InvoiceRepo, InvoiceItemRepo, InvoicePaymentRepo } from '../repos/invoices';
import { FinancialMoveRepo, InstallmentRepo } from '../repos/finance';
import type { InvoiceRow } from '../repos/invoices';
import type { CardRow } from '../repos/accounts';
import { CardRepo } from '../repos/accounts';

export type InvoiceStatusView = 'OPEN' | 'CLOSED' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE';

export class CardInvoiceService {
  private invoices: InvoiceRepo;
  private items: InvoiceItemRepo;
  private payments: InvoicePaymentRepo;
  private moves: FinancialMoveRepo;
  private installments: InstallmentRepo;
  private cards: CardRepo;

  constructor(private db: DbDriver) {
    this.invoices = new InvoiceRepo(db);
    this.items = new InvoiceItemRepo(db);
    this.payments = new InvoicePaymentRepo(db);
    this.moves = new FinancialMoveRepo(db);
    this.installments = new InstallmentRepo(db);
    this.cards = new CardRepo(db);
  }

  /**
   * Mês de referência da fatura para uma data-efetiva qualquer (compra ou parcela):
   * dia <= fechamento efetivo do mês -> fatura do próprio mês; senão -> mês seguinte.
   */
  referenceMonthForDate(card: Pick<CardRow, 'closing_day'>, dateYmd: string): string {
    const ym = monthOf(dateYmd);
    const day = parseInt(dateYmd.slice(8, 10), 10);
    const closing = effectiveClosingDay(ym, card.closing_day);
    return day <= closing ? ym : monthAdd(ym, 1);
  }

  /** Datas de período de uma fatura de referência. */
  periodOf(card: Pick<CardRow, 'closing_day'>, referenceMonth: string): { periodStart: string; periodEnd: string } {
    const periodEnd = dayInMonth(referenceMonth, card.closing_day);
    const prevMonth = monthAdd(referenceMonth, -1);
    const prevClose = dayInMonth(prevMonth, card.closing_day);
    return { periodStart: addDays(prevClose, 1), periodEnd };
  }

  /** Vencimento: dia de vencimento no mês do fechamento; se cair <= fim do período, vira pro mês seguinte. */
  dueDateOf(card: Pick<CardRow, 'due_day' | 'closing_day'>, referenceMonth: string): string {
    const { periodEnd } = this.periodOf(card, referenceMonth);
    const candidate = dayInMonth(referenceMonth, card.due_day);
    return candidate <= periodEnd ? dayInMonth(monthAdd(referenceMonth, 1), card.due_day) : candidate;
  }

  /** Garante a existência da fatura (idempotente) e fecha a anterior se ainda OPEN. */
  async ensureInvoice(cardId: string, referenceMonth: string): Promise<InvoiceRow> {
    const existing = await this.invoices.getByCardAndMonth(cardId, referenceMonth);
    if (existing) return existing;
    const card = await this.cards.getById(cardId);
    if (!card) throw new Error('Cartão não encontrado');
    const { periodStart, periodEnd } = this.periodOf(card, referenceMonth);
    const invoice: InvoiceRow = {
      id: genId(),
      card_id: cardId,
      reference_month: referenceMonth,
      period_start: periodStart,
      period_end: periodEnd,
      due_date: this.dueDateOf(card, referenceMonth),
      total_cents: 0,
      paid_cents: 0,
      credit_from_prev_cents: 0,
      status: 'OPEN',
    };
    await this.invoices.insert(invoice);
    // Fecha fatura anterior que ainda esteja OPEN — v12: APENAS se ela NÃO tem
    // saldo devido. Fatura com saldo em aberto nunca é fechada automaticamente
    // (bug: a fatura seguinte fechava/quitava a anterior com saldo maior).
    const prev = await this.invoices.getByCardAndMonth(cardId, monthAdd(referenceMonth, -1));
    if (prev && (prev.status === 'OPEN' || prev.status === 'OVERDUE')) {
      const prevDue = Math.max(0, prev.total_cents - prev.credit_from_prev_cents - prev.paid_cents);
      if (prevDue <= 0) {
        await this.invoices.updateTotals(prev.id, { status: 'CLOSED' });
      }
    }
    return invoice;
  }

  /**
   * v9 — sugere o mês da fatura para uma data de compra (usado na tela Novo
   * Lançamento ao selecionar "Cartão"): dia <= fechamento -> fatura do próprio
   * mês; senão -> fatura do mês seguinte.
   */
  suggestReferenceMonth(card: Pick<CardRow, 'closing_day'>, dateYmd: string): string {
    return this.referenceMonthForDate(card, dateYmd);
  }

  /**
   * v9 — BLOQUEIO DE FATURA FECHADA: não permite novo lançamento quando a
   * fatura do mês escolhido já foi PAGA e a data da compra é posterior ao dia
   * de fechamento daquele mês (o período já encerrou).
   */
  private async assertInvoiceOpenForEntry(
    card: CardRow,
    referenceMonth: string,
    dateYmd: string
  ): Promise<void> {
    const invoice = await this.invoices.getByCardAndMonth(card.id, referenceMonth);
    if (!invoice) return;
    const paidFully = invoice.status === 'PAID' || this.computeLiveStatus(invoice) === 'PAID';
    if (!paidFully) return;
    const closing = effectiveClosingDay(referenceMonth, card.closing_day);
    // "Data do lançamento maior que a data do Dia de Fechamento" — comparação de DATA real
    if (dateYmd > dayInMonth(referenceMonth, closing)) {
      throw new Error(
        `Fatura ${monthLabel(referenceMonth)} do cartão ${card.name} já está fechada (paga e após o dia de fechamento ${closing}). Escolha outra fatura.`
      );
    }
  }

  /** Garante fatura para uma compra no cartão e insere o item.
   *  v9: aceita o mês de referência escolhido pelo usuário (sugestão + até 6
   *  meses à frente) e aplica o bloqueio de fatura fechada. */
  async registerPurchase(
    cardId: string,
    transactionId: string,
    amountCents: number,
    occurredAtIso: string,
    referenceMonth?: string
  ): Promise<InvoiceRow> {
    const card = await this.cards.getById(cardId);
    if (!card) throw new Error('Cartão não encontrado');
    const spDate = spDateOfIso(occurredAtIso);
    const suggested = this.referenceMonthForDate(card, spDate);
    let reference = suggested;
    if (referenceMonth) {
      // v9: manual = da fatura anterior (corrige retroativo) até 6 meses À FRENTE
      const minMonth = monthAdd(suggested, -1);
      const maxMonth = monthAdd(suggested, 6);
      if (referenceMonth < minMonth || referenceMonth > maxMonth) {
        throw new Error(`Mês da fatura inválido — permitido de ${monthLabel(minMonth)} até 6 meses à frente (${monthLabel(maxMonth)}).`);
      }
      reference = referenceMonth;
    }
    await this.assertInvoiceOpenForEntry(card, reference, spDate);
    return this.db.transactionAsync(async () => {
      const invoice = await this.ensureInvoice(cardId, reference);
      // v12: IDEMPOTENTE por transação — a previsão da conta fixa no cartão já
      // registra o item na fatura do mês futuro; a promoção (mês chegando) NÃO
      // pode duplicar o item.
      const existing = await this.items.getByTransaction(transactionId);
      if (existing) {
        if (existing.invoice_id !== invoice.id) {
          await this.items.deleteById(existing.id);
          await this.rebuildTotals(existing.invoice_id);
          await this.items.insert({
            id: genId(),
            invoice_id: invoice.id,
            transaction_id: transactionId,
            installment_id: null,
            amount_cents: amountCents,
          });
          await this.rebuildTotals(invoice.id);
        } else {
          if (existing.amount_cents !== amountCents) {
            await this.items.updateAmountByTransaction(transactionId, amountCents);
          }
          await this.rebuildTotals(invoice.id);
        }
        return invoice;
      }
      await this.items.insert({
        id: genId(),
        invoice_id: invoice.id,
        transaction_id: transactionId,
        installment_id: null,
        amount_cents: amountCents,
      });
      await this.rebuildTotals(invoice.id);
      return invoice;
    });
  }

  /** Garante fatura para uma parcela (por vencimento) e insere o item. */
  async registerInstallment(
    cardId: string,
    installmentId: string,
    amountCents: number,
    dueDate: string,
    /** v26: "mês da fatura" escolhido pelo usuário (sobrepõe a regra de corte). */
    referenceMonthOverride?: string
  ): Promise<InvoiceRow> {
    const card = await this.cards.getById(cardId);
    if (!card) throw new Error('Cartão não encontrado');
    const referenceMonth = referenceMonthOverride ?? this.referenceMonthForDate(card, dueDate);
    return this.db.transactionAsync(async () => {
      const invoice = await this.ensureInvoice(cardId, referenceMonth);
      await this.installments.setInvoiceId(installmentId, invoice.id);
      await this.items.insert({
        id: genId(),
        invoice_id: invoice.id,
        transaction_id: null,
        installment_id: installmentId,
        amount_cents: amountCents,
      });
      await this.rebuildTotals(invoice.id);
      return invoice;
    });
  }

  /**
   * Reavalia o item de fatura de uma parcela editada e recalcula os totais (v7.0.5).
   * Faturas de meses JÁ PAGOS nunca passam por aqui (só parcelas PENDING são editadas).
   */
  async updateInstallmentAmount(installmentId: string, amountCents: number): Promise<void> {
    const item = await this.items.getByInstallment(installmentId);
    if (!item) return;
    await this.items.updateAmountByInstallment(installmentId, amountCents);
    await this.rebuildTotals(item.invoice_id);
  }

  /** total = SOMA dos itens (agregado derivado); status derivado do devido. */
  async rebuildTotals(invoiceId: string): Promise<void> {
    const invoice = await this.invoices.getById(invoiceId);
    if (!invoice) return;
    const total = await this.items.sumByInvoice(invoiceId);
    const due = total - invoice.credit_from_prev_cents - invoice.paid_cents;
    let status: InvoiceRow['status'] = invoice.status;
    if (due <= 0) status = 'PAID';
    else if (invoice.paid_cents > 0) status = 'PARTIALLY_PAID';
    else if (invoice.status === 'PAID' || invoice.status === 'PARTIALLY_PAID') status = 'OPEN';
    await this.invoices.updateTotals(invoiceId, { total_cents: total, status });
  }

  /** Devido atual = total - crédito anterior - pago. */
  async getDueCents(invoiceId: string): Promise<number> {
    const inv = await this.invoices.getById(invoiceId);
    if (!inv) return 0;
    return Math.max(0, inv.total_cents - inv.credit_from_prev_cents - inv.paid_cents);
  }

  /** Status "ao vivo" (OVERDUE é derivado, nunca armazenado). */
  computeLiveStatus(invoice: InvoiceRow): InvoiceStatusView {
    const due = invoice.total_cents - invoice.credit_from_prev_cents - invoice.paid_cents;
    if (due <= 0) return 'PAID';
    if (invoice.paid_cents > 0) return 'PARTIALLY_PAID';
    if (invoice.status === 'CLOSED') return 'CLOSED';
    if (invoice.due_date && invoice.due_date < todaySP()) return 'OVERDUE';
    return 'OPEN';
  }

  /**
   * Pagamento (parcial ou total) a partir de uma conta.
   * v12 — REGRA: o valor pago ABATE DIRETAMENTE o total DESTA fatura
   * (proporcional ao devido) e NUNCA toca a fatura seguinte — não existe mais
   * crédito excedente que quitasse/fechasse indevidamente a próxima fatura.
   * v16 (bug 4) — PAGAMENTO ADICIONAL: valor MAIOR que o saldo devido (ou
   * pagamento em fatura já quitada) deixou de ser recusado. Vale a regra
   * padrão de cartão pela DATA DE CORTE (fechamento):
   *  · a parte que cabe no devido desta fatura abate esta fatura;
   *  · o EXCEDENTE vai para a FATURA EM ABERTO na data do pagamento
   *    (referenceMonthForDate pela data de corte), onde já abate o que existe
   *    e passa a abater também lançamentos futuros do ciclo (pré-pagamento).
   * Cada parte vira um registro de pagamento próprio (com o seu débito na
   * conta), então o estorno (deletePayment) continua funcionando por parte.
   */
  async payInvoice(input: {
    invoiceId: string;
    fromAccountId: string;
    amountCents: number;
    paidOn?: string;
    method?: string;
  }): Promise<{ paymentId: string; appliedCents: number; surplusCents: number; routedInvoiceId: string | null; routedMonth: string | null }> {
    if (input.amountCents <= 0) throw new Error('Valor de pagamento deve ser maior que zero');
    const invoice = await this.invoices.getById(input.invoiceId);
    if (!invoice) throw new Error('Fatura não encontrada');
    const paidOn = input.paidOn ?? todaySP();

    return this.db.transactionAsync(async () => {
      // v12: relê a fatura DENTRO da transação e recalcula o total dos itens
      // (fonte da verdade) — evita quitação por leitura obsoleta
      const fresh = await this.invoices.getById(invoice.id);
      if (!fresh) throw new Error('Fatura não encontrada');
      const total = await this.items.sumByInvoice(fresh.id);
      const dueBefore = Math.max(0, total - fresh.credit_from_prev_cents - fresh.paid_cents);
      const card = await this.cards.getById(fresh.card_id);
      if (!card) throw new Error('Cartão não encontrado');

      // v16: fatura EM ABERTO pela data de corte (regra padrão do cartão)
      const openMonth = this.referenceMonthForDate(card, paidOn);

      // v52-22 (v63.1): IDEMPOTÊNCIA — fatura já QUITADA não aceita novo pagamento
      // na mesma fatura (não debita 2x). Pagar a fatura EM ABERTO com excedente
      // (pré-pagar o ciclo) continua valendo enquanto houver devido.
      if (dueBefore <= 0 && openMonth === fresh.reference_month && fresh.status === 'PAID') {
        throw new Error('Fatura já está paga — nada a pagar');
      }

      // Fatura vista É a fatura em aberto: tudo fica aqui — mesmo com valor
      // maior que o devido (o excedente pré-paga o ciclo e abate o que vier).
      if (openMonth === fresh.reference_month) {
        const paymentId = genId();
        await this.payments.insert({
          id: paymentId,
          invoice_id: fresh.id,
          from_account_id: input.fromAccountId,
          amount_cents: input.amountCents,
          paid_on: paidOn,
          method: input.method ?? null,
          status: 'CONFIRMED',
        });
        await this.moves.insert({
          id: genId(),
          transaction_id: null,
          installment_id: null,
          invoice_payment_id: paymentId,
          account_id: input.fromAccountId,
          direction: 'DEBIT',
          amount_cents: input.amountCents,
          effective_date: paidOn,
          status: 'CONFIRMED',
        });
        const newPaid = fresh.paid_cents + input.amountCents;
        const dueAfter = total - fresh.credit_from_prev_cents - newPaid;
        const status: InvoiceRow['status'] = dueAfter <= 0 ? 'PAID' : 'PARTIALLY_PAID';
        await this.invoices.updateTotals(fresh.id, { total_cents: total, paid_cents: newPaid, status });
        if (dueAfter <= 0) {
          await this.installments.markPaidByInvoice(fresh.id);
        }
        return { paymentId, appliedCents: input.amountCents, surplusCents: 0, routedInvoiceId: null, routedMonth: null };
      }

      // v16 (bug 4): fatura vista ≠ fatura em aberto pela data de corte —
      // reparte: o que cabe no devido aqui; o EXCEDENTE vai para a fatura
      // EM ABERTO (abate o devido dela e o que vier no ciclo).
      const applied = Math.min(input.amountCents, dueBefore);
      const surplus = input.amountCents - applied;

      let paymentId: string | null = null;
      if (applied > 0) {
        paymentId = genId();
        await this.payments.insert({
          id: paymentId,
          invoice_id: fresh.id,
          from_account_id: input.fromAccountId,
          amount_cents: applied,
          paid_on: paidOn,
          method: input.method ?? null,
          status: 'CONFIRMED',
        });
        await this.moves.insert({
          id: genId(),
          transaction_id: null,
          installment_id: null,
          invoice_payment_id: paymentId,
          account_id: input.fromAccountId,
          direction: 'DEBIT',
          amount_cents: applied,
          effective_date: paidOn,
          status: 'CONFIRMED',
        });
        const newPaid = fresh.paid_cents + applied;
        const dueAfter = total - fresh.credit_from_prev_cents - newPaid;
        const status: InvoiceRow['status'] = dueAfter <= 0 ? 'PAID' : 'PARTIALLY_PAID';
        await this.invoices.updateTotals(fresh.id, { total_cents: total, paid_cents: newPaid, status });
        if (dueAfter <= 0) {
          await this.installments.markPaidByInvoice(fresh.id);
        }
      }

      let routedInvoiceId: string | null = null;
      if (surplus > 0) {
        const target = await this.ensureInvoice(fresh.card_id, openMonth);
        const targetFresh = await this.invoices.getById(target.id);
        if (!targetFresh) throw new Error('Fatura em aberto não encontrada');
        const targetTotal = await this.items.sumByInvoice(target.id);
        const routedPaymentId = genId();
        await this.payments.insert({
          id: routedPaymentId,
          invoice_id: target.id,
          from_account_id: input.fromAccountId,
          amount_cents: surplus,
          paid_on: paidOn,
          method: input.method ?? null,
          status: 'CONFIRMED',
        });
        await this.moves.insert({
          id: genId(),
          transaction_id: null,
          installment_id: null,
          invoice_payment_id: routedPaymentId,
          account_id: input.fromAccountId,
          direction: 'DEBIT',
          amount_cents: surplus,
          effective_date: paidOn,
          status: 'CONFIRMED',
        });
        const targetPaid = targetFresh.paid_cents + surplus;
        const targetDue = targetTotal - targetFresh.credit_from_prev_cents - targetPaid;
        await this.invoices.updateTotals(target.id, {
          total_cents: targetTotal,
          paid_cents: targetPaid,
          status: targetDue <= 0 ? 'PAID' : 'PARTIALLY_PAID',
        });
        if (targetDue <= 0) {
          await this.installments.markPaidByInvoice(target.id);
        }
        routedInvoiceId = target.id;
      }

      if (!paymentId && routedInvoiceId) {
        // Tudo foi para a fatura em aberto (a vista já estava quitada):
        // o "pagamento" principal é o registro roteado.
        const routedPayments = await this.payments.getByInvoice(routedInvoiceId);
        const last = routedPayments[routedPayments.length - 1];
        paymentId = last?.id ?? genId();
      }
      return { paymentId: paymentId ?? genId(), appliedCents: applied, surplusCents: surplus, routedInvoiceId, routedMonth: surplus > 0 ? openMonth : null };
    });
  }

  /**
   * v10 — EXCLUSÃO/ESTORNO de um pagamento registrado (long-press de 3 s na
   * tela da fatura). O pagamento sai DEFINITIVAMENTE do banco (exclusão
   * física) e todo o movimento vinculado é estornado:
   *  - O débito na conta de pagamento é APAGADO (saldo da conta volta);
   *  - O total pago da fatura é recalculado — o status volta a
   *    OPEN/PARTIALLY_PAID quando a fatura deixa de estar quitada;
   *  - Parcelas marcadas PAID pela quitação voltam a PENDING;
   *  - Crédito excedente que ESTE pagamento tenha gerado na fatura seguinte
   *    é revertido.
   */
  async deletePayment(paymentId: string): Promise<void> {
    await this.db.transactionAsync(async () => {
      const payment = await this.payments.getById(paymentId);
      if (!payment) throw new Error('Pagamento não encontrado');
      const invoice = await this.invoices.getById(payment.invoice_id);
      if (!invoice) throw new Error('Fatura não encontrada');

      // 1. Estorna o movimento da conta (exclusão física)
      await this.moves.deleteByInvoicePayment(paymentId);

      // 2. Reverte crédito excedente gerado por ESTE pagamento na fatura seguinte
      //    (v12 não gera mais excedente — bloco mantido para dados antigos)
      const paidBefore = invoice.paid_cents - payment.amount_cents;
      const dueBefore = invoice.total_cents - invoice.credit_from_prev_cents - paidBefore;
      const surplus = payment.amount_cents - dueBefore;
      if (surplus > 0) {
        const next = await this.invoices.getByCardAndMonth(invoice.card_id, monthAdd(invoice.reference_month, 1));
        if (next) {
          await this.invoices.updateTotals(next.id, {
            credit_from_prev_cents: Math.max(0, next.credit_from_prev_cents - surplus),
          });
          await this.rebuildTotals(next.id);
        }
      }

      // 3. Apaga o pagamento e recalcula pago/status da fatura com LEITURA FRESCA
      //    (v12: totais relidos — o estorno reverte saldos e status de verdade)
      await this.payments.deleteById(paymentId);
      const remaining = await this.payments.sumConfirmedByInvoice(invoice.id);
      const fresh = await this.invoices.getById(invoice.id);
      const total = fresh ? await this.items.sumByInvoice(invoice.id) : invoice.total_cents;
      const credit = fresh?.credit_from_prev_cents ?? invoice.credit_from_prev_cents;
      await this.invoices.updateTotals(invoice.id, { paid_cents: remaining, total_cents: total });
      const dueAfter = Math.max(0, total - credit - remaining);
      if (dueAfter > 0) {
        // Deixou de estar quitada: parcelas marcadas PAID pela quitação voltam a PENDING
        await this.installments.unmarkPaidByInvoice(invoice.id);
      }
      await this.rebuildTotals(invoice.id);
    });
  }

  /** Detalhe completo da fatura (tela de fatura). */
  async getInvoiceDetail(invoiceId: string) {
    const invoice = await this.invoices.getById(invoiceId);
    if (!invoice) return null;
    const [items, payments, card] = await Promise.all([
      this.items.getByInvoice(invoiceId),
      this.payments.getByInvoice(invoiceId),
      this.cards.getById(invoice.card_id),
    ]);
    const due = Math.max(0, invoice.total_cents - invoice.credit_from_prev_cents - invoice.paid_cents);
    return {
      invoice,
      liveStatus: this.computeLiveStatus(invoice),
      card,
      items,
      payments,
      dueCents: due,
      referenceLabel: monthLabel(invoice.reference_month),
    };
  }

  /** Detalhe por (cartão, mês de referência) — helper para a tela de fatura. */
  async getInvoiceDetailByCardMonth(cardId: string, referenceMonth: string) {
    const invoice = await this.invoices.getByCardAndMonth(cardId, referenceMonth);
    if (!invoice) return null;
    return this.getInvoiceDetail(invoice.id);
  }

  /** Lista faturas de um cartão com status ao vivo. */
  async listInvoicesByCard(cardId: string) {
    const rows = await this.invoices.listByCard(cardId);
    return rows.map((inv) => ({
      invoice: inv,
      liveStatus: this.computeLiveStatus(inv),
      dueCents: Math.max(0, inv.total_cents - inv.credit_from_prev_cents - inv.paid_cents),
    }));
  }

  /**
   * v67 (BUG 6) — A PRÓXIMA FATURA EM ABERTO do cartão (o saldo do topo):
   * entre as faturas NÃO quitadas (OPEN / PARTIALLY_PAID / OVERDUE), é a de
   * MÊS DE REFERÊNCIA MAIS ANTIGO — a próxima a vencer, não a mais nova.
   * Sem fatura em aberto (todas quitadas / nenhuma) → null, e a tela mostra
   * R$ 0,00 · "Sem fatura em aberto". Cada cartão tem a sua.
   */
  async getNextOpenInvoice(cardId: string): Promise<{
    invoice: InvoiceRow;
    liveStatus: InvoiceStatusView;
    dueCents: number;
  } | null> {
    const rows = await this.invoices.listByCard(cardId);
    const open = rows
      .map((inv) => ({
        invoice: inv,
        liveStatus: this.computeLiveStatus(inv),
        dueCents: Math.max(0, inv.total_cents - inv.credit_from_prev_cents - inv.paid_cents),
      }))
      .filter((r) => r.liveStatus === 'OPEN' || r.liveStatus === 'PARTIALLY_PAID' || r.liveStatus === 'OVERDUE')
      .sort((a, b) => (a.invoice.reference_month < b.invoice.reference_month ? -1 : 1));
    return open[0] ?? null;
  }

  /** Próxima fatura em aberto de vários cartões, em uma única consulta. */
  async getNextOpenInvoices(cardIds: string[]): Promise<Map<string, {
    invoice: InvoiceRow;
    liveStatus: InvoiceStatusView;
    dueCents: number;
  }>> {
    const result = new Map<string, {
      invoice: InvoiceRow;
      liveStatus: InvoiceStatusView;
      dueCents: number;
    }>();
    if (cardIds.length === 0) return result;

    const rows = await this.db.getAllAsync<InvoiceRow>(
      `SELECT id, card_id, reference_month, period_start, period_end, due_date,
              total_cents, paid_cents, credit_from_prev_cents, status
         FROM invoices
        WHERE card_id IN (${cardIds.map(() => '?').join(',')})
        ORDER BY card_id, reference_month`,
      cardIds
    );
    for (const invoice of rows) {
      if (result.has(invoice.card_id)) continue;
      const liveStatus = this.computeLiveStatus(invoice);
      if (liveStatus !== 'OPEN' && liveStatus !== 'PARTIALLY_PAID' && liveStatus !== 'OVERDUE') continue;
      result.set(invoice.card_id, {
        invoice,
        liveStatus,
        dueCents: Math.max(0, invoice.total_cents - invoice.credit_from_prev_cents - invoice.paid_cents),
      });
    }
    return result;
  }

  /** Faturas em aberto (alertas da tela Início — separadas do saldo). */
  async listOpenInvoices() {
    const rows = await this.invoices.listOpen();
    return rows.map((inv) => ({
      invoice: inv,
      liveStatus: this.computeLiveStatus(inv),
      dueCents: Math.max(0, inv.total_cents - inv.credit_from_prev_cents - inv.paid_cents),
    }));
  }

  /**
   * v9 — FATURAS COM VENCIMENTO NO MÊS (aglutinação no Fluxo):
   * cada fatura aparece UMA VEZ na data de vencimento, com o valor devido
   * (total − antecipados: pagamentos e créditos já lançados) e a lista de
   * lançamentos individuais para o expansor (seta).
   */
  async listInvoicesDueInMonth(month: string): Promise<Array<{
    invoice: InvoiceRow;
    cardId: string;
    cardName: string;
    dueDate: string;
    dueCents: number;
    liveStatus: InvoiceStatusView;
    items: Array<{
      description: string;
      date: string | null;
      amountCents: number;
      sequenceNumber: number | null;
      totalInstallments: number | null;
      /** v16 (bug 3): origem do item — RECURRENCE ganha a bolinha de CONTA FIXA
       *  no expansor da fatura no Fluxo (mesma iconografia da tela da fatura). */
      sourceSystem: string | null;
    }>;
  }>> {
    const rows = await this.db.getAllAsync<InvoiceRow & { card_name: string }>(
      `SELECT inv.*, c.name AS card_name
         FROM invoices inv
         JOIN cards c ON c.id = inv.card_id
        WHERE c.archived_at IS NULL AND inv.due_date LIKE ?
        ORDER BY inv.due_date`,
      [`${month}-%`]
    );
    const out = [];
    for (const inv of rows) {
      const rawItems = await this.items.getByInvoice(inv.id);
      out.push({
        invoice: inv,
        cardId: inv.card_id,
        cardName: inv.card_name,
        dueDate: inv.due_date ?? dayInMonth(inv.reference_month, 1),
        dueCents: Math.max(0, inv.total_cents - inv.credit_from_prev_cents - inv.paid_cents),
        liveStatus: this.computeLiveStatus(inv),
        items: rawItems.map((it) => ({
          description: it.description ?? (it.sequence_number != null ? 'Parcela' : 'Lançamento no cartão'),
          date: it.occurred_on,
          amountCents: it.amount_cents,
          sequenceNumber: it.sequence_number,
          totalInstallments: it.total_installments,
          sourceSystem: it.source_system ?? null,
        })),
      });
    }
    return out;
  }

  /**
   * v9 — CARTÕES COM A FATURA DO MÊS VIGENTE (seção "Cartões" da tela Início):
   * lista os cartões ativos com o valor a pagar da fatura cujo mês de
   * referência é o mês atual (ou aviso de fatura inexistente).
   */
  async listCardsWithCurrentInvoice(): Promise<Array<{
    cardId: string;
    cardName: string;
    lastFour: string | null;
    closingDay: number;
    dueDay: number;
    hasInvoice: boolean;
    dueCents: number;
    totalCents: number;
    paidCents: number;
    dueDate: string | null;
    liveStatus: InvoiceStatusView | null;
    referenceMonth: string;
  }>> {
    const cards = await this.db.getAllAsync<CardRow>(
      'SELECT * FROM cards WHERE archived_at IS NULL ORDER BY name'
    );
    const referenceMonth = monthOf(todaySP());
    const out = [];
    for (const card of cards) {
      const inv = await this.invoices.getByCardAndMonth(card.id, referenceMonth);
      out.push({
        cardId: card.id,
        cardName: card.name,
        lastFour: card.last_four_digits,
        closingDay: card.closing_day,
        dueDay: card.due_day,
        hasInvoice: !!inv,
        dueCents: inv ? Math.max(0, inv.total_cents - inv.credit_from_prev_cents - inv.paid_cents) : 0,
        totalCents: inv?.total_cents ?? 0,
        paidCents: inv?.paid_cents ?? 0,
        dueDate: inv?.due_date ?? null,
        liveStatus: inv ? this.computeLiveStatus(inv) : null,
        referenceMonth,
      });
    }
    return out;
  }

  /** Períodos dos últimos N meses (para criar fatura em branco na UI). */
  recentReferenceMonths(card: Pick<CardRow, 'closing_day'>, n = 12): string[] {
    const out: string[] = [];
    let ym = monthOf(firstDayOf(monthOf(new Date().toISOString().slice(0, 10))));
    // Mês atual como referência (cortes futuros criam na hora)
    for (let i = 0; i < n; i++) {
      out.push(ym);
      ym = monthAdd(ym, -1);
    }
    void lastDayNumberOf; // util mantida para clareza de cálculo
    return out;
  }
}
