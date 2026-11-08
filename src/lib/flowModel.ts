/**
 * flowModel — modelo de dados da tela Fluxo (v13).
 *
 * Agregação mensal dos GRUPOS CONSOLIDADOS (função PURA sobre o banco — testável
 * em jest, sem React):
 *  · v13 (bug 1.A): o grupo com linhas Fixo/Parcelado PERPETUA nos meses
 *    seguintes — o cabeçalho é buscado DIRETO do banco quando o mês visto não é
 *    o mês do cabeçalho (antes o grupo sumia porque o cabeçalho não vinha no
 *    listFlow do mês).
 *  · v13 (bug 1.B): a expansão mostra EXATAMENTE os itens reais do mês — as
 *    linhas à vista (mês do cabeçalho), as ocorrências das fixas e as parcelas
 *    em conta daquele mês. Nada de linhas "de origem" duplicando o conteúdo.
 *  · v13 (2.B): os FILHOS já vêm carregados junto (childrenByGroup) — o chip de
 *    status Pago/Não pago funciona com o grupo RECOLHIDO e a ação vale para
 *    todo o agrupamento contido no card.
 */

import type { DbDriver } from '../db/types';

/** Lançamento na tela Fluxo (linhas de transactions + metadados de exibição). */
export interface FlowTx {
  id: string;
  kind: string;
  type: string;
  amount_cents: number;
  occurred_on: string;
  description: string;
  status: string;
  source_system: string;
  recurrence_rule_id: string | null;
  parent_transaction_id: string | null;
  child_count: number;
  group_debits_cents: number;
  group_credits_cents: number;
  category_name: string | null;
  account_name: string | null;
  card_name: string | null;
  account_id: string | null;
  card_id: string | null;
  transfer_account_name: string | null;
  plan_id: string | null;
  plan_total_installments: number | null;
  plan_paid_count: number | null;
}

/** Parcela de plano (em conta) agregada na tela Fluxo. */
export interface InstAgg {
  installmentId: string;
  planId: string;
  description: string;
  sequenceNumber: number;
  totalInstallments: number;
  amountCents: number;
  dueDate: string;
  status: string;
  /** v14 (bug 2): EXPENSE = débito (−) · INCOME = receita parcelada (+). */
  type: string;
  /** v14 (bug 4): nome da conta — o card unificado mostra a conta como os demais. */
  accountName: string | null;
}

/** v12/v13: o consolidado em um dado MÊS — cabeçalho + conteúdo REAL daquele mês. */
export interface GroupMonth {
  header: FlowTx;
  /** Ocorrências das CONTAS FIXAS do grupo com data NESTE mês. */
  occurrences: FlowTx[];
  /** Parcelas EM CONTA dos parcelamentos do grupo com vencimento NESTE mês. */
  installments: InstAgg[];
  /** O cabeçalho é deste mês? (as linhas à vista só existem nele) */
  isHeaderMonth: boolean;
}

// v50 — FLOW_COLUMNS sem subquery correlacionada por linha (200 linhas = 800 subqueries antes).
// Agora: 2 LEFT JOIN pré-agregados (1 GROUP BY cada) — mesmo resultado, 2 scans, não 800.
const FLOW_COLUMNS = `t.*, c.name AS category_name, a.name AS account_name,
        cd.name AS card_name, ta.name AS transfer_account_name,
        ip.id AS plan_id,
        ip.total_installments AS plan_total_installments,
        COALESCE(paid_agg.paid_count, 0) AS plan_paid_count,
        COALESCE(child_agg.child_count, 0) AS child_count,
        COALESCE(child_agg.debits, 0) AS group_debits_cents,
        COALESCE(child_agg.credits, 0) AS group_credits_cents`;

