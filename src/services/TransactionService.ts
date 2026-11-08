/**
 * TransactionService — criação/void de eventos financeiros (ARQ-002, ARQ-004, ARQ-005).
 *
 * Regra de ouro (ARQ-002): transação = evento; financial_move = efeito na conta.
 *  - Despesa/receita em CONTA: cria 1 financial_move imediatamente.
 *  - Despesa no CARTÃO: não cria move — o efeito na conta ocorre no pagamento da fatura.
 *  - TRANSFER: 1 transação + 2 moves (DEBIT na origem, CREDIT no destino), atômico.
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { todaySP, nowIso, noonUtcIsoOf, spDateOfIso, monthAdd } from '../lib/dates';
import { TransactionRepo } from '../repos/finance';
import { FinancialMoveRepo } from '../repos/finance';
import { InvoiceRepo, InvoiceItemRepo } from '../repos/invoices';
import { InstallmentRepo, InstallmentPlanRepo } from '../repos/finance';
import type { TransactionRow, FinancialMoveRow } from '../repos/finance';

export interface CreateAccountExpenseInput {
  description: string;
  amountCents: number;
  date?: string; // YYYY-MM-DD (default hoje SP)
  categoryId?: string | null;
  accountId: string;
  source?: TransactionRow['source_system'];
  externalRefId?: string | null;
}

export interface CreateAccountIncomeInput {
  description: string;
  amountCents: number;
  date?: string;
  categoryId?: string | null;
  accountId: string;
  source?: TransactionRow['source_system'];
  externalRefId?: string | null;
}

export interface CreateCardExpenseInput {
  description: string;
  amountCents: number;
  date?: string;
  occurredAt?: string;
  categoryId?: string | null;
  cardId: string;
  source?: TransactionRow['source_system'];
  externalRefId?: string | null;
  /** v9: mês de referência da fatura (escolhido na tela — sugestão + até 6 meses à frente).
   *  Se ausente, a fatura é deduzida pelo dia de fechamento. */
  referenceMonth?: string;
}

export interface CreateTransferInput {
  description: string;
  amountCents: number;
  date?: string;
  fromAccountId: string;
  toAccountId: string;
}

/** v7.1: linha de um lançamento consolidado manual (débito ou crédito). */
export interface ConsolidatedLineInput {
  direction: 'DEBIT' | 'CREDIT';
  description: string;
  amountCents: number;
  /** v8: categoria da linha — filtra as categorias pela direção (Débito/Crédito). */
  categoryId?: string | null;
  /** v63.1: alias de compatibilidade — 'INCOME' → CREDIT, 'EXPENSE' → DEBIT.
   *  Se `direction` vier preenchido, ele prevalece. */
  type?: 'EXPENSE' | 'INCOME';
}

export interface CreateConsolidatedGroupInput {
  description: string;
  date?: string;
  categoryId?: string | null;
  /** v13: opcional — só é exigida quando há linhas à vista (grupo só com
   *  Fixo/Parcelado no CARTÃO nasce sem conta — o cabeçalho é a âncora). */
  accountId?: string | null;
  lines: ConsolidatedLineInput[];
  /** v12: total da operação quando NÃO há linhas à vista (só Fixo/Parcelado) —
   *  cria o CABEÇALHO-ÂNCORA do grupo para que as contas fixas e os
   *  parcelamentos se consolidem como no "À Vista". */
  headerAmountCents?: number;
  headerType?: 'EXPENSE' | 'INCOME';
}

/** v9 — edição de lançamento simples (botão Alterar do Fluxo). */
export interface UpdateSimpleInput {
  description?: string;
  amountCents?: number;
  date?: string;
  categoryId?: string | null;
  /** Conta (despesa/receita) ou origem (transferência). */
  accountId?: string | null;
  /** Destino da transferência. */
  toAccountId?: string | null;
  /** Mês da fatura (compra no cartão). */
  referenceMonth?: string;
}

export class TransactionService {
  private transactions: TransactionRepo;
  private moves: FinancialMoveRepo;
  private invoices: InvoiceRepo;
  private invoiceItems: InvoiceItemRepo;
  private installments: InstallmentRepo;
  private plans: InstallmentPlanRepo;

  /** v26: gancho ligado em buildServices — o parcelamento do grupo acompanha a data do cabeçalho. */
  onGroupDateChange?: (groupId: string, oldDate: string, newDate: string) => Promise<void>;

  constructor(
    private db: DbDriver,
    private onCardPurchase?: (cardId: string, transactionId: string, amountCents: number, occurredAtIso: string, referenceMonth?: string) => Promise<void>
  ) {
    this.transactions = new TransactionRepo(db);
    this.moves = new FinancialMoveRepo(db);
    this.invoices = new InvoiceRepo(db);
    this.invoiceItems = new InvoiceItemRepo(db);
    this.installments = new InstallmentRepo(db);
    this.plans = new InstallmentPlanRepo(db);
  }

  /**
   * Despesa direta em conta (move imediato).
   * v21 (bug 2): lançamento À VISTA com data FUTURA nasce como PREVISÃO
   *  (status PENDING + movimento VOIDED) — não entra no saldo efetivado; entra
   *  apenas no "Previsto". No dia do vencimento a promoção automática
   *  (promoteDuePendings, no abrir do app e do Fluxo) efetiva de vez.
   */
  async createAccountExpense(input: CreateAccountExpenseInput): Promise<TransactionRow> {
    if (input.amountCents <= 0) throw new Error('Valor deve ser maior que zero');
    const date = input.date ?? todaySP();
    const futuro = date > todaySP();
    return this.db.transactionAsync(async () => {
      const tx: TransactionRow = {
        id: genId(),
        kind: 'SIMPLE',
        type: 'EXPENSE',
        amount_cents: input.amountCents,
        occurred_on: date,
        occurred_at: nowIso(),
        description: input.description,
        category_id: input.categoryId ?? null,
        account_id: input.accountId,
        transfer_account_id: null,
        card_id: null,
        source_system: input.source ?? 'MANUAL',
        external_ref_id: input.externalRefId ?? null,
        recurrence_rule_id: null,
        status: futuro ? 'PENDING' : 'CONFIRMED',
      };
      await this.transactions.insert(tx);
      await this.moves.insert({
        id: genId(),
        transaction_id: tx.id,
        installment_id: null,
        invoice_payment_id: null,
        account_id: input.accountId,
        direction: 'DEBIT',
        amount_cents: input.amountCents,
        effective_date: date,
        status: futuro ? 'VOIDED' : 'CONFIRMED',
      });
      return tx;
    });
  }

