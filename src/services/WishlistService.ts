/**
 * WishlistService (v69) — PROGRAMAÇÃO DE COMPRA.
 *
 * METODOLOGIA DO USUÁRIO (hierarquia — tudo concorre):
 *  1) ORÇAMENTO — limite restante após gastos/compromissos, abatido primeiro.
 *  2) PROGRAMAÇÃO DE COMPRA — a sobra vai para os itens na ordem
 *     PRIORIDADE > NECESSÁRIO > DESEJO. Se o montante de uma classificação
 *     não cabe, passa para o mês seguinte (e as de baixo nem começam).
 *  3) POUPANÇA MENSAL — transferência programada, abatida após as compras.
 *  4) POUPANÇA "FECHAMENTO DO MÊS" — recebe a sobra positiva final.
 *
 * RESERVA ("Reservar"): transfere dinheiro REAL de uma conta do saldo para a
 * caixinha "Reserva · Programação de Compra" — conta criada automaticamente e
 * marcada para NUNCA entrar no saldo geral (include_in_general_balance = 0),
 * ou para a conta POUPANÇA escolhida com is_poupanca = 1 (na tela inicial a
 * conta Poupança ganha a fechinha que separa "Poupança normal" / "Reserva
 * Programação de Compra"). Enquanto está na caixinha, o Fluxo não conta esse
 * dinheiro como disponível.
 *
 * BARRA DE PROGRESSÃO: reservado / valor do item. 100% = "Pronto para
 * comprar". Ao COMPRAR, o item sai da lista e vira lançamento normal
 * (despesa em conta — dinheiro sai da caixinha de reserva).
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { nowIso, monthAdd, todaySP, monthOf } from '../lib/dates';
import { TransactionService } from './TransactionService';
import { BalanceService } from './BalanceService';
import type { BudgetMonthSummary } from './BudgetService';
import type { SavingsMonthOverview } from './SavingsService';
import { availableForWishlistAtMonthEnd } from '../lib/monthEndBalance';

export type WishlistClass = 'PRIORIDADE' | 'NECESSARIO' | 'DESEJO';

export const WISHLIST_CLASSES: WishlistClass[] = ['PRIORIDADE', 'NECESSARIO', 'DESEJO'];

export const CLASS_LABELS: Record<WishlistClass, string> = {
  PRIORIDADE: 'Prioridade',
  NECESSARIO: 'Necessário',
  DESEJO: 'Desejo',
};

/** Nome fixo da caixinha FORA do saldo (conta interna do próprio serviço). */
export const RESERVA_ACCOUNT_NAME = 'Reserva · Programação de Compra';

export interface WishlistItemRow {
  id: string;
  classificacao: WishlistClass;
  description: string;
  target_cents: number;
  link: string | null;
  reserved_cents: number;
  status: 'OPEN' | 'BOUGHT';
  bought_transaction_id: string | null;
  created_at: string;
}

export interface WishlistItemView extends WishlistItemRow {
  /** Reservado/target em 0-100 (inteiro, sem decimais). */
  pct: number;
  faltaCents: number;
  pronto: boolean;
}

export interface WishlistClassView {
  cls: WishlistClass;
  label: string;
  totalCents: number;
  itemCount: number;
  items: WishlistItemView[];
}

export interface WishlistMethodology {
  month: string;
  /** Sobra do mês (saldo previsto no último lançamento, nunca negativa). */
  sobraCents: number;
  /** Total orçado no mês (null = módulo Orçamento desligado). */
  budgetedCents: number | null;
  /** Programado da Poupança MENSAL (null = módulo Poupança desligado). */
  poupancaMensalCents: number | null;
  /** Capacidade do mês para a Programação de Compra (sobra). */
  capacityCents: number;
  classes: Array<{
    cls: WishlistClass;
    label: string;
    totalCents: number;
    itemCount: number;
    /** Mês (1-based) em que a classificação COMEÇA a reservar. */
    startMonth: number;
    /** Mês (1-based) em que a classificação TERMINA. 0 = não começa. */
    endMonth: number;
  }>;
  /** Meses para comprar tudo de Prioridade (null = sem itens). */
  monthsPrioridade: number | null;
  /** Meses para comprar TUDO. */
  monthsTotal: number | null;
  /** Frases prontas para a tela. */
  messagePrioridade: string | null;
  messageTotal: string | null;
}

