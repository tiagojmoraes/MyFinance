/**
 * BudgetService (v42) — ORÇAMENTOS MENSAIS por categoria (item ▸ subitem).
 *
 * Regras confirmadas pelo usuário:
 *  · o orçamento aponta para UMA categoria (item ou subitem) com um VALOR MENSAL
 *    único que se repete todo mês até ser desativado (sem calendário mês a mês);
 *  · "GASTOU" no mês = TUDO daquela categoria:
 *      - despesas SIMPLES do mês (à vista em conta, compras no cartão,
 *        ocorrências de contas fixas, linhas de grupos consolidados) pela
 *        DATA DO LANÇAMENTO (occurred_on) — CONFIRMED e PREVISÃO (PENDING);
 *      - PARCELAS (em conta e no cartão) pelo VENCIMENTO do mês — a categoria
 *        vem do plano (transação-âncora, que fica FORA da soma para não
 *        contar em dobro);
 *  · o card no Fluxo mostra, por orçamento: ORÇADO • PREVISTO • GASTO (v68 —
 *    orçado = limite; previsto = lançamentos ainda não efetivados; gasto = já
 *    efetivados) e a barrinha de conclusão; o total que falta fica no cabeçalho;
 *  · v68: o "previsto" e o "efetivado" do orçamento ENTRAM no "Saldo do dia"
 *    do Fluxo (getMonthFluxAdjust — lança a reserva antes da fatura vencer e
 *    traz compromissos de contas fora do escopo).
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { nowIso, lastDayNumberOf } from '../lib/dates';

export interface BudgetRow {
  id: string;
  category_id: string;
  amount_cents: number;
  is_active: number;
  created_at: string;
  category_name: string;
  parent_name: string | null;
}

export interface BudgetSummaryItem {
  budgetId: string;
  categoryId: string;
  label: string;
  amountCents: number;
  spentCents: number;
  remainingCents: number;
  /** 0-100+ (pode passar de 100 quando estoura). */
  pct: number;
  active: boolean;
  /** v68 "Orçado • Previsto • Gasto": soma dos lançamentos PENDENTES
   *  (previsão) da categoria no mês — ainda NÃO efetivados. */
  previstoCents: number;
  /** v68 "Orçado • Previsto • Gasto": soma dos lançamentos JÁ EFETIVADOS
   *  (CONFIRMED) da categoria no mês. spentCents continua sendo o total
   *  comprometido (previsto + efetivado) — compatibilidade com a tela Orçamento. */
  efetivadoCents: number;
  /** v67 (BUG 4): item PAI cujo total vem da SOMA dos orçamentos dos subitens
   *  (pai R$ 100 = 60 + 40) — o valor próprio do pai não soma por cima. */
  composedFromSubs?: boolean;
  /** v67 (BUG 4): subitem que compõe o item pai — aparece com a barrinha dele,
   *  mas fica FORA dos totais para não contar em dobro. */
  partOfParent?: boolean;
  /** v67 (BUG 4): id do orçamento do item pai (quando partOfParent). */
  parentBudgetId?: string | null;
}

export interface BudgetMonthSummary {
  items: BudgetSummaryItem[];
  budgetedCents: number;
  spentCents: number;
  /** v68: totais da nova leitura "Orçado • Previsto • Gasto". */
  previstoCents: number;
  efetivadoCents: number;
  /** Total que falta (pode ser negativo se estourou). */
  remainingCents: number;
}

export class BudgetService {
  constructor(private db: DbDriver) {}

  /** Lista de orçamentos (ativos primeiro, depois por nome da categoria). */
  async list(): Promise<BudgetRow[]> {
    return this.db.getAllAsync<BudgetRow>(
      `SELECT b.id, b.category_id, b.amount_cents, b.is_active, b.created_at,
              c.name AS category_name, p.name AS parent_name
         FROM budgets b
         JOIN categories c ON c.id = b.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
        ORDER BY b.is_active DESC, COALESCE(p.name, c.name), c.name`
    );
  }

  /** Cria ou atualiza o orçamento da categoria (um orçamento por categoria). */
  async save(categoryId: string, amountCents: number): Promise<string> {
    if (amountCents <= 0) throw new Error('O valor do orçamento deve ser maior que zero');
    const cat = await this.db.getFirstAsync<{ id: string }>(
      'SELECT id FROM categories WHERE id = ?',
      [categoryId]
    );
    if (!cat) throw new Error('Categoria não encontrada');
    return this.db.transactionAsync(async () => {
      const existing = await this.db.getFirstAsync<{ id: string }>(
        'SELECT id FROM budgets WHERE category_id = ?',
        [categoryId]
      );
      if (existing) {
        await this.db.runAsync(
          'UPDATE budgets SET amount_cents = ?, is_active = 1 WHERE id = ?',
          [amountCents, existing.id]
        );
        return existing.id;
      }
      const id = genId();
      await this.db.runAsync(
        `INSERT INTO budgets (id, category_id, amount_cents, is_active, created_at)
         VALUES (?, ?, ?, 1, ?)`,
        [id, categoryId, amountCents, nowIso()]
      );
      return id;
    });
  }