const FLOW_JOINS = `LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN accounts a ON a.id = t.account_id
         LEFT JOIN cards cd ON cd.id = t.card_id
         LEFT JOIN accounts ta ON ta.id = t.transfer_account_id
         LEFT JOIN installment_plans ip ON ip.original_transaction_id = t.id
         LEFT JOIN (SELECT plan_id, COUNT(*) AS paid_count FROM installments WHERE status = 'PAID' GROUP BY plan_id) paid_agg ON paid_agg.plan_id = ip.id
         LEFT JOIN (SELECT parent_transaction_id, COUNT(*) AS child_count, SUM(CASE WHEN type='EXPENSE' THEN amount_cents ELSE 0 END) AS debits, SUM(CASE WHEN type='INCOME' THEN amount_cents ELSE 0 END) AS credits FROM transactions WHERE status != 'VOIDED' AND parent_transaction_id IS NOT NULL GROUP BY parent_transaction_id) child_agg ON child_agg.parent_transaction_id = t.id`;

/** Cabeçalhos de grupos consolidados por ID (mesma forma do listMonth — v13, bug 1.A).
 *  v14 (bug 3): âncoras de parcelamento (source INSTALLMENT) nunca entram —
 *  elas NÃO são grupos consolidados do usuário. */
async function listGroupHeadersByIds(db: DbDriver, ids: string[]): Promise<FlowTx[]> {
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(',');
  const rows = await db.getAllAsync(
    `SELECT ${FLOW_COLUMNS}
       FROM transactions t
       ${FLOW_JOINS}
      WHERE t.id IN (${marks}) AND t.kind = 'CONSOLIDATED' AND t.source_system != 'INSTALLMENT' AND t.parent_transaction_id IS NULL`,
    ids as never
  );
  return rows as unknown as FlowTx[];
}

export interface GroupMonthsResult {
  /** Grupos consolidados deste mês (por id do cabeçalho). */
  gm: Record<string, GroupMonth>;
  /** Ids das ocorrências de fixas do grupo (saem da lista raiz). */
  occIds: Set<string>;
  /** Ids das parcelas em conta do grupo (saem da lista raiz). */
  instIds: Set<string>;
  /** v13 (2.B): filhos à vista por grupo — só no mês do cabeçalho (podem existir). */
  childrenByGroup: Record<string, FlowTx[]>;
}

