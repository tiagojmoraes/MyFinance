/**
 * WishlistService (v69) — LISTA DE DESEJOS.
 *
 * METODOLOGIA DO USUÁRIO (hierarquia — tudo concorre):
 *  1) ORÇAMENTO — previsão de gastos (alimento, moradia, lazer…). Obrigação,
 *     entra PRIMEIRO. Poupança MENSAL entra junto, como se fosse uma conta.
 *  2) LISTA DE DESEJOS — a sobra do mês vai para os itens na ordem
 *     PRIORIDADE > NECESSÁRIO > DESEJO. Se o montante de uma classificação
 *     não cabe, passa para o mês seguinte (e as de baixo nem começam).
 *  3) POUPANÇA "FECHAMENTO DO MÊS" — último nível: só sobra dinheiro para ela
 *     depois de tudo acima.
 *
 * RESERVA ("Reservar"): transfere dinheiro REAL de uma conta do saldo para a
 * caixinha "Reserva · Lista de Desejos" — conta criada automaticamente e
 * marcada para NUNCA entrar no saldo geral (include_in_general_balance = 0),
 * ou para a conta POUPANÇA escolhida com is_poupanca = 1 (na tela inicial a
 * conta Poupança ganha a fechinha que separa "Poupança normal" / "Reserva
 * Lista de Desejos"). Enquanto está na caixinha, o Fluxo não conta esse
 * dinheiro como disponível.
 *
 * BARRA DE PROGRESSÃO: reservado / valor do item. 100% = "Pronto para
 * comprar". Ao COMPRAR, o item sai da lista e vira lançamento normal
 * (despesa em conta — dinheiro sai da caixinha de reserva).
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { nowIso } from '../lib/dates';
import { TransactionService } from './TransactionService';
import { BalanceService } from './BalanceService';
import { BudgetService, type BudgetMonthSummary } from './BudgetService';
import { SavingsService, type SavingsMonthOverview } from './SavingsService';

export type WishlistClass = 'PRIORIDADE' | 'NECESSARIO' | 'DESEJO';

export const WISHLIST_CLASSES: WishlistClass[] = ['PRIORIDADE', 'NECESSARIO', 'DESEJO'];

export const CLASS_LABELS: Record<WishlistClass, string> = {
  PRIORIDADE: 'Prioridade',
  NECESSARIO: 'Necessário',
  DESEJO: 'Desejo',
};

/** Nome fixo da caixinha FORA do saldo (conta interna do próprio serviço). */
export const RESERVA_ACCOUNT_NAME = 'Reserva · Lista de Desejos';

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
  /** Sobra do mês (saldo do dia previsto do fim do mês, nunca negativa). */
  sobraCents: number;
  /** Total orçado no mês (null = módulo Orçamento desligado). */
  budgetedCents: number | null;
  /** Programado da Poupança MENSAL (null = módulo Poupança desligado). */
  poupancaMensalCents: number | null;
  /** Capacidade do mês para a Lista de Desejos (sobra). */
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
   * Garante a CAIXINHA "Reserva · Lista de Desejos" — conta real, mas com
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
   * ("Poupança normal" vs "Reserva Lista de Desejos") e da caixinha, com as
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
   * Metodologia 5.2 do mês visto — alimenta a tela da Lista de Desejos E o
   * card de Orçamento no Fluxo (visibilidade da hierarquia):
   *  · sobra do mês = saldo do dia previsto do FIM do mês (nunca negativa);
   *  · Orçamento + Poupança Mensal: obrigatórios, entram primeiro;
   *  · a sobra vai para a Lista de Desejos na ordem
   *    Prioridade > Necessário > Desejo (classificação que não cabe passa
   *    para o mês seguinte; as de baixo nem começam);
   *  · o que sobrar depois de tudo é da Poupança "Fechamento do Mês".
   */
  async getMethodology(
    month: string,
    opts?: { budgetSummary?: BudgetMonthSummary | null; savingsOverview?: SavingsMonthOverview | null }
  ): Promise<WishlistMethodology> {
    // (1) sobra do mês — saldo previsto do último dia (o que sobraria no fim)
    const endDate = `${month}-${String(lastDayNumberOf(month)).padStart(2, '0')}`;
    let sobra = 0;
    try {
      const dual = await this.balance!.getDailyBalancesDual(month);
      sobra = Math.max(0, dual.previsto[endDate] ?? 0);
    } catch {
      sobra = 0;
    }

    // (2) obrigatórios primeiro: Orçamento + Poupança Mensal (informativos)
    const budgetSummary = opts?.budgetSummary === undefined ? null : opts.budgetSummary;
    const savingsOverview = opts?.savingsOverview === undefined ? null : opts.savingsOverview;
    const budgetedCents = budgetSummary ? budgetSummary.budgetedCents : null;
    const poupancaMensalCents = savingsOverview
      ? savingsOverview.entries.filter((e) => e.kind === 'MONTHLY').reduce((a, b) => a + b.amountCents, 0)
      : null;

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
