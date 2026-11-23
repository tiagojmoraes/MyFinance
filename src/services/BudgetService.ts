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
 *      - PARCELAS (em conta e no cartão) pelo MÊS DA COMPRA (v72 — regra do
 *        usuário: "o orçamento é dentro do mês mesmo que o pagamento seja no
 *        próximo"): o plano INTEIRO soma no mês da transação-âncora, pela
 *        occurred_on dela — nunca espalhado pelos vencimentos até 2027. A
 *        âncora fica FORA da soma para não contar em dobro;
 *  · v72 — PAI COBRE A SUBÁRVORE INTEIRA: o gasto do item pai inclui TODAS as
 *    subcategorias dele (coletânea recursiva), tenham elas orçamento ou não
 *    — antes, subitens sem orçamento escapavam da composição do pai;
 *  · v72 — saldo desce NA COMPRA e fica descido ATÉ O PAGAMENTO: no Fluxo, a
 *    compra no cartão (pendente OU efetivada) reserva desde a data da compra
 *    até a véspera do vencimento da fatura (getMonthFluxAdjust);
 *  · o card no Fluxo mostra, por orçamento: ORÇADO • PREVISTO • GASTO (v68 —
 *    orçado = limite; previsto = lançamentos ainda não efetivados; gasto = já
 *    efetivados) e a barrinha de conclusão; o total que falta fica no cabeçalho;
 *  · v68: o "previsto" e o "efetivado" do orçamento ENTRAM no "Saldo do dia"
 *    do Fluxo (getMonthFluxAdjust — lança a reserva antes da fatura vencer e
 *    traz compromissos de contas fora do escopo).
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { nowIso, lastDayNumberOf, monthRange } from '../lib/dates';
import { VersionedCache } from '../lib/versionedCache';

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
  /** v90 — `YYYY-MM` da criação do orçamento (mês de início do plano).
   *  Usado pelo Fluxo para ESCONDER o card de Orçamento em meses anteriores
   *  à criação (era fonte de confusão: o usuário via o card com "0 ativo(s)"
   *  em meses passados). */
  createdMonth: string;
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
  // v98 — DESEMPENHO DO FLUXO: memo por mês + `dataVersion` (a tela do Fluxo
  // passa a versão atual do app). Mesmo valor, mesma versão = mesmo cache;
  // qualquer escrita tripudial `bump()` (versão++) → recalcula.
  private summaryCache = new VersionedCache<BudgetMonthSummary>();
  private adjustCache = new VersionedCache<{ previsto: Record<string, number>; efetivado: Record<string, number> }>();

  constructor(private db: DbDriver) {}

  /** v98: chamada após uma escrita (save/setActive/remove). Limpa TUDO: a
   *  lista de orçamentos mudou, e cada mês já cacheado precisa recalcular. */
  invalidateAll(): void {
    this.summaryCache.clear();
    this.adjustCache.clear();
  }

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
    this.invalidateAll();
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
    this.invalidateAll();
  }

  async remove(budgetId: string): Promise<void> {
    await this.db.runAsync('DELETE FROM budgets WHERE id = ?', [budgetId]);
    this.invalidateAll();
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
    this.invalidateAll();
    return affected;
  }

  /**
   * Resumo do MÊS: por orçamento ativo — orçado, gasto e falta; e o TOTAL
   * (cabeçalho do card no Fluxo). Ver regras no cabeçalho da classe.
   * v67 (BUG 4) — COMPOSIÇÃO item ▸ subitem: quando o item tem orçamentos
   * ativos em SUBCATEGORIAS, o valor dele passa a ser a SOMA dos subitens
   * (pai R$ 100 = 60 + 40) — o valor próprio do pai não soma por cima; o
   * gasto do pai = gasto próprio + SUBÁRVORE inteira (v72 — subitens com ou
   * sem orçamento entram); os subitens aparecem com a barrinha deles mas
   * ficam FORA dos totais (sem dupla contagem).
   */
  // v98 — memo por mês + `dataVersion` opcional. Mesma versão = mesmo resumo.
  async getMonthSummary(month: string, dataVersion?: number): Promise<BudgetMonthSummary> {
    return this.summaryCache.get(`summary|${month}`, dataVersion, async () => {
      const sum = await this.computeMonthSummary(month);
      return sum;
    });
  }

  private async computeMonthSummary(month: string): Promise<BudgetMonthSummary> {
    const budgets = (await this.list()).filter((b) => b.is_active === 1);
    if (budgets.length === 0) {
      return { items: [], budgetedCents: 0, spentCents: 0, previstoCents: 0, efetivadoCents: 0, remainingCents: 0 };
    }

    // (1) Despesas SIMPLES do mês (à vista, cartão à vista, fixas, linhas de grupo):
    //     pela data do lançamento. v68: PENDING e CONFIRMED somados SEPARADOS —
    //     "Previsto" (ainda não efetivado) e "Gasto" (já efetivado).
    //     Fora: cabeçalhos CONSOLIDATED (contam pelos filhos) e
    //     âncoras de parcelamento (contam pelas parcelas).
    //     v72: SEM filtro de categoria — a composição do pai (subárvore
    //     inteira) precisa do gasto de TODAS as categorias.
    // v86 (DESEMPENHO): faixa indexável no lugar de substr(occurred_on,1,7).
    const spentRange = monthRange(month);
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
          AND t.occurred_on >= ? AND t.occurred_on < ?
        GROUP BY t.category_id`,
      [spentRange.start, spentRange.end] as never
    );

    // (2) v72 — Parcelas pelo MÊS DA COMPRA (âncora): o plano inteiro soma no
    //     mês da occurred_on da transação-âncora — "o orçamento é dentro do mês
    //     mesmo que o pagamento seja no próximo". Pendente = parcelas em
    //     aberto (Previsto); pago = parcelas quitadas (Gasto).
    const instRows = await this.db.getAllAsync<{ cid: string; pending: number; confirmed: number }>(
      `SELECT t.category_id AS cid,
              COALESCE(SUM(CASE WHEN i.status = 'PENDING' THEN i.amount_cents ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN i.status != 'PENDING' THEN i.amount_cents ELSE 0 END), 0) AS confirmed
         FROM installments i
         JOIN installment_plans p ON p.id = i.plan_id
         JOIN transactions t ON t.id = p.original_transaction_id
        WHERE i.status != 'CANCELED'
          AND t.category_id IS NOT NULL
          AND t.occurred_on >= ? AND t.occurred_on < ?
        GROUP BY t.category_id`,
      [spentRange.start, spentRange.end] as never
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

    // v100 — SPLIT DE ORÇAMENTO POR NF: quando a NF tem
    // `budget_split_json` (gravado pelo NfceService em cada classificação,
    // incluindo a tardia), os valores alocados às categorias dos produtos
    // SOMAM no orçamento delas — e como o pai cobre a subárvore inteira,
    // NÃO precisa de orçamento próprio lá. O que ficou na categoria do
    // lançamento SUBTRAI do que simple/instRows somaram lá (para não contar
    // em dobro). O snapshot é REESCRITO a cada reclassificação.
    const splitRows = await this.db.getAllAsync<{
      tx_id: string; cid: string | null; pending: number; confirmed: number; split_json: string | null;
    }>(
      `SELECT t.id AS tx_id, t.category_id AS cid,
              CASE WHEN t.status = 'PENDING' THEN t.amount_cents ELSE 0 END AS pending,
              CASE WHEN t.status != 'PENDING' THEN t.amount_cents ELSE 0 END AS confirmed,
              d.budget_split_json AS split_json
         FROM transactions t
         JOIN nfce_documents d ON d.transaction_id = t.id
        WHERE t.type = 'EXPENSE' AND t.status != 'VOIDED'
          AND t.occurred_on >= ? AND t.occurred_on < ?`,
      [spentRange.start, spentRange.end] as never
    );
    for (const r of splitRows) {
      const parts = parseSplitJson(r.split_json);
      if (!parts.length) continue;
      // remove o que simple teceu da categoria do lançamento
      spentByCat.set(r.cid ?? '', Math.max(0, (spentByCat.get(r.cid ?? '') ?? 0) - (r.pending + r.confirmed)));
      prevByCat.set(r.cid ?? '', Math.max(0, (prevByCat.get(r.cid ?? '') ?? 0) - r.pending));
      efetByCat.set(r.cid ?? '', Math.max(0, (efetByCat.get(r.cid ?? '') ?? 0) - r.confirmed));
      // aplica o split proporcionalmente pelas status disponíveis
      const totalCents = r.pending + r.confirmed;
      if (totalCents <= 0) continue;
      for (const part of parts) {
        const share = part.cents / totalCents;
        const p = Math.round(r.pending * share);
        const c = Math.round(r.confirmed * share);
        spentByCat.set(part.categoryId, (spentByCat.get(part.categoryId) ?? 0) + p + c);
        prevByCat.set(part.categoryId, (prevByCat.get(part.categoryId) ?? 0) + p);
        efetByCat.set(part.categoryId, (efetByCat.get(part.categoryId) ?? 0) + c);
      }
    }

    // v67 (BUG 4): mapa categoria-pai → orçamentos ativos dos SUBITENS
    // v72: mapa pai → filhos e SUBÁRVORE de cada categoria (todos os
    // descendentes, com ou sem orçamento — o pai cobre tudo o que está nele).
    const catRows = await this.db.getAllAsync<{ id: string; parent_id: string | null }>(
      'SELECT id, parent_id FROM categories'
    );
    const parentOf = new Map(catRows.map((c) => [c.id, c.parent_id]));
    const childrenOf = new Map<string, string[]>();
    for (const c of catRows) {
      if (!c.parent_id) continue;
      const arr = childrenOf.get(c.parent_id) ?? [];
      arr.push(c.id);
      childrenOf.set(c.parent_id, arr);
    }
    const subtreeOf = (catId: string): string[] => {
      const out: string[] = [];
      const queue = [...(childrenOf.get(catId) ?? [])];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        out.push(cur);
        queue.push(...(childrenOf.get(cur) ?? []));
      }
      return out;
    };
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
      // v72 — SUBÁRVORE INTEIRA: o gasto do pai inclui TODAS as subcategorias
      // (recursivo), tenham elas orçamento ou não — nada escapa do pai.
      const subtree = subtreeOf(b.category_id);
      const subSpent = subtree.reduce((a, c) => a + (spentByCat.get(c) ?? 0), 0);
      const subPrev = subtree.reduce((a, c) => a + (prevByCat.get(c) ?? 0), 0);
      const subEfet = subtree.reduce((a, c) => a + (efetByCat.get(c) ?? 0), 0);
      // PAI COMPOSTO: valor = soma dos subitens orçados (pai R$ 100 = 60 + 40)
      const amountCents = composed ? subs.reduce((a, s) => a + s.amount_cents, 0) : b.amount_cents;
      // Gasto do pai = próprio + gasto de toda a subárvore (os lançamentos
      // moram nas categorias — com ou sem orçamento próprio)
      const spentCents = ownSpent + subSpent;
      const previstoCents = (prevByCat.get(b.category_id) ?? 0) + subPrev;
      const efetivadoCents = (efetByCat.get(b.category_id) ?? 0) + subEfet;
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
        // v90 — mês de criação do orçamento (esconde o card em meses anteriores).
        createdMonth: (b.created_at ?? '').slice(0, 7),
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
   * v18 — COMPROMISSO JÁ PREVISTO do mês nas categorias COM orçamento ativo,
   * pelo VENCIMENTO (não pela âncora): parcelas EM CONTA com débito agendado
   * no mês + faturas de cartão vencendo no mês (só a parte das categorias
   * orçadas, limitada ao valor em aberto da fatura).
   *
   * A fixa SIMPLE pendente NÃO entra aqui — ela já abate o restante pelo
   * `previstoCents` do summary (pela occurred_on). Parcelas de CARTÃO entram
   * pelos invoice_items (via categoria da transação-âncora) — sem dupla
   * contagem com a soma por vencimento de parcelas em conta.
   *
   * Uso: MESSES FUTUROS do livro-razão (MonthLedgerService.computeMonth).
   * No mês futuro isso é o que JÁ SAIRÁ do saldo previsto (pendências do
   * dual) e, sem abater, fica contado DUAS VEZES — dentro do saldo e dentro
   * do restante do orçamento — esmagando a capacidade da Programação de
   * Compras (cabe = 0 mesmo com a falta viajando) e deixando o closing
   * negativo (a dívida fantasma abre o mês seguinte sem zerar o Saldo do
   * dia). O mês corrente mantém a regra v72 da âncora.
   */
  async getFutureDueCommitmentCents(month: string): Promise<number> {
    const budgets = (await this.list()).filter((b) => b.is_active === 1);
    if (budgets.length === 0) return 0;
    const ids = budgets.map((b) => b.category_id);
    const marks = ids.map(() => '?').join(',');
    const range = monthRange(month);

    // 1) Parcelas EM CONTA (plano sem cartão) com débito agendado no mês —
    //    mesma semântica do dual (installment PENDING + financial_moves
    //    CONFIRMED pela effective_date; sinal pela direção: receita parcelada
    //    DEVOLVE capacidade). SÓ planos com âncora ANTES do mês: a âncora
    //    datada no próprio mês já contou o plano INTEIRO no gasto deste mês
    //    (regra v72 da âncora) — abater de novo seria dupla contagem.
    const parcelas = await this.db.getFirstAsync<{ total: number | null }>(
      `SELECT COALESCE(SUM(CASE WHEN fm.direction = 'CREDIT' THEN -fm.amount_cents ELSE fm.amount_cents END), 0) AS total
         FROM installments i
         JOIN installment_plans p ON p.id = i.plan_id
         JOIN transactions t ON t.id = p.original_transaction_id
         JOIN financial_moves fm ON fm.installment_id = i.id
        WHERE p.card_id IS NULL
          AND i.status = 'PENDING'
          AND fm.status = 'CONFIRMED'
          AND fm.effective_date >= ? AND fm.effective_date < ?
          AND t.occurred_on < ?
          AND t.category_id IN (${marks})`,
      [range.start, range.end, range.start, ...ids] as never
    );

    // 2) Faturas vencendo no mês: por fatura, a parte das categorias orçadas
    //    limitada ao valor EM ABERTO (o dual desconta total − crédito
    //    anterior − pago na data de vencimento). Só entra item cuja COMPRA
    //    (à vista pela occurred_on; parcela pela âncora) é ANTERIOR ao mês —
    //    compra dentro do próprio mês já está no previstoCents/spent deste
    //    mês (sem contar duas vezes).
    const faturas = await this.db.getFirstAsync<{ total: number | null }>(
      `SELECT COALESCE(SUM(MIN(cat_due, open_due)), 0) AS total
         FROM (
           SELECT i.id,
                  MAX(0, i.total_cents - i.credit_from_prev_cents - i.paid_cents) AS open_due,
                  COALESCE(SUM(CASE
                      WHEN COALESCE(t.category_id, t2.category_id) IN (${marks})
                       AND (CASE WHEN ii.transaction_id IS NOT NULL THEN t.occurred_on ELSE t2.occurred_on END) < ?
                      THEN ii.amount_cents ELSE 0 END), 0) AS cat_due
             FROM invoices i
             LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
             LEFT JOIN transactions t ON t.id = ii.transaction_id
             LEFT JOIN installments ist ON ist.id = ii.installment_id
             LEFT JOIN installment_plans pl ON pl.id = ist.plan_id
             LEFT JOIN transactions t2 ON t2.id = pl.original_transaction_id
            WHERE i.due_date >= ? AND i.due_date < ?
              AND i.status != 'PAID'
            GROUP BY i.id
         )`,
      [...ids, range.start, range.start, range.end] as never
    );

    return Math.max(0, parcelas?.total ?? 0) + Math.max(0, faturas?.total ?? 0);
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
  // v98 — memo por mês + lista escopo + `dataVersion` opcional.
  async getMonthFluxAdjust(
    month: string,
    scopeAccountIds: string[],
    dataVersion?: number
  ): Promise<{
    previsto: Record<string, number>;
    efetivado: Record<string, number>;
  }> {
    // O ajuste depende também do escopo (conjunto de contas do Fluxo); entra
    // na chave do cache para não devolver resultado de escopo errado.
    const scopeKey = scopeAccountIds.slice().sort().join(',');
    return this.adjustCache.get(
      `adjust|${month}|${scopeKey}`,
      dataVersion,
      async () => this.computeMonthFluxAdjust(month, scopeAccountIds)
    );
  }

  private async computeMonthFluxAdjust(
    month: string,
    scopeAccountIds: string[]
  ): Promise<{ previsto: Record<string, number>; efetivado: Record<string, number> }> {
    const budgets = (await this.list()).filter((b) => b.is_active === 1);
    const out = { previsto: {} as Record<string, number>, efetivado: {} as Record<string, number> };
    if (budgets.length === 0) return out;
    const ids = budgets.map((b) => b.category_id);
    const marks = ids.map(() => '?').join(',');
    const lastDay = lastDayNumberOf(month);
    const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;

    // v98 — SEM SUBCONSULTA CORRELATA por linha: trocado por `LEFT JOIN` em
    // `invoice_items + invoices`, agrupado por transaction_id e pegando a MAIOR
    // `due_date` (a regra anterior pegava a da fatura mais recente). Com o
    // índice `idx_inv_item_tx(transaction_id)` a junção resolve sem varredura
    // — antes, cada linha abria um scan em `invoice_items` e somava ~20-50 ms
    // cada, deixando `getMonthFluxAdjust` em ~2 s com histórico cheio.
    const rows = await this.db.getAllAsync<{
      d: string; type: string; status: string; card_id: string | null; account_id: string | null; amount: number; invoice_due: string | null;
    }>(
      `SELECT t.occurred_on AS d,
              t.type, t.status, t.card_id, t.account_id, t.amount_cents AS amount,
              MAX(i.due_date) AS invoice_due
         FROM transactions t
         LEFT JOIN invoice_items ii ON ii.transaction_id = t.id
         LEFT JOIN invoices i ON i.id = ii.invoice_id
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
          )
        GROUP BY t.id`,
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
        // v72 — Cartão: reserva da COMPRA até a véspera da fatura, vale para
        // PENDING (v68) e TAMBÉM para CONFIRMED (regra do usuário: o saldo
        // desce NA COMPRA e fica descido ATÉ O PAGAMENTO — depois da fatura
        // vencer, o saldo base já sente a fatura inteira, sem dupla contagem).
        const iv = r.status === 'PENDING' ? prevIv : efetIv;
        iv.push({ s: r.d, e: r.invoice_due, v: net });
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

/** v100 — parse tolerante do split congelado guardado pela NF. */
function parseSplitJson(json: string | null): Array<{ categoryId: string; cents: number }> {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.categoryId === 'string' && Number.isFinite(x.cents))
      .map((x) => ({ categoryId: x.categoryId, cents: Math.max(0, Math.round(x.cents)) }));
  } catch {
    return [];
  }
}