  /**
   * Receita direta em conta.
   * v21 (bug 2): mesma regra da despesa — data futura nasce como previsão.
   */
  async createAccountIncome(input: CreateAccountIncomeInput): Promise<TransactionRow> {
    if (input.amountCents <= 0) throw new Error('Valor deve ser maior que zero');
    const date = input.date ?? todaySP();
    const futuro = date > todaySP();
    return this.db.transactionAsync(async () => {
      const tx: TransactionRow = {
        id: genId(),
        kind: 'SIMPLE',
        type: 'INCOME',
        amount_cents: input.amountCents,
        occurred_on: date,
        occurred_at: nowIso(),
        description: input.description,
        category_id: input.categoryId ?? null,
        account_id: input.accountId,
        transfer_account_id: null,
        card_id: null,
        source_system: input.source ?? 'MANUAL',
        external_ref_id: input.externalRefId ?? null,
        recurrence_rule_id: null,
        status: futuro ? 'PENDING' : 'CONFIRMED',
      };
      await this.transactions.insert(tx);
      await this.moves.insert({
        id: genId(),
        transaction_id: tx.id,
        installment_id: null,
        invoice_payment_id: null,
        account_id: input.accountId,
        direction: 'CREDIT',
        amount_cents: input.amountCents,
        effective_date: date,
        status: futuro ? 'VOIDED' : 'CONFIRMED',
      });
      return tx;
    });
  }

  /** Compra no cartão: evento sem move; item entra na fatura correta (regra de corte). */
  async createCardExpense(input: CreateCardExpenseInput): Promise<TransactionRow> {
    if (input.amountCents <= 0) throw new Error('Valor deve ser maior que zero');
    const date = input.date ?? todaySP();
    const occurredAt = input.occurredAt ?? noonUtcIsoOf(date);
    const tx = await this.db.transactionAsync(async () => {
      const row: TransactionRow = {
        id: genId(),
        kind: 'SIMPLE',
        type: 'EXPENSE',
        amount_cents: input.amountCents,
        occurred_on: date,
        occurred_at: occurredAt,
        description: input.description,
        category_id: input.categoryId ?? null,
        account_id: null,
        transfer_account_id: null,
        card_id: input.cardId,
        source_system: input.source ?? 'MANUAL',
        external_ref_id: input.externalRefId ?? null,
        recurrence_rule_id: null,
        status: 'CONFIRMED',
      };
      await this.transactions.insert(row);
      return row;
    });
    // Hook da fatura (CardInvoiceService) — fora da transação para evitar savepoints longos
    if (this.onCardPurchase) {
      await this.onCardPurchase(input.cardId, tx.id, input.amountCents, occurredAt, input.referenceMonth);
    }
    return tx;
  }

  /** Transferência atômica entre contas (ARQ-004). */
  async createTransfer(input: CreateTransferInput): Promise<TransactionRow> {
    if (input.amountCents <= 0) throw new Error('Valor deve ser maior que zero');
    if (input.fromAccountId === input.toAccountId) throw new Error('Conta de origem e destino devem ser diferentes');
    const date = input.date ?? todaySP();
    const futuro = date > todaySP(); // v21 (bug 2): transferência futura vira previsão
    return this.db.transactionAsync(async () => {
      const tx: TransactionRow = {
        id: genId(),
        kind: 'SIMPLE',
        type: 'TRANSFER',
        amount_cents: input.amountCents,
        occurred_on: date,
        occurred_at: nowIso(),
        description: input.description,
        category_id: null,
        account_id: input.fromAccountId,
        transfer_account_id: input.toAccountId,
        card_id: null,
        source_system: 'MANUAL',
        external_ref_id: null,
        recurrence_rule_id: null,
        status: futuro ? 'PENDING' : 'CONFIRMED',
      };
      await this.transactions.insert(tx);
      await this.moves.insert({
        id: genId(),
        transaction_id: tx.id,
        installment_id: null,
        invoice_payment_id: null,
        account_id: input.fromAccountId,
        direction: 'DEBIT',
        amount_cents: input.amountCents,
        effective_date: date,
        status: futuro ? 'VOIDED' : 'CONFIRMED',
      });
      await this.moves.insert({
        id: genId(),
        transaction_id: tx.id,
        installment_id: null,
        invoice_payment_id: null,
        account_id: input.toAccountId,
        direction: 'CREDIT',
        amount_cents: input.amountCents,
        effective_date: date,
        status: futuro ? 'VOIDED' : 'CONFIRMED',
      });
      return tx;
    });
  }