/** Projeção mês a mês (v89 → v90):
 *  v89: sobra do MÊS DE REFERÊNCIA repetida em todos os meses da simulação
 *       (capacidade fixa — não carregava sobra entre meses).
 *  v90: SALDO PREVISTO REAL de cada mês (caminha mês a mês); o que SOBRA de
 *       um mês carrega para o próximo (carryover) — uma sobra grande em
 *       dez/2026 é USADA em dez, e o que sobrar dela segue para jan/2027.
 *       Cascade sempre respeitando a ordem Prioridade → Necessário → Desejo
 *       (se uma nova "Prioridade" entrar durante a simulação, a ordem volta
 *       a ser respeitada porque `listOpen()` é relido a cada `getProjection`). */
export interface WishlistProjectionMonth {
  month: string; // 'YYYY-MM'
  /** Sobra REALMENTE usada neste mês (capacity − leftover) — 0 quando a
   *  sobra + carryover foi toda consumida; jamais negativa. */
  contributionCents: number;
  classes: Array<{
    cls: WishlistClass;
    label: string;
    faltaInicioCents: number;
    abatidoCents: number;
    faltaFimCents: number;
  }>;
}

export interface WishlistProjection {
  /** Mês para o qual a projeção foi tirada. */
  referenceMonth: string;
  /** Capacidade mensal DO PRIMEIRO MÊS (sobra prevista do mês corrente). */
  capacityCents: number;
  /** Um resultado por mês, do mês corrente até referenceMonth. */
  months: WishlistProjectionMonth[];
  /** Quantos meses até a falta zerar (null se passar de 12). */
  monthsUntilDone: number | null;
  /** true se a simulação esvaziou todas as classes. */
  done: boolean;
}

/** v95 — Plano de UM mês da Programação de Compra (o que cabe / foi abatido
 *  NESTE mês). Usado pelo card fixo do Fluxo (chips por classificação e valor
 *  do cabeçalho) e pela hierarquia do Saldo do dia (o que se abate da
 *  disponibilidade).
 *
 *  · `planoCents`        = soma dos `abatidoCents` do mês (vai à direita do card);
 *  · `faltaInicioCents`  = total que ENTROU neste mês (a hierarquia do Saldo do dia abate esse valor);
 *  · `classes`           = as 3 classes com os mesmos `abatidoCents`/`faltaInicioCents`.
 *
 *  Quando `month` não está na projeção (mês anterior ao planejamento, ou após
 *  a quitação total) devolve zeros — a previsão só vale para o mês em que
 *  foi planejada; não se reflete automaticamente para os demais. */
export function projectionMonthPlan(
  projection: WishlistProjection | null,
  month: string
): {
  planoCents: number;
  faltaInicioCents: number;
  classes: WishlistProjectionMonth['classes'];
} {
  const m = projection?.months.find((x) => x.month === month);
  if (!m) return { planoCents: 0, faltaInicioCents: 0, classes: [] };
  const planoCents = m.classes.reduce((a, c) => a + c.abatidoCents, 0);
  const faltaInicioCents = m.classes.reduce((a, c) => a + c.faltaInicioCents, 0);
  return { planoCents, faltaInicioCents, classes: m.classes };
}

/**
 * v90 — Callback opcional para a projeção MÊS A MÊS: dado o mês simulated m,
 * devolve o saldo previsto do fim daquele mês e os resumos de
 * Orçamento/Poupança daquele mês (se o módulo estiver ligado). Quando o
 * callback NÃO é informado, o saldo é calculado pelo `BalanceService`
 * (normal) e Orçamento/Poupança são null (capacidade bruta).
 *
 * Útil para a tela passar resumos cacheados ou permitir overrides em teste.
 */
export type WishlistProjectionFetcher = (
  month: string
) => Promise<{
  /** Saldo previsto no fim do mês `month` (do `dual.previsto`). */
  saldoPrevistoFimCents: number;
  budgetSummary: BudgetMonthSummary | null;
  savingsOverview: SavingsMonthOverview | null;
}>;