  async setActive(budgetId: string, active: boolean): Promise<void> {
    await this.db.runAsync('UPDATE budgets SET is_active = ? WHERE id = ?', [active ? 1 : 0, budgetId]);
  }

  async remove(budgetId: string): Promise<void> {
    await this.db.runAsync('DELETE FROM budgets WHERE id = ?', [budgetId]);
  }

  /**
   * v67 (BUG 4) — EXCLUIR orçamento do item com o DESTINO DOS SUBITENS:
   *  · 'ONLY_THIS'     — exclui SÓ o orçamento do item; os orçamentos dos
   *                      subitens seguem como independentes (promovidos);
   *  · 'WITH_SUBITEMS' — exclui o do item E os de TODAS as subcategorias dele.
   * Lançamentos nunca são afetados (orçamento é meta, não lançamento).
   * Retorna quantos orçamentos foram excluídos.
   */
  async removeWithStrategy(budgetId: string, strategy: 'ONLY_THIS' | 'WITH_SUBITEMS'): Promise<number> {
    const budget = await this.db.getFirstAsync<{ category_id: string }>(
      'SELECT category_id FROM budgets WHERE id = ?',
      [budgetId]
    );
    if (!budget) throw new Error('Orçamento não encontrado');
    let affected = 0;
    await this.db.transactionAsync(async () => {
      if (strategy === 'WITH_SUBITEMS') {
        const subs = await this.db.getAllAsync<{ id: string }>(
          'SELECT id FROM categories WHERE parent_id = ?',
          [budget.category_id]
        );
        for (const s of subs) {
          const r = await this.db.runAsync('DELETE FROM budgets WHERE category_id = ?', [s.id]);
          affected += r?.changes ?? 0;
        }
      }
      const r0 = await this.db.runAsync('DELETE FROM budgets WHERE id = ?', [budgetId]);
      affected += r0?.changes ?? 0;
    });
    return affected;
  }