  /**
   * v21 (bug 2) — PROMOÇÃO AUTOMÁTICA DE PREVISÕES VENCIDAS: lançamentos à
   *  vista (despesa, receita e transferência) criados para datas futuras
   *  nascem PENDING; quando a data chega, viram CONFIRMED e o movimento
   *  VOIDED volta a CONFIRMED (entra no saldo efetivado). Roda no abrir do
   *  app e no Fluxo — idempotente. Ocorrências de conta fixa (RECURRENCE)
   *  têm promoção própria e não passam por aqui.
   */
  async promoteDuePendings(today?: string): Promise<number> {
    const t = today ?? todaySP();
    // v23 (bug "saldo do dia"): REALINHA movimentos de lançamentos SIMPLES em
    // conta cuja effective_date divergiu da data EXIBIDA (occurred_on). Isso
    // acontece quando um à vista (movimento VOIDED) é EDITADO — a versão
    // anterior só atualizava movimentos CONFIRMED, e a promoção confirmava o
    // movimento na data ANTIGA: o saldo do dia antigo passava a considerar o
    // valor (o usuário via "saldo geral" no lugar do saldo do dia). Idempotente.
    //  · só movimentos de transações SIMPLES com conta (à vista, transferência,
    //    ocorrência de fixa em conta, linha de consolidado, OFX);
    //  · parcela (installment_id) e pagamento de fatura (invoice_payment_id)
    //    têm data própria legítima — ficam fora.
    await this.db.runAsync(
      `UPDATE financial_moves
          SET effective_date = (SELECT tx.occurred_on FROM transactions tx WHERE tx.id = financial_moves.transaction_id)
        WHERE installment_id IS NULL AND invoice_payment_id IS NULL
          AND status IN ('CONFIRMED','VOIDED')
          AND effective_date != (SELECT tx2.occurred_on FROM transactions tx2 WHERE tx2.id = financial_moves.transaction_id)
          AND EXISTS (SELECT 1 FROM transactions tx3
                       WHERE tx3.id = financial_moves.transaction_id
                         AND tx3.kind = 'SIMPLE' AND tx3.account_id IS NOT NULL)`
    );
    const rows = await this.db.getAllAsync<{
      id: string; type: string; amount_cents: number; account_id: string | null; card_id: string | null; occurred_on: string;
    }>(
      `SELECT id, type, amount_cents, account_id, card_id, occurred_on FROM transactions
        WHERE status = 'PENDING' AND kind = 'SIMPLE' AND source_system != 'RECURRENCE'
          AND occurred_on <= ?`,
      [t]
    );
    let promoted = 0;
    for (const row of rows) {
      try {
        await this.db.transactionAsync(async () => {
          const moves = await this.moves.getByTransaction(row.id);
          if (moves.some((m) => m.status === 'CONFIRMED')) {
            await this.transactions.setStatus(row.id, 'CONFIRMED');
            return;
          }
          if (row.card_id) {
            // Compra futura no cartão: o item já está na fatura — só efetiva o evento
            await this.transactions.setStatus(row.id, 'CONFIRMED');
            promoted++;
            return;
          }
          if (!row.account_id) return;
          if (moves.length > 0) {
            // v23: ao efetivar, o movimento assume a DATA EXIBIDA do
            // lançamento (occurred_on) — nunca uma data antiga de pré-edit
            await this.db.runAsync(
              "UPDATE financial_moves SET status = 'CONFIRMED', effective_date = ? WHERE transaction_id = ? AND status = 'VOIDED'",
              [row.occurred_on, row.id]
            );
          } else {
            await this.moves.insert({
              id: genId(),
              transaction_id: row.id,
              installment_id: null,
              invoice_payment_id: null,
              account_id: row.account_id,
              direction: row.type === 'INCOME' ? 'CREDIT' : 'DEBIT',
              amount_cents: row.amount_cents,
              effective_date: row.occurred_on,
              status: 'CONFIRMED',
            });
          }
          await this.transactions.setStatus(row.id, 'CONFIRMED');
          promoted++;
        });
      } catch {
        // promoção é best-effort; a próxima abertura tenta de novo
      }
    }
    return promoted;
  }

  /**
   * v7.1 — Lançamento CONSOLIDADO manual: créditos e débitos agrupados em uma
   * única operação, cada linha com descrição própria.
   *
   * Cabeçalho: kind CONSOLIDATED (sem account_id -> sem move, não afeta saldo).
   * Filhos: transações SIMPLE reais com parent_transaction_id — cada uma cria
   * seu financial_move (DEBIT/CREDIT) na conta do grupo.
   */
  async createConsolidatedGroup(input: CreateConsolidatedGroupInput): Promise<TransactionRow | null> {
    const date = input.date ?? todaySP();
    // v63.1: normaliza o alias `type` (INCOME/EXPENSE) para `direction` (CREDIT/DEBIT)
    const lines = (input.lines ?? [])
      .filter((l) => l.amountCents > 0)
      .map((l) => ({ ...l, direction: l.direction ?? (l.type === 'INCOME' ? 'CREDIT' : 'DEBIT') } as ConsolidatedLineInput));
    // v13 (bug C): a conta só é EXIGIDA quando existem linhas à vista (é nelas
    // que os movimentos recaem). Grupo só com Fixo/Parcelado no CARTÃO nasce
    // sem conta nenhuma — o cabeçalho é apenas a âncora do grupo.
    if (lines.length > 0 && !input.accountId) throw new Error('Selecione a conta');
    for (const l of lines) {
      if (!l.description || !l.description.trim()) throw new Error('Informe a descrição de cada linha');
      if (l.direction !== 'DEBIT' && l.direction !== 'CREDIT') throw new Error('Direção inválida na linha');
    }
    const debitTotal = lines.filter((l) => l.direction === 'DEBIT').reduce((a, b) => a + b.amountCents, 0);
    const creditTotal = lines.filter((l) => l.direction === 'CREDIT').reduce((a, b) => a + b.amountCents, 0);
    // v12 (bug A): consolidado só com Fixo/Parcelado TAMBÉM nasce — o cabeçalho
    // é a âncora do grupo (vínculo das regras/planos) e carrega o total da
    // operação. Sem linhas e sem total informado, nada é criado.
    const anchorAmount = lines.length > 0 ? debitTotal + creditTotal : (input.headerAmountCents ?? 0);
    if (anchorAmount <= 0) return null;
    const headerType: 'EXPENSE' | 'INCOME' =
      lines.length > 0
        ? debitTotal >= creditTotal ? 'EXPENSE' : 'INCOME'
        : (input.headerType ?? 'EXPENSE');

    return this.db.transactionAsync(async () => {
      const parentId = genId();
      const parent: TransactionRow = {
        id: parentId,
        kind: 'CONSOLIDATED',
        type: headerType,
        amount_cents: anchorAmount,
        occurred_on: date,
        occurred_at: nowIso(),
        description: input.description.trim() || 'Operação consolidada',
        category_id: input.categoryId ?? null,
        account_id: null,
        transfer_account_id: null,
        card_id: null,
        source_system: 'MANUAL',
        external_ref_id: null,
        recurrence_rule_id: null,
        status: 'CONFIRMED',
      };
      await this.transactions.insert(parent);

      for (const l of lines) {
        const child: TransactionRow = {
          id: genId(),
          kind: 'SIMPLE',
          type: l.direction === 'DEBIT' ? 'EXPENSE' : 'INCOME',
          amount_cents: l.amountCents,
          occurred_on: date,
          occurred_at: nowIso(),
          description: l.description.trim(),
          // v8: categoria da linha tem prioridade; categoria do grupo é o fallback (opcional)
          category_id: l.categoryId ?? input.categoryId ?? null,
          account_id: input.accountId ?? null,
          transfer_account_id: null,
          card_id: null,
          source_system: 'MANUAL',
          external_ref_id: null,
          recurrence_rule_id: null,
          status: 'CONFIRMED',
          parent_transaction_id: parentId,
        };
        await this.transactions.insert(child);
        await this.moves.insert({
          id: genId(),
          transaction_id: child.id,
          installment_id: null,
          invoice_payment_id: null,
          account_id: input.accountId!,
          direction: l.direction,
          amount_cents: l.amountCents,
          effective_date: date,
          status: 'CONFIRMED',
        });
      }
      return parent;
    });
  }