const pluralMes = (n: number) => (n === 1 ? 'mês' : 'meses');

export class WishlistService {
  constructor(
    private db: DbDriver,
    private transactions: TransactionService,
    private balance?: BalanceService
  ) {
    this.balance = balance ?? new BalanceService(db);
  }

  // ------------------------------------------------------------ cadastro ----

  async addItem(input: {
    classificacao: WishlistClass;
    description: string;
    targetCents: number;
    link?: string | null;
  }): Promise<string> {
    if (!input.description.trim()) throw new Error('Informe a descrição do item');
    if (!input.targetCents || input.targetCents <= 0) throw new Error('Informe o valor do item');
    if (!input.classificacao || !WISHLIST_CLASSES.includes(input.classificacao))
      throw new Error('Escolha a classificação (Prioridade, Necessário ou Desejo)');
    const id = genId();
    await this.db.runAsync(
      `INSERT INTO wishlist_items (id, classificacao, description, target_cents, link, reserved_cents, status, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 'OPEN', ?)`,
      [id, input.classificacao, input.description.trim(), input.targetCents, input.link?.trim() || null, nowIso()]
    );
    return id;
  }

  /** "Alterar" — descrição, valor, link e classificação. */
  async updateItem(
    id: string,
    patch: { description?: string; targetCents?: number; link?: string | null; classificacao?: WishlistClass }
  ): Promise<void> {
    const item = await this.getById(id);
    if (!item) throw new Error('Item não encontrado');
    const target = patch.targetCents != null ? patch.targetCents : item.target_cents;
    if (target <= 0) throw new Error('O valor do item deve ser maior que zero');
    if (patch.targetCents != null && patch.targetCents < item.reserved_cents)
      throw new Error(`O valor não pode ficar abaixo do já reservado (${item.reserved_cents})`);
    await this.db.runAsync(
      `UPDATE wishlist_items SET
         description = ?, target_cents = ?, link = ?, classificacao = ?
       WHERE id = ?`,
      [
        patch.description?.trim() || item.description,
        target,
        patch.link === undefined ? item.link : patch.link?.trim() || null,
        patch.classificacao ?? item.classificacao,
        id,
      ]
    );
  }

  /** "Excluir" — o item sai da lista; as reservas já feitas permanecem como
   *  transferências no Fluxo (dinheiro real que já saiu do saldo). */
  async removeItem(id: string): Promise<void> {
    await this.db.transactionAsync(async () => {
      await this.db.runAsync('DELETE FROM wishlist_reserves WHERE item_id = ?', [id]);
      await this.db.runAsync('DELETE FROM wishlist_items WHERE id = ?', [id]);
    });
  }

  async getById(id: string): Promise<WishlistItemRow | null> {
    return this.db.getFirstAsync<WishlistItemRow>('SELECT * FROM wishlist_items WHERE id = ?', [id]);
  }

  // -------------------------------------------------------------- listas ----

  /** Itens abertos (OPEN) agrupados nas 3 classificações, com barra de progressão. */
  async listOpen(): Promise<WishlistClassView[]> {
    const rows = await this.db.getAllAsync<WishlistItemRow>(
      `SELECT * FROM wishlist_items WHERE status = 'OPEN'
        ORDER BY CASE classificacao WHEN 'PRIORIDADE' THEN 1 WHEN 'NECESSARIO' THEN 2 ELSE 3 END,
                 created_at ASC`
    );
    return WISHLIST_CLASSES.map((cls) => {
      const items = rows
        .filter((r) => r.classificacao === cls)
        .map((r) => toItemView(r));
      return {
        cls,
        label: CLASS_LABELS[cls],
        totalCents: items.reduce((a, b) => a + b.target_cents, 0),
        itemCount: items.length,
        items,
      };
    });
  }

  // ------------------------------------------------------------- reserva ----