  /**
   * Resumo do MÊS: por orçamento ativo — orçado, gasto e falta; e o TOTAL
   * (cabeçalho do card no Fluxo). Ver regras no cabeçalho da classe.
   * v67 (BUG 4) — COMPOSIÇÃO item ▸ subitem: quando o item tem orçamentos
   * ativos em SUBCATEGORIAS, o valor dele passa a ser a SOMA dos subitens
   * (pai R$ 100 = 60 + 40) — o valor próprio do pai não soma por cima; o
   * gasto do pai = gasto próprio + gasto dos subitens; os subitens aparecem
   * com a barrinha deles mas ficam FORA dos totais (sem dupla contagem).
   */
  async getMonthSummary(month: string): Promise<BudgetMonthSummary> {
    const budgets = (await this.list()).filter((b) => b.is_active === 1);
    if (budgets.length === 0) {
      return { items: [], budgetedCents: 0, spentCents: 0, previstoCents: 0, efetivadoCents: 0, remainingCents: 0 };
    }
    const ids = budgets.map((b) => b.category_id);
    const marks = ids.map(() => '?').join(',');

    // (1) Despesas SIMPLES do mês (à vista, cartão à vista, fixas, linhas de grupo):
    //     pela data do lançamento. v68: PENDING e CONFIRMED somados SEPARADOS —
    //     "Previsto" (ainda não efetivado) e "Gasto" (já efetivado).
    //     Fora: cabeçalhos CONSOLIDATED (contam pelos filhos) e
    //     âncoras de parcelamento (contam pelas parcelas).
    const simpleRows = await this.db.getAllAsync<{ cid: string; pending: number; confirmed: number }>(
      `SELECT t.category_id AS cid,
              COALESCE(SUM(CASE WHEN t.status = 'PENDING' THEN t.amount_cents ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN t.status != 'PENDING' THEN t.amount_cents ELSE 0 END), 0) AS confirmed
         FROM transactions t
        WHERE t.type = 'EXPENSE' AND t.kind = 'SIMPLE'
          AND t.status != 'VOIDED'
          AND t.source_system != 'INSTALLMENT'
          AND t.category_id IS NOT NULL
          AND t.id NOT IN (
            SELECT original_transaction_id FROM installment_plans
             WHERE original_transaction_id IS NOT NULL
          )
          AND substr(t.occurred_on, 1, 7) = ?
          AND t.category_id IN (${marks})
        GROUP BY t.category_id`,
      [month, ...ids] as never
    );

    // (2) Parcelas do mês (em conta e no cartão) pelo vencimento — categoria do plano.
    const instRows = await this.db.getAllAsync<{ cid: string; pending: number; confirmed: number }>(
      `SELECT t.category_id AS cid,
              COALESCE(SUM(CASE WHEN i.status = 'PENDING' THEN i.amount_cents ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN i.status != 'PENDING' THEN i.amount_cents ELSE 0 END), 0) AS confirmed
         FROM installments i
         JOIN installment_plans p ON p.id = i.plan_id
         JOIN transactions t ON t.id = p.original_transaction_id
        WHERE i.status != 'CANCELED'
          AND t.category_id IS NOT NULL
          AND substr(i.due_date, 1, 7) = ?
          AND t.category_id IN (${marks})
        GROUP BY t.category_id`,
      [month, ...ids] as never
    );

    const spentByCat = new Map<string, number>();
    const prevByCat = new Map<string, number>();
    const efetByCat = new Map<string, number>();
    for (const r of simpleRows) {
      spentByCat.set(r.cid, (spentByCat.get(r.cid) ?? 0) + r.pending + r.confirmed);
      prevByCat.set(r.cid, (prevByCat.get(r.cid) ?? 0) + r.pending);
      efetByCat.set(r.cid, (efetByCat.get(r.cid) ?? 0) + r.confirmed);
    }
    for (const r of instRows) {
      spentByCat.set(r.cid, (spentByCat.get(r.cid) ?? 0) + r.pending + r.confirmed);
      prevByCat.set(r.cid, (prevByCat.get(r.cid) ?? 0) + r.pending);
      efetByCat.set(r.cid, (efetByCat.get(r.cid) ?? 0) + r.confirmed);
    }

    // v67 (BUG 4): mapa categoria-pai → orçamentos ativos dos SUBITENS
    const catRows = await this.db.getAllAsync<{ id: string; parent_id: string | null }>(
      'SELECT id, parent_id FROM categories'
    );
    const parentOf = new Map(catRows.map((c) => [c.id, c.parent_id]));
    const subBudgetsByParent = new Map<string, typeof budgets>();
    for (const b of budgets) {
      const pid = parentOf.get(b.category_id);
      if (pid) {
        const arr = subBudgetsByParent.get(pid) ?? [];
        arr.push(b);
        subBudgetsByParent.set(pid, arr);
      }
    }
    const budgetByCat = new Map(budgets.map((b) => [b.category_id, b]));

    let budgeted = 0;
    let spent = 0;
    let previsto = 0;
    let efetivado = 0;
    const items: BudgetSummaryItem[] = budgets.map((b) => {
      const ownSpent = spentByCat.get(b.category_id) ?? 0;
      // v67 (BUG 4): subitem com orçamento no PAI também orçado → parte do pai
      const pid = parentOf.get(b.category_id);
      const parentBudget = pid ? budgetByCat.get(pid) : undefined;
      const partOfParent = !!(parentBudget && (subBudgetsByParent.get(pid!)?.length ?? 0) > 0);
      const parentId = partOfParent ? parentBudget!.id : null;
      const subs = subBudgetsByParent.get(b.category_id) ?? [];
      const composed = subs.length > 0;
      const subSpent = subs.reduce((a, s) => a + (spentByCat.get(s.category_id) ?? 0), 0);
      const subPrev = subs.reduce((a, s) => a + (prevByCat.get(s.category_id) ?? 0), 0);
      const subEfet = subs.reduce((a, s) => a + (efetByCat.get(s.category_id) ?? 0), 0);
      // PAI COMPOSTO: valor = soma dos subitens (pai R$ 100 = 60 + 40)
      const amountCents = composed ? subs.reduce((a, s) => a + s.amount_cents, 0) : b.amount_cents;
      // Gasto do pai = próprio + gasto dos subitens (os lançamentos moram nas categorias)
      const spentCents = composed ? ownSpent + subSpent : ownSpent;
      const previstoCents = composed ? subPrev : (prevByCat.get(b.category_id) ?? 0);
      const efetivadoCents = composed ? subEfet : (efetByCat.get(b.category_id) ?? 0);
      if (!partOfParent) {
        budgeted += amountCents;
        spent += spentCents;
        previsto += previstoCents;
        efetivado += efetivadoCents;
      }
      return {
        budgetId: b.id,
        categoryId: b.category_id,
        label: b.parent_name ? `${b.parent_name} ▸ ${b.category_name}` : b.category_name,
        amountCents,
        spentCents,
        remainingCents: amountCents - spentCents,
        pct: amountCents > 0 ? Math.round((spentCents / amountCents) * 100) : 0,
        active: true,
        previstoCents,
        efetivadoCents,
        composedFromSubs: composed || undefined,
        partOfParent: partOfParent || undefined,
        parentBudgetId: parentId,
      };
    });
    return {
      items,
      budgetedCents: budgeted,
      spentCents: spent,
      previstoCents: previsto,
      efetivadoCents: efetivado,
      remainingCents: budgeted - spent,
    };
  }