  /**
   * v22 (bug 1) — INCLUIR linhas À VISTA num grupo consolidado JÁ EXISTENTE
   * (botão "+Incluir" do cabeçalho do consolidado no Fluxo, que abre a tela de
   * Novo Lançamento em modal). Cada linha vira filho SIMPLE real com
   * parent_transaction_id = grupo e cria o financial_move (DEBIT/CREDIT) na
   * conta informada — exatamente como as linhas criadas junto com o grupo.
   * O total do cabeçalho é regravado (linhas antigas + novas) para manter o
   * relatório de custo da operação coerente.
   */
  async addAvistaLinesToGroup(
    groupId: string,
    input: {
      date: string;
      accountId: string;
      lines: Array<{ direction: 'DEBIT' | 'CREDIT'; description: string; amountCents: number; categoryId: string | null }>;
    }
  ): Promise<void> {
    const lines = (input.lines ?? []).filter((l) => l.amountCents > 0);
    if (lines.length === 0) return;
    await this.db.transactionAsync(async () => {
      const header = await this.transactions.getById(groupId);
      if (!header || header.kind !== 'CONSOLIDATED') throw new Error('Grupo consolidado não encontrado');
      for (const l of lines) {
        if (!l.description || !l.description.trim()) throw new Error('Informe a descrição de cada linha');
        if (l.direction !== 'DEBIT' && l.direction !== 'CREDIT') throw new Error('Direção inválida na linha');
      }
      for (const l of lines) {
        const child: TransactionRow = {
          id: genId(),
          kind: 'SIMPLE',
          type: l.direction === 'DEBIT' ? 'EXPENSE' : 'INCOME',
          amount_cents: l.amountCents,
          occurred_on: input.date,
          occurred_at: nowIso(),
          description: l.description.trim(),
          category_id: l.categoryId ?? null,
          account_id: input.accountId,
          transfer_account_id: null,
          card_id: null,
          source_system: 'MANUAL',
          external_ref_id: null,
          recurrence_rule_id: null,
          status: 'CONFIRMED',
          parent_transaction_id: groupId,
        };
        await this.transactions.insert(child);
        await this.moves.insert({
          id: genId(),
          transaction_id: child.id,
          installment_id: null,
          invoice_payment_id: null,
          account_id: input.accountId,
          direction: l.direction,
          amount_cents: l.amountCents,
          effective_date: input.date,
          status: 'CONFIRMED',
        });
      }
      const extra = lines.reduce((a, b) => a + b.amountCents, 0);
      await this.db.runAsync(
        'UPDATE transactions SET amount_cents = amount_cents + ? WHERE id = ?',
        [extra, groupId]
      );
    });
  }