/** Agrega os grupos consolidados de um mês (a lógica era da tela — agora testável). */
export async function buildGroupMonths(
  db: DbDriver,
  month: string,
  allRows: FlowTx[]
): Promise<GroupMonthsResult> {
  const isGroupHeader = (t: FlowTx) => t.kind === 'CONSOLIDATED' && t.source_system !== 'INSTALLMENT';
  const headerRows = allRows.filter(isGroupHeader);

  // v13 (bug 1.A): grupos com linhas Fixo/Parcelado vinculadas podem ter o
  // cabeçalho em OUTRO mês — eles também aparecem neste mês.
  const linkedRows = await db.getAllAsync<{ id: string }>(
    `SELECT DISTINCT g.id AS id
       FROM transactions g
      WHERE g.kind = 'CONSOLIDATED' AND g.source_system != 'INSTALLMENT'
        AND (EXISTS (SELECT 1 FROM recurrence_rules r WHERE r.group_transaction_id = g.id)
          OR EXISTS (SELECT 1 FROM installment_plans p WHERE p.group_transaction_id = g.id))`
  );

  // v13 (bug 1.A): cabeçalhos que NÃO estão no listFlow deste mês vêm direto
  // do banco — é o que faz o grupo PERPETUAR nos meses seguintes.
  const missing = linkedRows.map((r) => r.id).filter((gid) => !headerRows.some((t) => t.id === gid));
  const extraHeaders = await listGroupHeadersByIds(db, missing);
  const headerPool = [...headerRows, ...extraHeaders];

  const groupIds = Array.from(new Set([...headerPool.map((t) => t.id), ...linkedRows.map((r) => r.id)]));
  const gm: Record<string, GroupMonth> = {};
  const occIds = new Set<string>();
  const instIds = new Set<string>();
  const childrenByGroup: Record<string, FlowTx[]> = {};

  for (const gid of groupIds) {
    const header = headerPool.find((t) => t.id === gid);
    if (!header) continue;
    const ruleRows = await db.getAllAsync<{ id: string }>(
      'SELECT id FROM recurrence_rules WHERE group_transaction_id = ?',
      [gid]
    );
    const planRows = await db.getAllAsync<{ id: string; card_id: string | null; account_id: string | null }>(
      'SELECT id, card_id, account_id FROM installment_plans WHERE group_transaction_id = ?',
      [gid]
    );
    // Ocorrências das fixas do grupo NESTE mês (entram DENTRO do card do grupo)
    let occurrences: FlowTx[] = [];
    if (ruleRows.length > 0) {
      const marks = ruleRows.map(() => '?').join(',');
      occurrences = (await db.getAllAsync(
        `SELECT t.*, c.name AS category_name, a.name AS account_name,
                cd.name AS card_name, ta.name AS transfer_account_name,
                NULL AS plan_id, NULL AS plan_total_installments, NULL AS plan_paid_count,
                0 AS child_count, 0 AS group_debits_cents, 0 AS group_credits_cents
           FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
           LEFT JOIN accounts a ON a.id = t.account_id
           LEFT JOIN cards cd ON cd.id = t.card_id
           LEFT JOIN accounts ta ON ta.id = t.transfer_account_id
          WHERE t.recurrence_rule_id IN (${marks})
            AND substr(t.occurred_on, 1, 7) = ? AND t.status != 'VOIDED'`,
        [...ruleRows.map((r) => r.id), month] as never
      )) as unknown as FlowTx[];
    }
    // Parcelas EM CONTA dos planos do grupo com vencimento NESTE mês
    let installments: InstAgg[] = [];
    const contaPlanIds = planRows.filter((p) => !p.card_id && p.account_id).map((p) => p.id);
    if (contaPlanIds.length > 0) {
      const marks = contaPlanIds.map(() => '?').join(',');
      installments = (await db.getAllAsync(
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
          WHERE ins.plan_id IN (${marks}) AND ins.status != 'CANCELED' AND ins.due_date LIKE ?`,
        [...contaPlanIds, `${month}-%`] as never
      )) as unknown as InstAgg[];
    }
    const isHeaderMonth = header.occurred_on.slice(0, 7) === month;
    // Sem conteúdo no mês (cabeçalho em outro mês, sem ocorrência/parcela):
    // o grupo não aparece neste mês (ex.: ocorrência do mês foi excluída).
    if (!isHeaderMonth && occurrences.length === 0 && installments.length === 0) continue;
    gm[gid] = { header, occurrences, installments, isHeaderMonth };
    for (const o of occurrences) occIds.add(o.id);
    for (const i of installments) instIds.add(i.installmentId);
    // v13 (2.B): filhos à vista carregados JÁ na carga do mês (o chip de status
    // do grupo funciona com a setinha RECOLHIDA e a expansão não refaz a busca).
    if (isHeaderMonth) {
      childrenByGroup[gid] = (await db.getAllAsync(
        `SELECT t.*, c.name AS category_name, a.name AS account_name,
                cd.name AS card_name, ta.name AS transfer_account_name,
                NULL AS plan_id, NULL AS plan_total_installments, NULL AS plan_paid_count,
                0 AS child_count, 0 AS group_debits_cents, 0 AS group_credits_cents
           FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
           LEFT JOIN accounts a ON a.id = t.account_id
           LEFT JOIN cards cd ON cd.id = t.card_id
           LEFT JOIN accounts ta ON ta.id = t.transfer_account_id
          WHERE t.parent_transaction_id = ?
          ORDER BY t.type DESC, t.amount_cents DESC`,
        [gid]
      )) as unknown as FlowTx[];
    }
  }
  return { gm, occIds, instIds, childrenByGroup };
}

/** Débitos/créditos do consolidado NO MÊS visto (v13: os totais das linhas à
 *  vista contam SÓ no mês do cabeçalho — antes vazavam para todo mês).
 *  v14 (bug 2): parcelas INCOME (receita parcelada) contam como CRÉDITO. */
export function groupMonthTotals(grp: GroupMonth): { debits: number; credits: number } {
  const headerDebits = grp.isHeaderMonth ? (grp.header.group_debits_cents ?? 0) : 0;
  const headerCredits = grp.isHeaderMonth ? (grp.header.group_credits_cents ?? 0) : 0;
  const debits =
    headerDebits +
    grp.occurrences.filter((o) => o.type === 'EXPENSE').reduce((a, b) => a + b.amount_cents, 0) +
    grp.installments.filter((i) => i.type !== 'INCOME').reduce((a, b) => a + b.amountCents, 0);
  const credits =
    headerCredits +
    grp.occurrences.filter((o) => o.type === 'INCOME').reduce((a, b) => a + b.amount_cents, 0) +
    grp.installments.filter((i) => i.type === 'INCOME').reduce((a, b) => a + b.amountCents, 0);
  return { debits, credits };
}

/**
 * v13 (2.B): itens do grupo que PARTICIPAM do status Pago/Não pago — linhas à
 * vista + ocorrências de fixas EM CONTA + parcelas em conta. Itens de CARTÃO
 * não entram (são pagos pela fatura, ciclo próprio).
 */
export function groupStatusItems(grp: GroupMonth, children: FlowTx[]): { txs: FlowTx[]; insts: InstAgg[] } {
  const eligible = (t: FlowTx) =>
    t.status !== 'VOIDED' &&
    t.kind === 'SIMPLE' &&
    !t.card_id &&
    !!t.account_id &&
    (t.type === 'INCOME' || t.type === 'EXPENSE');
  return {
    txs: [...children, ...grp.occurrences].filter(eligible),
    insts: grp.installments.filter((i) => i.status !== 'CANCELED'),
  };
}

/** v13 (2.B): estado do status do grupo (null = nada a alternar — sem chip). */
export function groupStatusInfo(
  grp: GroupMonth,
  children: FlowTx[]
): { allDone: boolean; isIncome: boolean; count: number } | null {
  const { txs, insts } = groupStatusItems(grp, children);
  const count = txs.length + insts.length;
  if (count === 0) return null;
  const allDone =
    txs.every((t) => t.status === 'CONFIRMED') && insts.every((i) => i.status === 'PAID');
  return { allDone, isIncome: grp.header.type === 'INCOME', count };
}

/**
 * v17 (melhoria 2): "sabor" do consolidado NO MÊS — o card do grupo segue o
 * MESMO padrão visual dos lançamentos normais na mesma linha:
 *   [Número da Parcela/Total] [Parcelado] [Status]  · ou  ·  [✓ Fixa] [Fixo] [Status]
 *  - fixo: existem ocorrências de conta fixa do grupo neste mês (bolinha ✓).
 *  - parcelado: existem parcelas em conta deste mês (pill X/N da 1ª parcela).
 *  - Um grupo misto (fixa + parcelado) mostra os dois marcadores.
 */
export function groupKindInfo(grp: GroupMonth): {
  fixo: boolean;
  parcelado: boolean;
  /** Pill representativa do parcelamento (1ª parcela à vista no mês). */
  pill: { current: number; total: number } | null;
} {
  const fixo = grp.occurrences.length > 0;
  const first = grp.installments[0];
  return {
    fixo,
    parcelado: grp.installments.length > 0,
    pill: first ? { current: first.sequenceNumber, total: first.totalInstallments } : null,
  };
}

// v49 FIX — global cache REMOVIDO (key só headerId, nunca invalidava -> valor/data antigos). Cache correto é o useMemo do Fluxo (depende de gm).