  /**
   * Garante a CAIXINHA "Reserva · Programação de Compra" — conta real, mas com
   * include_in_general_balance = 0: NUNCA participa do saldo geral (por isso
   * o dinheiro reservado sai do Saldo e o Fluxo não o vê como disponível).
   */
  async ensureReservaBox(): Promise<string> {
    const existing = await this.db.getFirstAsync<{ id: string }>(
      `SELECT id FROM accounts WHERE name = ? AND archived_at IS NULL LIMIT 1`,
      [RESERVA_ACCOUNT_NAME]
    );
    if (existing) return existing.id;
    const id = genId();
    await this.db.runAsync(
      `INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance)
       VALUES (?, ?, 'CASH', 0, 0)`,
      [id, RESERVA_ACCOUNT_NAME]
    );
    return id;
  }

  /**
   * "Reservar" — transferência real origem → destino:
   *  · destino 'BOX'    → caixinha fora do saldo (nunca entra no saldo geral);
   *  · destino POUPANÇA → transferência para a conta escolhida com
   *    is_poupanca = 1 (fatia separada na fechinha da conta na tela inicial).
   * O item soma reservado; ao atingir 100% fica "Pronto para comprar".
   */
  async reserve(input: {
    itemId: string;
    amountCents: number;
    fromAccountId: string;
    destination: { kind: 'BOX' } | { kind: 'POUPANCA'; accountId: string };
  }): Promise<{ transactionId: string; destinationAccountId: string }> {
    const item = await this.getById(input.itemId);
    if (!item || item.status !== 'OPEN') throw new Error('Item não está mais na lista');
    if (!input.amountCents || input.amountCents <= 0) throw new Error('Informe o valor da reserva');
    const falta = item.target_cents - item.reserved_cents;
    if (input.amountCents > falta) throw new Error(`Só falta ${falta} para completar este item`);
    let toAccountId: string;
    let isPoupanca = 0;
    if (input.destination.kind === 'BOX') {
      toAccountId = await this.ensureReservaBox();
    } else {
      if (!input.destination.accountId) throw new Error('Escolha a conta poupança');
      if (input.destination.accountId === input.fromAccountId)
        throw new Error('A origem e o destino da reserva devem ser diferentes');
      toAccountId = input.destination.accountId;
      isPoupanca = 1;
    }
    // v87 (BUG MÉDIA): a reserva era 3 passos SEM transação — se o app morresse
    // entre a transferência e o INSERT, o dinheiro saía do saldo real e o item
    // não somava reserva (nem ficava registro da reserva). Agora os 3 passos
    // são atômicos.
    return this.db.transactionAsync(async () => {
      const tx = await this.transactions.createTransfer({
        fromAccountId: input.fromAccountId,
        toAccountId,
        amountCents: input.amountCents,
        description: `Reserva: ${item.description}`,
      });
      await this.db.runAsync(
        `INSERT INTO wishlist_reserves (id, item_id, from_account_id, to_account_id, amount_cents, is_poupanca, transaction_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [genId(), input.itemId, input.fromAccountId, toAccountId, input.amountCents, isPoupanca, tx.id, nowIso()]
      );
      await this.db.runAsync(
        'UPDATE wishlist_items SET reserved_cents = reserved_cents + ? WHERE id = ?',
        [input.amountCents, input.itemId]
      );
      return { transactionId: tx.id, destinationAccountId: toAccountId };
    });
  }

  // ------------------------------------------------------------ comprar ----

  /**
   * "Comprar" (item 100% reservado) — tira da lista e vira LANÇAMENTO NORMAL:
   * despesa em conta pelo valor integral do item. A origem padrão é a própria
   * caixinha de reserva (o dinheiro já estava lá guardado).
   */
  async buy(input: { itemId: string; accountId?: string; categoryId?: string | null }): Promise<string> {
    const item = await this.getById(input.itemId);
    if (!item || item.status !== 'OPEN') throw new Error('Item não está mais na lista');
    if (item.reserved_cents < item.target_cents)
      throw new Error('A barra ainda não chegou em 100% — reserve o valor que falta antes de comprar');
    let accountId = input.accountId;
    if (!accountId) {
      const box = await this.db.getFirstAsync<{ id: string }>(
        'SELECT id FROM accounts WHERE name = ? AND archived_at IS NULL LIMIT 1',
        [RESERVA_ACCOUNT_NAME]
      );
      accountId = box?.id;
    }
    if (!accountId) throw new Error('Informe a conta do lançamento da compra');
    const tx = await this.transactions.createAccountExpense({
      description: item.description,
      amountCents: item.target_cents,
      accountId,
      categoryId: input.categoryId ?? null,
    });
    await this.db.runAsync(
      `UPDATE wishlist_items SET status = 'BOUGHT', bought_transaction_id = ? WHERE id = ?`,
      [tx.id, item.id]
    );
    return tx.id;
  }

  // ------------------------------------------------- tela inicial (fechinha) --

  /**
   * Reservas por CONTA DE DESTINO — alimenta a fechinha da conta Poupança
   * ("Poupança normal" vs "Reserva Programação de Compra") e da caixinha, com as
   * barrinhas por item.
   */
  async reservesByAccount(): Promise<Record<string, { totalCents: number; items: Array<{ itemId: string; description: string; targetCents: number; reservedCents: number }> }>> {
    const rows = await this.db.getAllAsync<{
      to_account_id: string;
      item_id: string;
      description: string;
      target_cents: number;
      reserved: number;
    }>(
      `SELECT r.to_account_id, i.id AS item_id, i.description, i.target_cents,
              COALESCE(SUM(r.amount_cents), 0) AS reserved
         FROM wishlist_reserves r
         JOIN wishlist_items i ON i.id = r.item_id
        WHERE i.status = 'OPEN'
        GROUP BY r.to_account_id, i.id
        ORDER BY MIN(r.created_at)`
    );
    const out: Record<string, { totalCents: number; items: Array<{ itemId: string; description: string; targetCents: number; reservedCents: number }> }> = {};
    for (const r of rows) {
      if (r.reserved <= 0) continue;
      const bucket = (out[r.to_account_id] ??= { totalCents: 0, items: [] });
      bucket.totalCents += r.reserved;
      bucket.items.push({ itemId: r.item_id, description: r.description, targetCents: r.target_cents, reservedCents: r.reserved });
    }
    return out;
  }

  // ------------------------------------------------------- metodologia ----

  /**
   * Metodologia 5.2 do mês visto — alimenta a tela da Programação de Compra E o
   * card de Orçamento no Fluxo (visibilidade da hierarquia):
   *  · sobra do mês = saldo do dia previsto no último lançamento (nunca negativa);
   *  · Orçamento restante é abatido primeiro;
   *  · a sobra vai para a Programação de Compra na ordem
   *    Prioridade > Necessário > Desejo (classificação que não cabe passa
   *    para o mês seguinte; as de baixo nem começam);
   *  · Poupança Mensal é abatida depois das compras; o saldo positivo restante
   *    fica para a Poupança "Fechamento do Mês".
   */
  async getMethodology(
    month: string,
    opts?: {
      budgetSummary?: BudgetMonthSummary | null;
      savingsOverview?: SavingsMonthOverview | null;
      saldoPrevistoAjustadoFimCents?: number;
    }
  ): Promise<WishlistMethodology> {
    // (1) sobra do mês — saldo previsto no último lançamento do mês.
    let saldoFim = opts?.saldoPrevistoAjustadoFimCents;
    try {
      const lastActivityDate = await this.balance!.getLastActivityDate(month);
      const targetDate = lastActivityDate ?? `${month}-${String(lastDayNumberOf(month)).padStart(2, '0')}`;
      const dual = await this.balance!.getDailyBalancesDual(month);
      saldoFim ??= dual.previsto[targetDate] ?? 0;
    } catch {
      saldoFim ??= 0;
    }

    // (2) Orçamento é o primeiro abatimento; a Poupança Mensal vem depois das compras.
    const budgetSummary = opts?.budgetSummary === undefined ? null : opts.budgetSummary;
    const savingsOverview = opts?.savingsOverview === undefined ? null : opts.savingsOverview;
    const budgetedCents = budgetSummary ? budgetSummary.budgetedCents : null;
    const poupancaMensalCents = savingsOverview
      ? savingsOverview.entries.filter((e) => e.kind === 'MONTHLY').reduce((a, b) => a + b.amountCents, 0)
      : null;

    const sobra = availableForWishlistAtMonthEnd(
      saldoFim,
      budgetSummary?.remainingCents ?? 0
    );
    const capacity = sobra;

    // (3) fila de compra: Prioridade > Necessário > Desejo — cada classificação
    //     consome a capacidade mensal INTEIRA antes de a seguinte começar;
    //     a classificação que não cabe no mês passa para o mês seguinte
    //     (ex.: sobra 1.500, Prioridade 3.000 → 2 meses; Necessário e Desejo
    //     nem começam neste mês).
    const views = await this.listOpen();
    let fimAcumulado = 0;
    const classes = views.map((c) => {
      const totalCents = c.totalCents;
      const itemCount = c.itemCount;
      let startMonth = 0;
      let endMonth = 0;
      if (itemCount > 0 && capacity > 0) {
        const meses = Math.ceil(totalCents / capacity);
        startMonth = fimAcumulado + 1;
        endMonth = fimAcumulado + meses;
        fimAcumulado = endMonth;
      }
      return { cls: c.cls, label: c.label, totalCents, itemCount, startMonth, endMonth };
    });

    const prioridade = classes.find((c) => c.cls === 'PRIORIDADE');
    const mesesPrioridade = prioridade && prioridade.itemCount > 0 ? prioridade.endMonth || null : null;
    const classesComItem = classes.filter((c) => c.itemCount > 0);
    const mesesTotal = classesComItem.length > 0 ? classesComItem[classesComItem.length - 1].endMonth || null : null;

    const messagePrioridade =
      prioridade && prioridade.itemCount > 0
        ? restanteMesagem(capacity, prioridade)
        : null;
    const messageTotal =
      classesComItem.length > 0
        ? mesesTotal != null
          ? `Para comprar tudo, você demora ${mesesTotal} ${pluralMes(mesesTotal)}.`
          : 'Sem sobra prevista neste mês — nenhuma classificação começa a reservar.'
        : null;

    return {
      month,
      sobraCents: sobra,
      budgetedCents,
      poupancaMensalCents,
      capacityCents: capacity,
      classes,
      monthsPrioridade: mesesPrioridade,
      monthsTotal: mesesTotal,
      messagePrioridade,
      messageTotal,
    };
  }

  /** v90/v95 — Projeção MÊS A MÊS da Programação de Compra em cascata.
   *
   *  v90: SALDO PREVISTO REAL do fim de cada mês é consultado (por padrão via
   *       `BalanceService.getDailyBalancesDual(m)` — ou via `opts.fetcher`,
   *       que é o caminho do Fluxo/tela ou de testes);
   *  v95: SÓ A FALTA segue para o mês seguinte. O que SOBRA de dinheiro
   *       (capacidade não usada na cascata) NÃO carrega adiante — cada mês
   *       usa a PRÓPRIA disponibilidade (capacity = max(0, saldoPrevistoFim
   *       − orçamentoRestante)). A previsão, portanto, não se reflete
   *       automaticamente para os meses seguintes: o mês seguinte só recebe
   *       baixa se o valor planejado exceder a disponibilidade do mês atual
   *       e sobrar uma **parcela do plano** (regra do usuário);
   *  · na modalidade POUPANÇA "Fechamento do Mês" (após `closingSince`), o
   *    saldo positivo daquele mês fecha na poupança (a cascata, de qualquer
   *    forma, só continua até a FALTA zerar);
   *  · a reserva de valor (v87) é uma transferência real — o saldo previsto
   *    JÁ carrega sua saída do escopo, então a falta inicial é
   *    `target − reserved`.
   *
   *  A cascade é SEMPRE nesta ordem — Prioridade → Necessário → Desejo — e
   *  vale a cada mês. Como `listOpen()` é relido a cada chamada (dataVersion
   *  invalida o cache no Fluxo), se uma nova Prioridade for cadastrada
   *  durante a fase de Necessário/Desejo, a simulação REFEITA automaticamente
   *  volta a respeitar a ordem. Limite: 12 meses.
   *
   *  Compat: `opts.saldoPrevistoAjustadoFimCents` continua valendo como
   *  override do saldo do PRIMEIRO mês (startMonth) — a tela do Fluxo e os
   *  testes existentes contam com isso. `opts.fetcher` em conjunto permite
   *  também lookahead sem chamadas extras, e sobrepõe o cálculo padrão.
   */
  async getProjection(
    month: string,
    opts?: {
      budgetSummary?: BudgetMonthSummary | null;
      savingsOverview?: SavingsMonthOverview | null;
      saldoPrevistoAjustadoFimCents?: number;
      /** v90: recebe o mês simulado e devolve o saldo + resumos daquele mês;
       *  se faltar para algum mês, o fallback é o cálculo direto via services. */
      fetcher?: WishlistProjectionFetcher;
    }
  ): Promise<WishlistProjection> {
    const ordem: WishlistClass[] = ['PRIORIDADE', 'NECESSARIO', 'DESEJO'];
    const labelsMap: Record<string, string> = Object.fromEntries(
      ordem.map((c) => [c, CLASS_LABELS[c]])
    );

    // 1. falta inicial POR CLASSE (target − reserved).
    const views = await this.listOpen();
    const faltaInicial: Record<string, number> = {};
    let totalFaltaInicial = 0;
    for (const c of views) {
      faltaInicial[c.cls] = (faltaInicial[c.cls] ?? 0) + c.items.reduce((a, b) => a + b.faltaCents, 0);
      totalFaltaInicial += faltaInicial[c.cls] ?? 0;
    }

    // 2. janela de simulação: do mês corrente (startMonth) até o mês visto.
    const hoje = todaySP();
    const startMonth = monthOf(hoje);
    const targetMonth = monthOf(month);

    // 3. helper: saldo + resumos do mês m (com cache barato via fetcher).
    const fetchMonthData = async (m: string): Promise<{
      saldoPrevistoFimCents: number;
      budgetSummary: BudgetMonthSummary | null;
      savingsOverview: SavingsMonthOverview | null;
    }> => {
      let out: { saldoPrevistoFimCents: number; budgetSummary: BudgetMonthSummary | null; savingsOverview: SavingsMonthOverview | null };
      if (opts?.fetcher) {
        out = await opts.fetcher(m);
      } else {
        // fallback: cálculo direto via services disponíveis (o saldo do 1º
        // mês pode ser sobrescrito via `saldoPrevistoAjustadoFimCents`).
        let saldoPrevistoFimCents = 0;
        try {
          const dual = await this.balance!.getDailyBalancesDual(m);
          const last = await this.balance!.getLastActivityDate(m);
          const targetDate = last ?? `${m}-${String(lastDayNumberOf(m)).padStart(2, '0')}`;
          saldoPrevistoFimCents = dual.previsto[targetDate] ?? 0;
        } catch {
          saldoPrevistoFimCents = 0;
        }
        out = {
          saldoPrevistoFimCents,
          budgetSummary: m === startMonth ? opts?.budgetSummary ?? null : null,
          savingsOverview: m === startMonth ? opts?.savingsOverview ?? null : null,
        };
      }
      // v90 — PRIORIDADE do override da tela (Fluxo) sobre QUALQUER fonte
      // para o startMonth: garante compat com a v89 quando o usuário passa
      // explicitamente o saldo ajustado (com budAdj/savAdj) do mês corrente.
      if (m === startMonth && opts?.saldoPrevistoAjustadoFimCents != null) {
        out.saldoPrevistoFimCents = opts.saldoPrevistoAjustadoFimCents;
      }
      // garantias de tipo
      if (out.budgetSummary == null) out.budgetSummary = null;
      if (out.savingsOverview == null) out.savingsOverview = null;
      return out;
    };

    // 4. simulação (v95): para cada mês, capacity = max(0, saldoPrevistoFim
    //    − orçamentoRestante); aplica cascade Prioridade → Necessário →
    //    Desejo; o que SOBRA de dinheiro do mês NÃO carrega para o próximo
    //    (a previsão não se reflete automaticamente). Só a FALTA segue
    //    adiante, dentro de `acc` — quando o valor planejado excede a
    //    disponibilidade atual, a parcela que sobrou entra no mês seguinte
    //    na mesma ordem (P → N → D).
    const ordemTyped = ordem;
    type ResultMonth = WishlistProjectionMonth;
    const results: ResultMonth[] = [];
    let acc: Record<string, number> = { ...faltaInicial };
    let mesesAteDone: number | null = null;
    let capacityRef = 0; // capacidade do 1º mês (= valor exibido em capacityCents)
    let simMonth = startMonth;
    const MAX_ITER = 12;

    for (let i = 0; i < MAX_ITER; i++) {
      const data = await fetchMonthData(simMonth);
      const budgetRemaining = data.budgetSummary?.remainingCents ?? 0;
      const capacityMonth = Math.max(0, data.saldoPrevistoFimCents - Math.max(0, budgetRemaining));
      if (i === 0) capacityRef = capacityMonth;
      let capacityFinal = capacityMonth;
      if (capacityFinal < 0) capacityFinal = 0;
      const abatePorClasse: Record<string, number> = {};
      for (const cls of ordemTyped) {
        if (capacityFinal <= 0) break;
        const falta = Math.max(0, acc[cls] ?? 0);
        if (falta === 0) continue;
        const abate = Math.min(falta, capacityFinal);
        if (abate > 0) {
          abatePorClasse[cls] = abate;
          capacityFinal -= abate;
        }
      }
      const classesOut: ResultMonth['classes'] = ordemTyped.map((cls) => {
        const ini = Math.max(0, acc[cls] ?? 0);
        const abate = abatePorClasse[cls] ?? 0;
        const fim = Math.max(0, ini - abate);
        acc[cls] = fim;
        return { cls, label: labelsMap[cls], faltaInicioCents: ini, abatidoCents: abate, faltaFimCents: fim };
      });
      const usei = capacityMonth - capacityFinal;
      results.push({ month: simMonth, contributionCents: usei, classes: classesOut });

      if (
        totalFaltaInicial > 0 &&
        mesesAteDone == null &&
        classesOut.every((c) => c.faltaFimCents === 0)
      ) {
        mesesAteDone = i + 1;
      }

      // parar: chegou ao "done" e o mês visto já foi passado.
      simMonth = monthAdd(simMonth, 1);
      if (mesesAteDone != null && simMonth > targetMonth) break;
    }

    // truncar a exibição para não passar do mês visto (UX: o usuário olhou um
    // mês; a projeção não precisa estourar além dele a não ser que o "done"
    // ainda não tenha acontecido — nesses casos paramos ao fim da janela de
    // 12 meses mesmo assim).
    let displayed = results;
    if (results.length > 0) {
      const lastDisplayed = results[results.length - 1].month;
      if (lastDisplayed > targetMonth) {
        const idx = results.findIndex((r) => r.month === targetMonth);
        if (idx >= 0) displayed = results.slice(0, idx + 1);
      }
    }

    const done = mesesAteDone !== null;
    return {
      referenceMonth: month,
      capacityCents: capacityRef,
      months: displayed,
      monthsUntilDone: done ? mesesAteDone : null,
      done,
    };
  }
}

/** Frase pedida pelo usuário para UMA classificação. */
function restanteMesagem(capacity: number, c: { cls: WishlistClass; totalCents: number; itemCount: number; endMonth: number }): string | null {
  if (c.itemCount === 0) return null;
  if (capacity <= 0) return 'Sem sobra prevista neste mês — nada começa a reservar.';
  const meses = Math.ceil(c.totalCents / capacity);
  return `Para comprar tudo de ${CLASS_LABELS[c.cls]}, você demora ${meses} ${pluralMes(meses)}.`;
}

function toItemView(r: WishlistItemRow): WishlistItemView {
  const pct = r.target_cents > 0 ? Math.round((r.reserved_cents / r.target_cents) * 100) : 0;
  return {
    ...r,
    pct,
    faltaCents: Math.max(0, r.target_cents - r.reserved_cents),
    pronto: r.reserved_cents >= r.target_cents,
  };
}

/** Último dia do mês ('YYYY-MM' → número do dia) — helpers locais simples. */
function lastDayNumberOf(month: string): number {
  const [ys, ms] = month.split('-').map((x) => parseInt(x, 10));
  return new Date(Date.UTC(ys, ms, 0)).getUTCDate();
}