  /**
   * v10 — ALTERAR O GRUPO CONSOLIDADO (setinha do Fluxo): atualiza a
   * "Descrição do Grupo Geral" e a data do cabeçalho — e repassa a DATA para
   * todas as linhas (filhos) e seus movimentos. A descrição digitada pelo
   * usuário é a que passa a aparecer no Fluxo (nunca mais o texto padrão).
   * v18 (bug 1): a alteração de data é aplicada COMPLETA e reflete no Fluxo de
   * imediato — occurred_on e occurred_at do cabeçalho e das linhas, movimentos
   * CONFIRMED reposicionados para o novo dia. O Fluxo recarrega no bump().
   */
  async updateGroupHeader(groupId: string, patch: { description?: string; date?: string }): Promise<void> {
    await this.db.transactionAsync(async () => {
      const tx = await this.transactions.getById(groupId);
      if (!tx || tx.kind !== 'CONSOLIDATED') throw new Error('Grupo consolidado não encontrado');
      const newDescription = patch.description?.trim() || tx.description;
      const newDate = patch.date ?? tx.occurred_on;
      await this.db.runAsync(
        'UPDATE transactions SET description = ?, occurred_on = ?, occurred_at = ? WHERE id = ?',
        [newDescription, newDate, noonUtcIsoOf(newDate), groupId]
      );
      const children = await this.db.getAllAsync<{ id: string }>(
        'SELECT id FROM transactions WHERE parent_transaction_id = ?',
        [groupId]
      );
      for (const ch of children) {
        await this.db.runAsync(
          'UPDATE transactions SET occurred_on = ?, occurred_at = ? WHERE id = ?',
          [newDate, noonUtcIsoOf(newDate), ch.id]
        );
        const moves = await this.moves.getByTransaction(ch.id);
        for (const m of moves) {
          if (m.status !== 'CONFIRMED') continue;
          await this.moves.updateMove(m.id, { effective_date: newDate });
        }
      }
      // v26 (bug "mudei a data do consolidado e o saldo previsto ficou errado"):
      // a CONTA FIXA e as PARCELAS do grupo também acompanham a nova data —
      // antes só as linhas à vista andavam e o resto ficava no dia antigo,
      // então o saldo do dia descontava o mesmo grupo em DOIS dias diferentes.
      const oldDate = tx.occurred_on;
      if (newDate !== oldDate) {
        const oldMonth = oldDate.slice(0, 7);
        // ocorrências de fixa em conta do mês do cabeçalho (só quando o mês não muda —
        // senão a previsão recriaria a ocorrência no mês antigo)
        if (newDate.slice(0, 7) === oldMonth) {
          const occs = await this.db.getAllAsync<{ id: string }>(
            `SELECT t.id FROM transactions t
               JOIN recurrence_rules r ON r.id = t.recurrence_rule_id
              WHERE r.group_transaction_id = ? AND t.status != 'VOIDED'
                AND substr(t.occurred_on, 1, 7) = ? AND t.occurred_on != ?`,
            [groupId, oldMonth, newDate]
          );
          for (const o of occs) await this.updateSimple(o.id, { date: newDate });
        }
        if (this.onGroupDateChange) await this.onGroupDateChange(groupId, oldDate, newDate);
      }
    });
  }

  /**
   * v10 — EXCLUSÃO FÍSICA (regra nova: excluir = apagar DE VERDADE).
   * A antiga marca "Cancelado" (VOIDED) foi abolida: o registro sai
   * definitivamente do banco de dados, junto com movimentos, itens derivados
   * de fatura e parcelas pendentes do plano vinculado.
   *  - Grupo consolidado: excluir o cabeçalho apaga TODAS as linhas;
   *    excluir a última linha viva apaga o cabeçalho.
   *  - Ocorrência de conta fixa: registra uma EXCLUSÃO do mês (a regra não
   *    recria a ocorrência daquele mês) sem encerrar os próximos meses.
   */
  async deleteTransaction(transactionId: string): Promise<void> {
    await this.db.transactionAsync(async () => {
      await this.deleteTransactionInner(transactionId);
    });
  }

