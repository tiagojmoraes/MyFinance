/**
 * WishlistService (v17) — PROGRAMAÇÃO DE COMPRA (fonte única: month_ledger_wishlist).
 *
 * METODOLOGIA DO USUÁRIO (hierarquia — tudo concorre):
 *  1) ORÇAMENTO — limite restante após gastos/compromissos, abatido primeiro.
 *  2) PROGRAMAÇÃO DE COMPRA — a sobra vai para os itens na ordem
 *     PRIORIDADE > NECESSÁRIO > DESEJO. Se o montante de uma classificação
 *     não cabe, passa para o mês seguinte (e as de baixo nem começam).
 *  3) POUPANÇA MENSAL — transferência programada, abatida após as compras.
 *  4) POUPANÇA "FECHAMENTO DO MÊS" — recebe a sobra positiva final.
 *
 * v17 — `getMethodology` e `getProjection` LÊEM a cascade já persistida
 * pelo `MonthLedgerService` em `month_ledger_wishlist` (e a linha do mês em
 * `month_ledger`). A cascata é SEMPRE executada uma única vez por mês,
 * dentro do livro-razão — o WishlistService virou um leitor agregado,
 * não recomputa nada em memória.
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
import { VersionedCache } from '../lib/versionedCache';

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
 * v17 — `WishlistProjectionFetcher` ficou sem uso prático (a cascade
 * roda toda dentro do `MonthLedgerService`). Continua exportada apenas
 * para compat de tipos em testes legados; o `getProjection` novo não a
 * consome.
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
  // v98 — DESEMPENHO DO FLUXO: memo de `listOpen` por `dataVersion`. Quando a
  // tela do Fluxo chama metodologia e projeção no mesmo carregamento, a 2ª
  // chamada usa a MESMA lista em vez de reler tudo.
  private listOpenCache = new VersionedCache<WishlistClassView[]>();

  /**
   * v17 — livro-razão mensal: o `WishlistService` lê o cascade já
   * persistido pelo `MonthLedgerService` em vez de recomputar a cascata em
   * memória. A referência é preenchida por setter (`setMonthLedger`) em
   * `services/index.ts` (ciclo: monthLedger também usa este serviço).
   * NUNCA null em runtime — só omitir nos testes legados.
   */
  private monthLedger: import('./MonthLedgerService').MonthLedgerService | null = null;

  constructor(
    private db: DbDriver,
    private transactions: TransactionService,
    private balance?: BalanceService
  ) {
    this.balance = balance ?? new BalanceService(db);
  }

  /** v17 — late-binding (evita ciclo de construção). */
  setMonthLedger(ml: import('./MonthLedgerService').MonthLedgerService): void {
    this.monthLedger = ml;
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
    this.invalidateListOpen();
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
    this.invalidateListOpen();
  }

  /** "Excluir" — o item sai da lista; as reservas já feitas permanecem como
   *  transferências no Fluxo (dinheiro real que já saiu do saldo). */
  async removeItem(id: string): Promise<void> {
    await this.db.transactionAsync(async () => {
      await this.db.runAsync('DELETE FROM wishlist_reserves WHERE item_id = ?', [id]);
      await this.db.runAsync('DELETE FROM wishlist_items WHERE id = ?', [id]);
    });
    this.invalidateListOpen();
  }

  async getById(id: string): Promise<WishlistItemRow | null> {
    return this.db.getFirstAsync<WishlistItemRow>('SELECT * FROM wishlist_items WHERE id = ?', [id]);
  }

  // -------------------------------------------------------------- listas ----

  /** Itens abertos (OPEN) agrupados nas 3 classificações, com barra de progressão. */
  async listOpen(dataVersion?: number): Promise<WishlistClassView[]> {
    return this.listOpenCache.get('listOpen|all', dataVersion, async () => {
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
    });
  }

  /** v98: esquece o cache de `listOpen` (chamada após cadastro/alteração). */
  invalidateListOpen(): void {
    this.listOpenCache.invalidate('listOpen|all');
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
   * v17 — Metodologia do mês visto. FONTE ÚNICA: lê o cascade JÁ
   * PERSISTIDO em `month_ledger_wishlist` via `MonthLedgerService`. Não
   * recomputa nada em memória: a ordem (P → N → D), o rateio proporcional
   * e a propagação de carry são responsabilidade exclusiva do livro-razão.
   *
   * Para o BACKWARD COMPAT (testes legados), `opts` é aceito mas TODAS as
   * opções legadas viraram no-ops: o saldo "antes da hierarquia" vem
   * direto do livro (persistido em `balance_before_prev_cents`).
   */
  async getMethodology(
    month: string,
    _opts?: {
      budgetSummary?: BudgetMonthSummary | null;
      savingsOverview?: SavingsMonthOverview | null;
      // v17 — REMOVIDO: o override `saldoPrevistoAjustadoFimCents`. A fonte
      // é agora o livro-razão (balanceBeforePrevCents persistido no chain).
      dataVersion?: number;
    }
  ): Promise<WishlistMethodology> {
    const ml = this.monthLedger;
    if (!ml) {
      // Sem livro-razão ligado (testes legados): comportamento mínimo.
      return {
        month,
        sobraCents: 0,
        budgetedCents: null,
        poupancaMensalCents: null,
        capacityCents: 0,
        classes: WISHLIST_CLASSES.map((cls) => ({
          cls,
          label: CLASS_LABELS[cls],
          totalCents: 0,
          itemCount: 0,
          startMonth: 0,
          endMonth: 0,
        })),
        monthsPrioridade: null,
        monthsTotal: null,
        messagePrioridade: null,
        messageTotal: 'Livro-razão indisponível — abra o Fluxo para carregar o cálculo.',
      };
    }

    const ledgerRow = await ml.getMonthLedgerSummary(month);
    const entries = await ml.getMonthWishlistEntries(month);
    // views vem do listOpen (mantém o cache e os percentuais por item).
    const views = await this.listOpen();

    const balancePrev = ledgerRow?.balanceBeforePrevCents ?? 0;
    const budgetRemainingRaw = ledgerRow?.budgetRemainingCents ?? 0;
    const budgetRemaining = Math.max(0, budgetRemainingRaw);
    // Capacidade = max(0, balancePrev − orçamento restante). Mesma fórmula
    // usada pelo `computeMonth` do MonthLedgerService.
    const capacity = Math.max(0, balancePrev - budgetRemaining);

    // (1) budgeted / poupanca mensal a partir do ledger + resumo das telas.
    const budgetedCents = ledgerRow != null && budgetRemaining >= 0
      ? balancePrev + budgetRemaining // reconstrução simples: orçado = balancePrev + budgetRemaining (orçado − gasto)
      : null;
    // As entries individualmente não dizem o TOTAL — para o cabeçalho do
    // card, basta o valor persistido `savings_monthly_cents` do row.
    const poupancaMensalCents = ledgerRow?.savingsMonthlyCents ?? null;

    // (2) totais por classe a partir do listOpen (sempre completo, deriva
    // do `target_cents` agregado da classe).
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

    // (3) entries agrupadas por classe para mostrar o "cabe deste mês" se
    // o card precisar no futuro (hoje o card consulta projectionMonthPlan).
    void entries; // consumido pelo getProjection; aqui só exibimos totais

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
      sobraCents: capacity,
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

  /** v17 — Projeção MÊS A MÊS da Programação de Compra em cascata.
   *
   * FONTE ÚNICA: o cascade JÁ EXECUTADO para cada mês está em
   * `month_ledger_wishlist`. Aqui lemos as entries por mês (a partir do
   * mês corrente) e devolvemos a estrutura `WishlistProjection` que a UI
   * usa.
   *
   * Removido em v17:
   *  · `saldoPrevistoAjustadoFimCents` (override) — o livro-razão tem a
   *    verdade;
   *  · o `fetcher` (caminho síncrono paralelo) — o `MonthLedgerService`
   *    já calculou via `computeMonth`;
   *  · o `startMonth` da projeção era "hoje"; agora o ponto de partida é
   *    simplesmente o mês corrente (lido de todaySP() no início).
   */
  async getProjection(
    month: string,
    _opts?: {
      budgetSummary?: BudgetMonthSummary | null;
      savingsOverview?: SavingsMonthOverview | null;
      dataVersion?: number;
    }
  ): Promise<WishlistProjection> {
    const ml = this.monthLedger;
    if (!ml) {
      return {
        referenceMonth: month,
        capacityCents: 0,
        months: [],
        monthsUntilDone: null,
        done: false,
      };
    }

    const targetMonth = monthOf(month);
    const startMonth = monthOf(todaySP());

    // Lê o ledger de cada mês — current → target. A cascata VEM persistida.
    const months: WishlistProjectionMonth[] = [];
    let capacityCents = 0;
    let monthsUntilDone: number | null = null;

    let sim = startMonth;
    for (let i = 0; i < 12; i++) {
      const entries = await ml.getMonthWishlistEntries(sim);
      const row = await ml.getMonthLedgerSummary(sim);
      const balancePrev = row?.balanceBeforePrevCents ?? 0;
      const budgetRem = Math.max(0, row?.budgetRemainingCents ?? 0);
      const capacityMonth = Math.max(0, balancePrev - budgetRem);

      if (i === 0) capacityCents = capacityMonth;

      // Agrega as entries por classe — Prioridade → Necessário → Desejo.
      const klass: Record<WishlistClass, { ini: number; abatido: number; fim: number }> = {
        PRIORIDADE: { ini: 0, abatido: 0, fim: 0 },
        NECESSARIO: { ini: 0, abatido: 0, fim: 0 },
        DESEJO: { ini: 0, abatido: 0, fim: 0 },
      };
      if (entries) {
        for (const e of entries) {
          const k = klass[e.classificacao];
          k.ini += e.shortageStartCents;
          k.abatido += e.coveredCents;
          k.fim += e.shortageEndCents;
        }
      }
      const classesOut: WishlistProjectionMonth['classes'] =
        (['PRIORIDADE', 'NECESSARIO', 'DESEJO'] as WishlistClass[]).map((cls) => ({
          cls,
          label: CLASS_LABELS[cls],
          faltaInicioCents: klass[cls].ini,
          abatidoCents: klass[cls].abatido,
          faltaFimCents: klass[cls].fim,
        }));
      const contributionCents = classesOut.reduce((a, c) => a + c.abatidoCents, 0);
      months.push({ month: sim, contributionCents, classes: classesOut });

      // done quando TUDO zerou
      const totalIni = classesOut.reduce((a, c) => a + c.faltaInicioCents, 0);
      const totalFim = classesOut.reduce((a, c) => a + c.faltaFimCents, 0);
      if (monthsUntilDone == null && totalIni > 0 && totalFim === 0) {
        monthsUntilDone = i + 1;
      }

      // avançou além do target → para.
      if (sim >= targetMonth) break;
      sim = monthAdd(sim, 1);
    }

    // truncar até o mês visto (UX — não vaza além do mês selecionado).
    const lastIdx = months.findIndex((m) => m.month === targetMonth);
    const displayed = lastIdx >= 0 ? months.slice(0, lastIdx + 1) : months;

    return {
      referenceMonth: month,
      capacityCents,
      months: displayed,
      monthsUntilDone,
      done: monthsUntilDone !== null,
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