  /**
   * v68 — AJUSTE DIÁRIO do "Saldo do dia" pelo ORÇAMENTO (regra do usuário:
   * "Saldo do dia Previsto = do jeito que está + previsto no Orçamento").
   *
   * O saldo base (BalanceService) já inclui TODOS os lançamentos PENDENTES e
   * CONFIRMADOS das contas do escopo — o que ele NÃO sente ainda é:
   *  · lançamento de categoria com orçamento ATIVO no CARTÃO, cuja fatura só
   *    entra no saldo na data de vencimento — aqui ele passa a reservar a
   *    partir da DATA DA COMPRA;
   *  · lançamento de categoria orçada em CONTA FORA do escopo do Fluxo —
   *    o compromisso do orçamento entra no saldo mesmo assim.
   *
   * Devolve, por dia do mês, o impacto ACUMULADO (despesa subtrai):
   *  · previsto  = lançamentos PENDENTES (ainda não efetivados);
   *  · efetivado = lançamentos CONFIRMADOS ainda não sentidos pelo saldo.
   * Lançamentos em conta do escopo NÃO entram (o saldo base já os tem —
   * sem dupla contagem).
   */
  async getMonthFluxAdjust(month: string, scopeAccountIds: string[]): Promise<{
    previsto: Record<string, number>;
    efetivado: Record<string, number>;
  }> {
    const budgets = (await this.list()).filter((b) => b.is_active === 1);
    const out = { previsto: {} as Record<string, number>, efetivado: {} as Record<string, number> };
    if (budgets.length === 0) return out;
    const ids = budgets.map((b) => b.category_id);
    const marks = ids.map(() => '?').join(',');
    const lastDay = lastDayNumberOf(month);
    const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;

    // Lançamentos SIMPLES de categorias orçadas, com a fatura do cartão
    // (quando houver) para saber a partir de quando o saldo base já sente.
    const rows = await this.db.getAllAsync<{
      d: string; type: string; status: string; card_id: string | null; account_id: string | null; amount: number; invoice_due: string | null;
    }>(
      `SELECT t.occurred_on AS d, t.type, t.status, t.card_id, t.account_id, t.amount_cents AS amount,
              (SELECT i.due_date FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                WHERE ii.transaction_id = t.id ORDER BY i.due_date DESC LIMIT 1) AS invoice_due
         FROM transactions t
        WHERE t.kind = 'SIMPLE' AND t.status != 'VOIDED'
          AND t.source_system != 'INSTALLMENT'
          AND t.category_id IN (${marks})
          AND t.occurred_on <= ?
          AND t.id NOT IN (
            SELECT original_transaction_id FROM installment_plans
             WHERE original_transaction_id IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM transactions ch WHERE ch.parent_transaction_id = t.id
          )`,
      [...ids, endDate] as never
    );

    const scopeSet = new Set(scopeAccountIds);
    // v68: contribuição por INTERVALO — no cartão o ajuste vale da COMPRA até
    // a véspera do vencimento da fatura (a partir daí o saldo base já reserva
    // a fatura inteira — sem dupla contagem). Em conta fora do escopo, vale
    // da data do lançamento em diante (o saldo do Fluxo nunca sente).
    const prevIv: Array<{ s: string; e: string | null; v: number }> = [];
    const efetIv: Array<{ s: string; e: string | null; v: number }> = [];
    for (const r of rows) {
      const net = r.type === 'INCOME' ? r.amount : -r.amount;
      const isCard = !!r.card_id;
      const inScopeAccount = !isCard && r.account_id != null && scopeSet.has(r.account_id);
      if (isCard) {
        // Cartão: só o PREVISTO antecipa a reserva (o EFETIVADO da conta sente
        // o PAGAMENTO da fatura, que o saldo base já trata pelo movimento).
        if (r.status !== 'PENDING') continue;
        prevIv.push({ s: r.d, e: r.invoice_due, v: net });
      } else if (inScopeAccount) {
        // Conta do escopo: o saldo base já inclui — nada a ajustar.
        continue;
      } else {
        (r.status === 'PENDING' ? prevIv : efetIv).push({ s: r.d, e: null, v: net });
      }
    }
    const at = (iv: Array<{ s: string; e: string | null; v: number }>, d: string): number =>
      iv.reduce((a, x) => (x.s <= d && (x.e == null || d < x.e) ? a + x.v : a), 0);

    for (let day = 1; day <= lastDay; day++) {
      const ymd = `${month}-${String(day).padStart(2, '0')}`;
      out.previsto[ymd] = at(prevIv, ymd);
      out.efetivado[ymd] = at(efetIv, ymd);
    }
    return out;
  }
}