  /** Corpo da exclusão física (sem wrapper de transação — reutilizado pela
   *  exclusão profunda do grupo, que já roda dentro de uma transação). */
  private async deleteTransactionInner(transactionId: string): Promise<void> {
    const tx = await this.transactions.getById(transactionId);
      if (!tx) throw new Error('Transação não encontrada');

      // 0. Ocorrência de conta fixa: impede que a regra recrie este mês
      if (tx.source_system === 'RECURRENCE' && tx.recurrence_rule_id && tx.external_ref_id) {
        const month = tx.external_ref_id.split(':').pop();
        if (month && /^\d{4}-\d{2}$/.test(month)) {
          await this.db.runAsync(
            'INSERT OR IGNORE INTO recurrence_exclusions (rule_id, occurred_month) VALUES (?,?)',
            [tx.recurrence_rule_id, month]
          );
        }
      }

      // 1. Libera referências cruzadas (FKs) antes de apagar a transação
      await this.detachTransactionRefs(transactionId);

      // 1.5 v11: linhas Fixo/Parcelado VINCULADAS ao grupo viram independentes —
      // a conta fixa e o parcelamento sobrevivem à exclusão da operação que os criou.
      await this.db.runAsync(
        'UPDATE recurrence_rules SET group_transaction_id = NULL WHERE group_transaction_id = ?',
        [transactionId]
      );
      await this.db.runAsync(
        'UPDATE installment_plans SET group_transaction_id = NULL WHERE group_transaction_id = ?',
        [transactionId]
      );

      // 2. Grupo consolidado: apaga FISICAMENTE as linhas (filhos) em cascata
      if (tx.kind === 'CONSOLIDATED') {
        const children = await this.db.getAllAsync<{ id: string; card_id: string | null }>(
          'SELECT id, card_id FROM transactions WHERE parent_transaction_id = ?',
          [transactionId]
        );
        for (const ch of children) {
          await this.detachTransactionRefs(ch.id);
          await this.moves.deleteByTransaction(ch.id);
          if (ch.card_id) {
            const item = await this.db.getFirstAsync<{ invoice_id: string }>(
              'SELECT invoice_id FROM invoice_items WHERE transaction_id = ?',
              [ch.id]
            );
            await this.invoiceItems.deleteByTransaction(ch.id);
            if (item) await this.rebuildInvoiceTotal(item.invoice_id);
          }
          await this.transactions.delete(ch.id);
        }
      }

      // 3. Consolidada com parcelamento: apaga parcelas pendentes + moves + itens derivados.
      //    v18 (bug 4): a ORDEM importa — os itens de fatura são apagados ANTES das
      //    parcelas (invoice_items.installment_id tem FK para installments; apagar a
      //    parcela primeiro estourava "FOREIGN KEY constraint failed" e a exclusão
      //    inteira falhava com erro no app).
      if (tx.kind === 'CONSOLIDATED') {
        const plan = await this.db.getFirstAsync<{ id: string }>(
          'SELECT id FROM installment_plans WHERE original_transaction_id = ?',
          [transactionId]
        );
        if (plan) {
          const insts = await this.installments.getByPlan(plan.id);
          const pendingIds = insts.filter((i) => i.status === 'PENDING').map((i) => i.id);
          if (pendingIds.length) {
            const affected = await this.db.getAllAsync<{ invoice_id: string }>(
              `SELECT DISTINCT invoice_id FROM invoice_items WHERE installment_id IN (${pendingIds.map(() => '?').join(',')})`,
              pendingIds as never
            );
            await this.invoiceItems.deleteByInstallments(pendingIds);
            for (const inv of affected) {
              await this.rebuildInvoiceTotal(inv.invoice_id);
            }
            for (const instId of pendingIds) {
              await this.moves.deleteByInstallment(instId);
              await this.installments.delete(instId);
            }
          }
          // Plano sem nenhuma parcela restante é apagado; com parcelas pagas,
          // sobrevive apenas como histórico (desvinculado da compra excluída).
          if ((await this.installments.countByPlan(plan.id)) === 0) {
            await this.plans.deletePlan(plan.id);
          } else {
            await this.plans.detachOriginal(plan.id);
          }
        }
      }

      // 4. Transação SIMPLE em cartão: remove item da fatura e recalcula
      if (tx.kind === 'SIMPLE' && tx.card_id) {
        const item = await this.db.getFirstAsync<{ invoice_id: string }>(
          'SELECT invoice_id FROM invoice_items WHERE transaction_id = ?',
          [transactionId]
        );
        await this.invoiceItems.deleteByTransaction(transactionId);
        if (item) await this.rebuildInvoiceTotal(item.invoice_id);
      }

      // 5. Apaga os movimentos e a própria transação — FISICAMENTE
      await this.moves.deleteByTransaction(transactionId);
      await this.transactions.delete(transactionId);

      // 6. Filho de grupo: se o cabeçalho ficou sem linhas, o cabeçalho também é apagado.
      //    (v10: roda DEPOIS de apagar a própria linha — os filhos referenciam o pai
      //     por FK e o pai só pode ser removido com a lista de filhos já vazia.)
      //    v18 (bug 4): antes de remover o cabeçalho, as regras/planos VINCULADOS
      //    a ele (group_transaction_id) viram independentes — sem isso o FK do
      //    vínculo estourava e a exclusão da última linha falhava com erro.
      if (tx.parent_transaction_id) {
        const parentId = tx.parent_transaction_id;
        const remaining = await this.db.getFirstAsync<{ n: number }>(
          'SELECT COUNT(*) AS n FROM transactions WHERE parent_transaction_id = ?',
          [parentId]
        );
        if ((remaining?.n ?? 0) === 0) {
          await this.db.runAsync(
            'UPDATE recurrence_rules SET group_transaction_id = NULL WHERE group_transaction_id = ?',
            [parentId]
          );
          await this.db.runAsync(
            'UPDATE installment_plans SET group_transaction_id = NULL WHERE group_transaction_id = ?',
            [parentId]
          );
          await this.detachTransactionRefs(parentId);
          await this.moves.deleteByTransaction(parentId);
          await this.transactions.delete(parentId);
        }
      }
  }

  /**
   * v12 — EXCLUIR A OPERAÇÃO CONSOLIDADA INTEIRA (card do Fluxo, recolhido ou
   * expandido — a ação vale para TODO o grupo):
   *  - Linhas à vista: apagadas fisicamente (com movimentos);
   *  - CONTAS FIXAS criadas dentro: a regra e TODAS as ocorrências (todos os
   *    meses) são apagadas — inclusive itens de fatura de fixas no cartão;
   *  - PARCELAMENTOS criados dentro: parcelas em aberto apagadas (com itens de
   *    fatura e movimentos); se houver parcelas PAGAS, elas sobrevivem como
   *    histórico (plano desvinculado); sem parcelas restantes, o plano e o
   *    cabeçalho da compra são apagados.
   */
  async deleteGroupDeep(groupId: string): Promise<void> {
    await this.db.transactionAsync(async () => {
      const tx = await this.transactions.getById(groupId);
      if (!tx) throw new Error('Transação não encontrada');
      if (tx.kind !== 'CONSOLIDATED') {
        throw new Error('Somente uma operação consolidada tem exclusão do grupo completo');
      }

      // 1. CONTAS FIXAS do grupo: regra + ocorrências (histórico completo)
      const rules = await this.db.getAllAsync<{ id: string }>(
        'SELECT id FROM recurrence_rules WHERE group_transaction_id = ?',
        [groupId]
      );
      for (const rule of rules) {
        const occ = await this.db.getAllAsync<{ id: string; card_id: string | null }>(
          'SELECT id, card_id FROM transactions WHERE recurrence_rule_id = ?',
          [rule.id]
        );
        for (const o of occ) {
          await this.detachTransactionRefs(o.id);
          if (o.card_id) {
            const item = await this.db.getFirstAsync<{ invoice_id: string }>(
              'SELECT invoice_id FROM invoice_items WHERE transaction_id = ?',
              [o.id]
            );
            await this.invoiceItems.deleteByTransaction(o.id);
            if (item) await this.rebuildInvoiceTotal(item.invoice_id);
          }
          await this.moves.deleteByTransaction(o.id);
          await this.transactions.delete(o.id);
        }
        await this.db.runAsync('DELETE FROM recurrence_exclusions WHERE rule_id = ?', [rule.id]);
        await this.db.runAsync('DELETE FROM recurrence_rules WHERE id = ?', [rule.id]);
      }

      // 2. PARCELAMENTOS do grupo: parcelas em aberto saem de vez
      const plans = await this.db.getAllAsync<{ id: string; original_transaction_id: string | null }>(
        'SELECT id, original_transaction_id FROM installment_plans WHERE group_transaction_id = ?',
        [groupId]
      );
      for (const plan of plans) {
        const insts = await this.installments.getByPlan(plan.id);
        const removable = insts.filter((i) => i.status !== 'PAID').map((i) => i.id);
        for (const instId of removable) {
          await this.moves.deleteByInstallment(instId);
          const affected = await this.db.getAllAsync<{ invoice_id: string }>(
            'SELECT DISTINCT invoice_id FROM invoice_items WHERE installment_id = ?',
            [instId]
          );
          await this.invoiceItems.deleteByInstallments([instId]);
          for (const inv of affected) {
            await this.rebuildInvoiceTotal(inv.invoice_id);
          }
          await this.installments.delete(instId);
        }
        if ((await this.installments.countByPlan(plan.id)) === 0) {
          // Nenhuma parcela restante (nenhuma paga): plano e cabeçalho da compra saem
          await this.plans.deletePlan(plan.id);
          if (plan.original_transaction_id) {
            await this.detachTransactionRefs(plan.original_transaction_id);
            await this.moves.deleteByTransaction(plan.original_transaction_id);
            await this.transactions.delete(plan.original_transaction_id);
          }
        } else {
          // Parcelas pagas sobrevivem como histórico, desvinculadas do grupo
          await this.db.runAsync(
            'UPDATE installment_plans SET group_transaction_id = NULL WHERE id = ?',
            [plan.id]
          );
        }
      }

      // 3. O próprio grupo: cabeçalho + linhas à vista (cascata existente)
      await this.deleteTransactionInner(groupId);
    });
  }

  /** v10: nulifica referências que apontam para a transação (OFX, despensa, NFC-e). */
  private async detachTransactionRefs(transactionId: string): Promise<void> {
    await this.db.runAsync('UPDATE ofx_statement_lines SET matched_transaction_id = NULL WHERE matched_transaction_id = ?', [transactionId]);
    await this.db.runAsync('UPDATE pantry_ledger SET transaction_id = NULL WHERE transaction_id = ?', [transactionId]);
    await this.db.runAsync('UPDATE nfce_documents SET transaction_id = NULL WHERE transaction_id = ?', [transactionId]);
  }

  /** Recalcula total_cents de uma fatura a partir dos itens (agregado derivado). */
  private async rebuildInvoiceTotal(invoiceId: string): Promise<void> {
    const total = await this.invoiceItems.sumByInvoice(invoiceId);
    const invoice = await this.invoices.getById(invoiceId);
    if (!invoice) return;
    const due = total - invoice.credit_from_prev_cents - invoice.paid_cents;
    let status = invoice.status;
    if (due <= 0) status = 'PAID';
    else if (invoice.paid_cents > 0) status = 'PARTIALLY_PAID';
    else if (invoice.status === 'PAID' || invoice.status === 'PARTIALLY_PAID') status = 'OPEN';
    await this.invoices.updateTotals(invoiceId, { total_cents: total, status });
  }

  /**
   * v9 — STATUS PAGO / NÃO PAGO (Recebido / Não Recebido):
   *  - paid = true  -> CONFIRMED + garante o movimento financeiro (entra no saldo).
   *  - paid = false -> PENDING + VOID dos movimentos (vira previsão; sai do saldo).
   * Aplica-se a despesa/receita SIMPLES em CONTA (à vista, fixa, OFX). Compras no
   * cartão, transferências e grupos consolidados têm ciclo próprio (fatura/moves)
   * e não passam por aqui.
   */
  async setPaymentStatus(transactionId: string, paid: boolean): Promise<void> {
    await this.db.transactionAsync(async () => {
      const tx = await this.transactions.getById(transactionId);
      if (!tx) throw new Error('Transação não encontrada');
      if (tx.status === 'VOIDED') throw new Error('Lançamento excluído — status indisponível');
      if (tx.kind !== 'SIMPLE') throw new Error('Status se aplica apenas a lançamentos simples');
      if (tx.type === 'TRANSFER') throw new Error('Transferência não tem status Pago/Não Pago');
      if (tx.card_id) throw new Error('Compra no cartão é paga pela fatura — marque o pagamento na fatura');
      if (!tx.account_id) throw new Error('Lançamento sem conta vinculada');

      if (paid) {
        const moves = await this.moves.getByTransaction(transactionId);
        if (!moves.some((m) => m.status === 'CONFIRMED')) {
          await this.moves.insert({
            id: genId(),
            transaction_id: transactionId,
            installment_id: null,
            invoice_payment_id: null,
            account_id: tx.account_id,
            direction: tx.type === 'INCOME' ? 'CREDIT' : 'DEBIT',
            amount_cents: tx.amount_cents,
            effective_date: tx.occurred_on,
            status: 'CONFIRMED',
          });
        }
        await this.transactions.setStatus(transactionId, 'CONFIRMED');
      } else {
        await this.moves.voidByTransaction(transactionId);
        await this.transactions.setStatus(transactionId, 'PENDING');
      }
    });
  }

  /**
   * v9 — ALTERAR (editar lançamento do Fluxo). Aplica-se a lançamentos SIMPLE
   * (à vista em conta, no cartão, transferência, OFX e ocorrência de conta fixa).
   *  - Conta: atualiza transação + movimento (conta, valor, data).
   *  - Cartão: atualiza transação e reavalia o item da fatura; se o mês de
   *    referência mudar, o item migra para a fatura correta (com regra de corte
   *    e bloqueio de fatura fechada).
   *  - Transferência: atualiza os dois movimentos atomicamente.
   */
  async updateSimple(transactionId: string, patch: UpdateSimpleInput): Promise<void> {
    const amount = patch.amountCents;
    if (amount != null && amount <= 0) throw new Error('Valor deve ser maior que zero');
    const tx = await this.transactions.getById(transactionId);
    if (!tx) throw new Error('Transação não encontrada');
    if (tx.status === 'VOIDED') throw new Error('Este lançamento foi excluído');
    if (tx.kind !== 'SIMPLE') throw new Error('Somente lançamentos simples podem ser alterados aqui');

    const newDate = patch.date ?? tx.occurred_on;
    const newAmount = amount ?? tx.amount_cents;
    const newDescription = patch.description?.trim() || tx.description;

    await this.db.transactionAsync(async () => {
      // 1. Transação (comum a todos os casos)
      await this.db.runAsync(
        'UPDATE transactions SET description = ?, amount_cents = ?, occurred_on = ? WHERE id = ?',
        [newDescription, newAmount, newDate, transactionId]
      );
      if (patch.categoryId !== undefined) {
        await this.transactions.setCategory(transactionId, patch.categoryId);
      }

      if (tx.type === 'TRANSFER') {
        // 2. Transferência: dois movimentos (DEBIT origem, CREDIT destino)
        const from = patch.accountId ?? tx.account_id;
        const to = patch.toAccountId ?? tx.transfer_account_id;
        if (!from || !to) throw new Error('Conta de origem e destino são obrigatórias');
        if (from === to) throw new Error('Origem e destino devem ser diferentes');
        await this.db.runAsync('UPDATE transactions SET account_id = ?, transfer_account_id = ? WHERE id = ?', [from, to, transactionId]);
        const moves = await this.moves.getByTransaction(transactionId);
        for (const m of moves) {
          // v23: VOIDED também — transferência futura (previsão) precisa
          // acompanhar a edição; antes o movimento ficava na data/valor antigos
          await this.moves.updateMove(m.id, {
            account_id: m.direction === 'DEBIT' ? from : to,
            amount_cents: newAmount,
            effective_date: newDate,
          });
        }
        return;
      }

      if (tx.card_id && !tx.account_id) {
        // 3. Compra no cartão: reavalia o item da fatura (possível migração de fatura)
        const item = await this.invoiceItems.getByTransaction(transactionId);
        const occurredAt = noonUtcIsoOf(newDate);
        await this.db.runAsync('UPDATE transactions SET occurred_at = ? WHERE id = ?', [occurredAt, transactionId]);
        if (!item) {
          if (this.onCardPurchase) {
            await this.onCardPurchase(tx.card_id, transactionId, newAmount, occurredAt, patch.referenceMonth ?? undefined);
          }
          return;
        }
        const oldInvoice = await this.invoices.getById(item.invoice_id);
        let targetMonth: string | null = oldInvoice?.reference_month ?? null;
        if (patch.referenceMonth) {
          targetMonth = patch.referenceMonth;
        } else if (newDate !== tx.occurred_on) {
          // Data mudou sem mês explícito: segue a regra de corte do cartão
          const card = await this.db.getFirstAsync<{ closing_day: number }>('SELECT closing_day FROM cards WHERE id = ?', [tx.card_id]);
          if (card) {
            const day = parseInt(newDate.slice(8, 10), 10);
            const ym = newDate.slice(0, 7);
            const lastDay = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
            const closing = Math.min(card.closing_day, lastDay);
            targetMonth = day <= closing ? ym : monthAdd(ym, 1);
          }
        }
        if (targetMonth && targetMonth !== oldInvoice?.reference_month) {
          await this.invoiceItems.deleteByTransaction(transactionId);
          if (oldInvoice) await this.rebuildInvoiceTotal(oldInvoice.id);
          if (this.onCardPurchase) {
            await this.onCardPurchase(tx.card_id, transactionId, newAmount, occurredAt, targetMonth);
          }
        } else {
          await this.invoiceItems.updateAmountByTransaction(transactionId, newAmount);
          if (item.invoice_id) await this.rebuildInvoiceTotal(item.invoice_id);
        }
        return;
      }

      // 4. Despesa/receita em conta: atualiza o movimento
      //    v23 (bug "saldo do dia previsto"): TODOS os movimentos da
      //    transação — inclusive o VOIDED da previsão à vista. Antes, editar
      //    um à vista futuro mudava a data EXIBIDA mas o movimento VOIDED
      //    ficava na data/valor antigos; a promoção o confirmava lá e o
      //    saldo do dia antigo passava a considerar o valor (parecia o
      //    "saldo geral").
      if (patch.accountId) {
        await this.db.runAsync('UPDATE transactions SET account_id = ? WHERE id = ?', [patch.accountId, transactionId]);
      }
      const moves = await this.moves.getByTransaction(transactionId);
      for (const m of moves) {
        await this.moves.updateMove(m.id, {
          account_id: patch.accountId ?? tx.account_id ?? undefined,
          amount_cents: newAmount,
          effective_date: newDate,
        });
      }
    });
  }

  async listFlow(month: string): Promise<(TransactionRow & {
    category_name: string | null;
    account_name: string | null;
    card_name: string | null;
    transfer_account_name: string | null;
    plan_id: string | null;
    plan_total_installments: number | null;
    plan_paid_count: number | null;
    child_count: number;
    group_debits_cents: number;
    group_credits_cents: number;
  })[]> {
    return this.transactions.listMonth(month);
  }

  /** v7.1: filhos de um grupo consolidado (expansão na tela Fluxo). */
  async listChildren(parentId: string) {
    return this.transactions.listChildren(parentId);
  }

  /** Data local SP de uma transação (para exibição). */
  static localDateOf(tx: { occurred_on: string; occurred_at: string }): string {
    return tx.occurred_on.length === 10 ? tx.occurred_on : spDateOfIso(tx.occurred_at);
  }
}
