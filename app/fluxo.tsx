/** Tela Fluxo — v14/v16/v18:
 *  · v16 BUG 1+2: Fixo/Consolidado criados no MÊS VIGENTE aparecem no mês
 *    corrente (previsão PENDING do dia ainda não vencido) — saldo do grupo e
 *    chip Pago/Não pago presentes desde já (RecurrenceService.runForecast).
 *  · v16 BUG 3: CONTA FIXA no cartão ganha a bolinha ✓ também nos itens da
 *    fatura listados no Fluxo (mesma iconografia da tela da fatura).
 *  · v16 MELHORIA 1: itens AGLUTINADOS do consolidado não têm mais botão de
 *    status individual — o comando é exclusivo do CABEÇALHO do grupo.
 *  · v18 (bug 3): saldos do dia (Previsto/Efetivado) recalculados por rotina
 *    robusta e garantida (BalanceService v18) — recarregam a cada mudança de
 *    dados E ao voltar o foco para o Fluxo (useFocusEffect).
 *  · v21 (bug 1): "Alterar" em parcela/parcelamento abre a TELA DO PLANO
 *    (/plano/[id] — todos os campos, conta ou cartão); o cabeçalho do
 *    consolidado abre o formulário padrão.
 *  · v22 (bug 1): o cabeçalho do CONSOLIDADO ganha o botão "+Incluir" ao lado
 *    direito do "Alterar" — abre a tela de Novo Lançamento EM MODAL (sobe por
 *    cima do Fluxo) no modo "incluir no grupo": as linhas novas (à vista, fixa
 *    ou parcelada) entram no grupo e passam a compor o saldo dele.
 *  · v21 (bug 4): Excluir exige CONFIRMAÇÃO (modal, com escopo nas parcelas).
 *  · v21 (bug 2): previsões à vista vencidas são promovidas na abertura.
 *  · v18 (bug 4): parcela PAGA não oferece Excluir (pagas nunca são excluídas —
 *    era fonte de erro); exclusões cascata corrigidas nos serviços.
 *  · v18 (melhoria 1): o CABEÇALHO do consolidado fica LIMPO — sem texto nem
 *    ícone de Fixo/Parcelado; os marcadores padrão aparecem EXCLUSIVAMENTE nos
 *    itens internos do agrupamento.
 *  · v24 (bug "saldo do dia instável"): a carga de dados ganhou guardas de
 *    vigência (isCurrent) — quando algo muda (bump, foco, mês), as cargas
 *    antigas se abandonam e a ÚLTIMA é a que vence. Antes, uma carga velha
 *    podia terminar depois da nova e pintar saldos/lista desatualizados
 *    (o saldo do dia "não comportava alteração de datas"). O cálculo em si
 *    (BalanceService.getDailyBalancesDual) já relê TUDO do banco a cada carga:
 *    todo e qualquer lançamento — à vista, fixo, parcelado, fatura, editado,
 *    movido de data, pago ou excluído — é recalculado do zero para TODOS os
 *    dias do mês em cada atualização.
 *  · BUG 1: (limpeza em Ajustes — corrigido no banco; este card é o padrão único)
 *  · BUG 2: RECEITA PARCELADA — consolidado aceita linha Crédito + Parcelado
 *    (aluguel 36x, corretagem 36x, obras 5x): parcelas como CRÉDITO em conta ou
 *    item NEGATIVO na fatura do cartão; chip "Recebido/Não recebido" e sinal +.
 *  · BUG 3: a ÂNCORA interna do parcelamento (kind CONSOLIDATED/source
 *    INSTALLMENT) saiu da lista — criar um parcelado normal NÃO cria mais um
 *    "Consolidado" fantasma no Fluxo.
 *  · BUG 4 + MELHORIA 1 (LAYOUT ÚNICO): tudo que não é de cartão (comum,
 *    parcela em conta, consolidado — Fixo ou Parcelado — e itens do grupo) usa
 *    o MESMO card (renderFlowCard): título / data+detalhes / chips à esquerda;
 *    valor com Alterar/Excluir à direita, sempre nos mesmos lugares. O
 *    consolidado é o mesmo card + setinha + chip CONSOLIDADO + Saldo do mês; os
 *    filhos só ganham recuo tracejado (v13 2.B mantido: status do grupo cobre
 *    todo o agrupamento mesmo recolhido; bug 1.B mantido: expansão sem duplicar).
 *  · v67 (BUG 1): cabeçalho do dia em LINHAS EMPILHADAS — saldo Previsto /
 *    Efetivado em linha própria (nunca mais dividem a mesma linha).
 *  · v67 (BUG 2): o esqueleto das linhas virou o COMPONENTE LancamentoRow
 *    (src/components/LancamentoRow.tsx) — lançamentos, parcelas, grupos,
 *    faturas e os cards de Orçamento/Poupança usam O MESMO layout.
 *  · v67 (BUG 3): o saldo do cabeçalho dos cards Orçamento/Poupança NUNCA
 *    desaparece — sem dados mostra R$ 0,00.
 *  · v67 (MELHORIA 3): os atalhos Parcelamentos/Recorrências saíram daqui —
 *    dados e lógica intactos; lançamentos seguem na lista do mês.
 *  · v68 (BUGS 1–3): a linha de "Orçamentos" do cabeçalho do dia SAIU (nunca mais bloco
 *    separado). O que o usuário pediu:
 *     · expandir ORÇAMENTO mostra "Orçado • Previsto • Gasto" (limite, previsto
 *       = pendentes, gasto = já efetivados);
 *     · expandir POUPANÇA mostra o PLANO CADASTRADO: nome, modalidade, valor,
 *       guardado/falta;
 *     · o "Saldo do dia Previsto/Efetivado" INCORPORA orçamento e poupança:
 *       Previsto = base + previsto no Orçamento + previsto na Poupança (na
 *       modalidade Fechamento do Mês nada entra — o restante é da poupança;
 *       na Mensal o valor programado volta ao número); Efetivado = base +
 *       efetivado no Orçamento + efetivado na Poupança (mesma lógica).
 *       Os cálculos são MEMOIZADOS (useMemo) — recalculam só quando mudam
 *       dados/mês, nunca a cada digitação.
 *  · v69 (BUGS Poupança):
 *     · o cabeçalho do card MOSTRA O PLANO — subtitle conta os planos
 *       cadastrados (não só as entradas do mês) e o valor é o PROGRAMADO
 *       (previsões + estimativa do Fechamento do Mês — o saldo que sobraria
 *       no fim do mês), nunca mais "R$ 0,00" com plano ativo;
 *     · "Falta transferir" = programado − já transferido (ex.: preciso
 *       transferir 10 mil, transferei 500 → falta 9.500);
 *     · "Orçado • Previsto • Gasto" TUDO NA MESMA LINHA com porcentagem por
 *       movimento, sempre número redondo sem decimal (ex.: Orçado R$ 350,00 •
 *       Previsto R$ 250,00 (71%) • Gasto R$ 100,00 (29%));
 *     · com Poupança + "Fechamento do mês", o "Saldo do dia Previsto" do
 *       ÚLTIMO dia com lançamento fica R$ 0,00 — o valor disponível vai para
 *       a poupança e não arrasta para os meses seguintes.
 *  · v70 (BUGS):
 *     · LISTA DE DESEJOS é um BLOCO PRÓPRIO do Fluxo (mesma visualização de
 *       Orçamento/Poupança, com fechinha para expandir) — saiu de dentro do
 *       card de Orçamento; a ORDEM no Fluxo é Orçamentos → Lista de Desejos
 *       → Poupança (MELHORIA 2.1);
 *     · FECHAMENTO MENSAL RECALCULA NA HORA — qualquer alteração de data,
 *       valor, lançamento ou transferência refaz a estimativa (nada travado);
 *     · nos meses regidos pelo "Fechamento do mês", o saldo carregado dos
 *       meses anteriores foi RETIDO para a poupança: o "Saldo do dia Previsto"
 *       não começa com ele e o último dia com lançamento fecha em R$ 0,00.
 *  · Mantém v11–v13: Fixo/Parcelado perpetuando nos meses seguintes; saldos do
 *    dia (Previsto/Efetivado); compras no CARTÃO estritamente na fatura;
 *    duplicar (segurar 3 s).
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, Card, Button, EmptyState, Badge, Segmented, FixedDot, InstallmentPill, ProgressBar } from '../src/components/ui';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { LancamentoRow } from '../src/components/LancamentoRow'; // v67 (BUG 2): esqueleto ÚNICO das linhas
import { showToast } from '../lib/toast';
import { MonthScroller } from '../src/components/MonthScroller';
import { useDataEffect } from '../src/components/useDataEffect';
import { formatBRL } from '../src/lib/money';
import { subtractAllocationsCents } from '../src/lib/flowAllocations';
import { orcadoPrevistoGastoLinha } from '../src/lib/fluxoFormat'; // v69: linha única com % por movimento
import { sourceLabel } from '../src/lib/text';
import { todaySP, monthOf, ymdToBr, partsOf } from '../src/lib/dates';
import {
  buildGroupMonths,
  groupMonthTotals,
  groupStatusInfo,
  groupStatusItems,
  type FlowTx,
  type GroupMonth,
  type InstAgg,
} from '../src/lib/flowModel';
import { useAppStore } from '../src/store/appStore';
import { SETTING_KEYS } from '../src/services/SettingsService';
import type { BudgetMonthSummary } from '../src/services/BudgetService';
import type { SavingsMonthOverview } from '../src/services/SavingsService';
import type { WishlistClassView, WishlistMethodology } from '../src/services/WishlistService';
import { ICONS } from '../src/theme/icons';

type Filter = 'ALL' | 'INCOME' | 'EXPENSE';

interface InvoiceAgg {
  invoiceId: string;
  cardId: string;
  cardName: string;
  dueDate: string;
  referenceMonth: string;
  dueCents: number;
  liveStatus: string;
  items: Array<{ description: string; date: string | null; amountCents: number; sequenceNumber: number | null; totalInstallments: number | null; sourceSystem: string | null }>;
}

type Entry =
  | { kind: 'tx'; date: string; tx: FlowTx }
  | { kind: 'group'; date: string; grp: GroupMonth }
  | { kind: 'invoice'; date: string; inv: InvoiceAgg }
  | { kind: 'installment'; date: string; inst: InstAgg };

const WEEK = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
function weekdayOf(ymd: string): string {
  const { y, m, d } = partsOf(ymd);
  return WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export default function FluxoScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const dataVersion = useAppStore((s) => s.dataVersion); // v49 — GARANTIA: qualquer alteração chama bump() -> dataVersion++ -> cache invalidado
  const [month, setMonth] = React.useState(monthOf(todaySP()));
  const [filter, setFilter] = React.useState<Filter>('ALL');
  const [txs, setTxs] = React.useState<FlowTx[]>([]);
  const [invoicesDue, setInvoicesDue] = React.useState<InvoiceAgg[]>([]);
  const [accountInst, setAccountInst] = React.useState<InstAgg[]>([]);
  // v11: saldos por dia nas DUAS visões (Previsto / Efetivado) — contas "SIM"
  const [dailyBal, setDailyBal] = React.useState<{
    efetivado: Record<string, number>;
    previsto: Record<string, number>;
    openingPrevisto?: number;
  }>({ efetivado: {}, previsto: {} });
  const [showDaily, setShowDaily] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  // v7.1: grupos consolidados
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [childrenMap, setChildrenMap] = React.useState<Record<string, FlowTx[]>>({});
  // v12 (bug A): o consolidado por mês — cabeçalho + ocorrências/parcelas do mês
  const [groupMonths, setGroupMonths] = React.useState<Record<string, GroupMonth>>({});
  // v9: expansor das faturas de cartão
  const [expandedInv, setExpandedInv] = React.useState<Record<string, boolean>>({});
  // v18 (bug 3): ao voltar o foco para o Fluxo, recarrega TUDO (saldos do dia,
  // listas, grupos) — garantia de atualização imediata mesmo que a tela que
  // alterou o dado não tenha propagado o bump.
  const [focusTick, setFocusTick] = React.useState(0);
  // v42 — ORÇAMENTOS e POUPANÇA (flags de Ajustes; cards recolhidos/expandíveis)
  const [budgetsOn, setBudgetsOn] = React.useState(false);
  const [savingsOn, setSavingsOn] = React.useState(false);
  // v70 (BUG 1.1) — LISTA DE DESEJOS: bloco PRÓPRIO no Fluxo (mesma visualização
  // de Orçamento/Poupança, com fechinha) — saiu de dentro do card de Orçamento.
  const [wishlistOn, setWishlistOn] = React.useState(false);
  const [wishMethod, setWishMethod] = React.useState<WishlistMethodology | null>(null);
  const [wishClasses, setWishClasses] = React.useState<WishlistClassView[]>([]);
  const [wishOpen, setWishOpen] = React.useState(false);
  const [wishClassOpen, setWishClassOpen] = React.useState<Record<string, boolean>>({});
  const [budgetSum, setBudgetSum] = React.useState<BudgetMonthSummary | null>(null);
  const [savingsSum, setSavingsSum] = React.useState<SavingsMonthOverview | null>(null);
  // v68: ajustes DIÁRIOS do saldo do dia vindos de Orçamento/Poupança (null = módulo desligado)
  type DayAdjust = { previsto: Record<string, number>; efetivado: Record<string, number> };
  const [budAdj, setBudAdj] = React.useState<DayAdjust | null>(null);
  const [savAdj, setSavAdj] = React.useState<DayAdjust | null>(null);
  const [budgetOpen, setBudgetOpen] = React.useState(false);
  const [savingsOpen, setSavingsOpen] = React.useState(false);
  const [closingBusy, setClosingBusy] = React.useState(false);
  useFocusEffect(
    React.useCallback(() => {
      setFocusTick((t) => t + 1);
    }, [])
  );
  // v21 (bug 4): CONFIRMAÇÃO antes de excluir/alterar — regra pedida pelo usuário
  type ConfirmState =
    | { kind: 'tx'; tx: FlowTx }
    | { kind: 'group'; tx: FlowTx }
    | { kind: 'parcela'; planId: string; sequence: number; description: string }
    | null;
  const [confirm, setConfirm] = React.useState<ConfirmState>(null);

  useDataEffect(async (svc, isCurrent) => {
    // v24: `isCurrent` em TODOS os estágios — carga antiga nunca sobrescreve
    // carga nova (era a fonte do saldo do dia instável ao editar datas).
    try {
      // v21 (bug 2): previsões à vista vencidas viram efetivadas na abertura do Fluxo
      // v50 — promote + ensureForecast em PARALELO (independentes: tabelas diferentes).
      // Antes: sequencial (promote 300ms + forecast 400ms = 700ms). Agora: max(300,400) = 400ms.
      try {
        await Promise.all([
          svc.transactions.promoteDuePendings().catch(() => undefined),
          svc.recurrences.ensureForecastThrough(month).catch(() => undefined),
        ]);
      } catch {
        // best-effort
      }
      if (!isCurrent()) return;
      // v26: o SALDO DO DIA é calculado e pintado PRIMEIRO, isolado do resto da
      // carga — uma falha na lista/grupos/faturas não deixa mais o saldo parado
      // com o valor antigo (as etapas seguintes escreviam o saldo por último).
      try {
        const [dailyDual, show] = await Promise.all([
          svc.balance.getDailyBalancesDual(month, dataVersion), // v49: mesma versão=cache, versão nova=recalcula
          svc.settings.getBool(SETTING_KEYS.fluxoSaldoPorDia, false),
        ]);
        if (!isCurrent()) return;
        setDailyBal(dailyDual);
        setShowDaily(show);
      } catch (err) {
        console.warn('[Fluxo] saldo do dia falhou:', err);
      }
      // v42 — cards de ORÇAMENTO e POUPANÇA (só quando a flag está ligada em Ajustes)
      try {
        const [bFlag, sFlag] = await Promise.all([
          svc.settings.getBool(SETTING_KEYS.budgetsAtivado, false),
          svc.settings.getBool(SETTING_KEYS.poupancaAtivado, false),
        ]);
        if (!isCurrent()) return;
        setBudgetsOn(bFlag);
        setSavingsOn(sFlag);
        // v70 (BUG 1.1) — Lista de Desejos: quando ativa, é um BLOCO PRÓPRIO do
        // Fluxo (ordem: Orçamentos → Lista de Desejos → Poupança). A metodologia
        // (hierarquia Orçamento → Poupança Mensal → Prioridade/Necessário/Desejo
        // → Poupança Fechamento) vai no bloco dela, não no Orçamento.
        const wFlag = await svc.settings.getBool(SETTING_KEYS.wishlistNaHome, false);
        if (!isCurrent()) return;
        setWishlistOn(wFlag);
        const [bSum, sSum] = await Promise.all([
          bFlag ? svc.budgets.getMonthSummary(month) : Promise.resolve(null),
          sFlag ? svc.savings.getMonthOverview(month) : Promise.resolve(null),
        ]);
        if (!isCurrent()) return;
        setBudgetSum(bSum);
        setSavingsSum(sSum);
        if (wFlag) {
          try {
            const [wm, wc] = await Promise.all([
              svc.wishlist.getMethodology(month, { budgetSummary: bSum, savingsOverview: sSum }),
              svc.wishlist.listOpen(),
            ]);
            if (!isCurrent()) return;
            setWishMethod(wm);
            setWishClasses(wc);
          } catch {
            if (isCurrent()) {
              setWishMethod(null);
              setWishClasses([]);
            }
          }
        } else {
          setWishMethod(null);
          setWishClasses([]);
        }
        // v68 — ajustes do SALDO DO DIA: os módulos ativos entram no número
        // (Previsto = base + previsto Orçamento + previsto Poupança; Efetivado
        // idem). Desligado o módulo, o saldo volta a ser o de sempre.
        if (bFlag || sFlag) {
          const scope = await svc.db.getAllAsync<{ id: string }>(
            'SELECT id FROM accounts WHERE include_in_general_balance = 1 AND archived_at IS NULL'
          );
          const scopeIds = scope.map((r) => r.id);
          const [ba, sa] = await Promise.all([
            bFlag ? svc.budgets.getMonthFluxAdjust(month, scopeIds) : Promise.resolve(null),
            sFlag ? svc.savings.getMonthFluxAdjust(month, scopeIds) : Promise.resolve(null),
          ]);
          if (!isCurrent()) return;
          setBudAdj(ba);
          setSavAdj(sa);
        } else {
          setBudAdj(null);
          setSavAdj(null);
        }
      } catch (err) {
        console.warn('[Fluxo] orçamentos/poupança falharam:', err);
      }
      const [rows, invRows, instRows] = await Promise.all([
        svc.transactions.listFlow(month),
        svc.invoices.listInvoicesDueInMonth(month),
        svc.installments.listAccountInstallmentsDueInMonth(month),
      ]);
      if (!isCurrent()) return;
      const allRows = rows as unknown as FlowTx[];
      // v13 (bug 1.A): agregação mensal dos consolidados — cabeçalhos em outros
      // meses são buscados direto do banco (o grupo PERPETUA nos meses seguintes).
      const { gm, occIds, instIds, childrenByGroup } = await buildGroupMonths(svc.db, month, allRows);
      if (!isCurrent()) return;
    const isGroupHeader = (t: FlowTx) => t.kind === 'CONSOLIDATED' && t.source_system !== 'INSTALLMENT';
    // v11 (bug 3.3): lançamentos no CARTÃO (à vista, fixa ou parcela) ficam
    // ESTRITAMENTE atrelados à fatura — não aparecem como despesa comum.
    // v12: ocorrências/parcelas de grupos saem da raiz (entram no card do grupo);
    // cabeçalhos de grupo também (viram entrada própria).
    // v14 (bug 3): a ÂNCORA INTERNA do parcelamento (kind CONSOLIDATED + source
    // INSTALLMENT) NÃO é um lançamento consolidado do usuário — sai da raiz.
    // Era ela que aparecia como um "Consolidado" extra ao criar um parcelado
    // normal (o parcelado em conta já aparece pela própria parcela no mês).
    setTxs(allRows.filter((t) => !t.card_id && t.source_system !== 'INSTALLMENT' && !occIds.has(t.id) && !isGroupHeader(t)));
    setInvoicesDue(
      (invRows as Array<{
        invoice: { id: string; card_id: string; reference_month: string; due_date: string | null };
        cardId: string; cardName: string; dueDate: string; dueCents: number; liveStatus: string;
        items: InvoiceAgg['items'];
      }>).map((i) => ({
        invoiceId: i.invoice.id,
        cardId: i.cardId,
        cardName: i.cardName,
        dueDate: i.dueDate,
        referenceMonth: i.invoice.reference_month,
        dueCents: i.dueCents,
        liveStatus: i.liveStatus,
        items: i.items,
      }))
    );
    setAccountInst((instRows as unknown as InstAgg[]).filter((i) => !instIds.has(i.installmentId)));
    if (!isCurrent()) return;
    setGroupMonths(gm);
    // v13 (2.B): filhos já carregados — o chip de status funciona RECOLHIDO
    setChildrenMap(childrenByGroup);
    setExpanded({});
    } finally {
      // v24: qualquer que seja o desfecho (erro incluído), a tela nunca fica
      // presa no "Carregando..." — e uma carga abandonada não mexe no loading.
      if (isCurrent()) setLoading(false);
    }
  }, [month, focusTick]);

  const isGroup = (t: FlowTx) => t.child_count > 0;

  // ---------- v68→v69: SALDO DO DIA com Orçamento + Poupança (memoizado) ----------
  // Previsto = base + previsto no Orçamento + previsto na Poupança; Efetivado
  // idem. O useMemo recalcula SOMENTE quando os dados carregam (mês/mudança de
  // lançamento/bump) — nunca a cada digitação ou render.
  // v70 (BUGS 1.2/1.3): com Poupança + "Fechamento do mês" ativos, o mês visto
  // a partir da criação do plano é REGIDO pelo fechamento — o saldo carregado
  // dos meses anteriores foi RETIDO para a poupança, então o "Saldo do dia
  // Previsto" NÃO começa com ele (abertura zerada) e o ÚLTIMO dia com
  // lançamento também fecha em R$ 0,00 (o que sobrou virou poupança).
  const closingRegendo = React.useMemo(() => {
    if (!savingsOn) return false;
    const since = savingsSum?.closingSinceMonth ?? null;
    return since != null && month >= since;
  }, [savingsOn, savingsSum, month]);

  // ---------- Agrupamento por dia (v9 + v12) ----------
  // v48 #1 — totais por grupo calculados 1x, não 400x (1 por card). Sem mudar layout: mesmo valor, só cacheado.
  // v63.1 FIX — o useMemo referenciava `gm` (variável que NUNCA existiu como
  // estado — era o destrutura da função de carga) e crashava o Fluxo com
  // ReferenceError no render. O estado correto é `groupMonths` (setGroupMonths(gm)).
  const totalsByGroupV48 = React.useMemo(() => {
    const m = new Map<string, { debits: number; credits: number }>();
    for (const gid of Object.keys(groupMonths)) { m.set(gid, groupMonthTotals(groupMonths[gid])); }
    return m;
  }, [groupMonths]); // v49 GARANTIA: groupMonths é reconstruído do banco a cada bump, então cache invalida quando valor/data muda. Sem valor novo, sem cache velho.
  const entries: Entry[] = React.useMemo(() => {
    const list: Entry[] = [];
    for (const t of txs) list.push({ kind: 'tx', date: t.occurred_on, tx: t });
    // v12 (bug A): o consolidado aparece EM TODO mês com conteúdo — no mês do
    // cabeçalho (linhas à vista) ou onde houver ocorrência/parcela daquele mês.
    for (const grp of Object.values(groupMonths)) {
      const dates: string[] = [];
      if (grp.isHeaderMonth) dates.push(grp.header.occurred_on);
      for (const o of grp.occurrences) dates.push(o.occurred_on);
      for (const i of grp.installments) dates.push(i.dueDate);
      // v19 (bug 1): NO MÊS DO CABEÇALHO o card do consolidado fica na DATA DO
      // CABEÇALHO — alterar a data no formulário reposiciona o lançamento na
      // hora. (Antes: min(data do cabeçalho, ocorrências, parcelas) prendia o
      // card no dia das fixas/parcelas e a nova data "não fazia nada" na tela.)
      const date = grp.isHeaderMonth
        ? grp.header.occurred_on
        : dates.sort()[0] ?? grp.header.occurred_on;
      list.push({ kind: 'group', date, grp });
    }
    for (const inv of invoicesDue) list.push({ kind: 'invoice', date: inv.dueDate, inv });
    for (const inst of accountInst) list.push({ kind: 'installment', date: inst.dueDate, inst });
    return list;
  }, [txs, groupMonths, invoicesDue, accountInst]);

  // v69: ÚLTIMO dia com lançamento (a maior data de débito/crédito do mês
  // visto) — com Poupança + "Fechamento do mês" o saldo previsto dele zera.
  const lastActivityDay = React.useMemo(() => {
    let max = '';
    for (const e of entries) if (e.date > max) max = e.date;
    return max;
  }, [entries]);

  // ---------- v68→v69: SALDO DO DIA com Orçamento + Poupança (memoizado) ----------
  // Previsto = base + previsto no Orçamento + previsto na Poupança; Efetivado
  // idem. O useMemo recalcula SOMENTE quando os dados carregam (mês/mudança de
  // lançamento/bump) — nunca a cada digitação ou render.
  const dailyShown = React.useMemo(() => {
    const prev: Record<string, number> = { ...dailyBal.previsto };
    const efet: Record<string, number> = { ...dailyBal.efetivado };
    // v70 (BUG 1.3) — Fechamento do Mês: o saldo carregado (abertura) foi
    // retido para a poupança — o previsto do mês passa a contar só com os
    // movimentos DE DENTRO do mês visto (abertura zerada; nunca negativa —
    // abertura negativa é dívida real e continua entrando).
    if (closingRegendo) {
      const abertura = Math.max(0, dailyBal.openingPrevisto ?? 0);
      if (abertura > 0) {
        for (const d of Object.keys(prev)) prev[d] = (prev[d] ?? 0) - abertura;
      }
    }
    const days = new Set<string>([
      ...Object.keys(prev),
      ...Object.keys(budAdj?.previsto ?? {}),
      ...Object.keys(savAdj?.previsto ?? {}),
    ]);
    for (const d of days) {
      prev[d] = (prev[d] ?? 0) + (budAdj?.previsto[d] ?? 0) + (savAdj?.previsto[d] ?? 0);
      efet[d] = (efet[d] ?? 0) + (budAdj?.efetivado[d] ?? 0) + (savAdj?.efetivado[d] ?? 0);
    }
    if (lastActivityDay) {
      const budgetRemaining = budgetsOn ? Math.max(0, budgetSum?.remainingCents ?? 0) : 0;
      const wishlistRemaining = wishlistOn
        ? wishClasses.reduce((total, category) => total + category.items.reduce((sum, item) => sum + item.faltaCents, 0), 0)
        : 0;
      prev[lastActivityDay] = subtractAllocationsCents(prev[lastActivityDay] ?? 0, [budgetRemaining, wishlistRemaining]);
    }
    if (closingRegendo && lastActivityDay && (prev[lastActivityDay] ?? 0) > 0) {
      prev[lastActivityDay] = 0;
    }
    return { previsto: prev, efetivado: efet };
  }, [dailyBal, budAdj, savAdj, closingRegendo, lastActivityDay, budgetsOn, budgetSum, wishlistOn, wishClasses]);

  const passesFilter = (e: Entry): boolean => {
    if (filter === 'ALL') return true;
    if (e.kind === 'invoice') return filter === 'EXPENSE';
    // v14 (bug 2): parcela de RECEITA PARCELADA entra no filtro Entradas
    if (e.kind === 'installment')
      return filter === 'EXPENSE' ? e.inst.type !== 'INCOME' : e.inst.type === 'INCOME';
    if (e.kind === 'group') {
      const { debits, credits } = totalsByGroupV48.get(e.grp?.header?.id) ?? groupMonthTotals(e.grp); // v48 cache
      if (filter === 'INCOME') return credits > 0;
      return debits > 0;
    }
    const t = e.tx;
    if (isGroup(t)) {
      if (filter === 'INCOME') return t.group_credits_cents > 0;
      return t.group_debits_cents > 0 || t.type === 'TRANSFER';
    }
    if (filter === 'INCOME') return t.type === 'INCOME';
    return t.type === 'EXPENSE' || t.type === 'TRANSFER';
  };

  const days = React.useMemo(() => {
    const byDay = new Map<string, Entry[]>();
    for (const e of entries) {
      if (!passesFilter(e)) continue;
      const arr = byDay.get(e.date) ?? [];
      arr.push(e);
      byDay.set(e.date, arr);
    }
    return Array.from(byDay.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, filter]);

  // ---------- Exclusão FÍSICA (v10) — v21 (bug 4): exige CONFIRMAÇÃO ----------
  const doExcluirTx = async (tx: FlowTx) => {
    try {
      // v12 (UX): CONSOLIDADO → exclusão do GRUPO INTEIRO (linhas à vista +
      // contas fixas criadas dentro + parcelamentos criados dentro).
      if (tx.kind === 'CONSOLIDATED' && tx.source_system !== 'INSTALLMENT') {
        await services.transactions.deleteGroupDeep(tx.id);
      } else {
        // v10: exclusão física — o registro sai de vez do banco de dados.
        // Ocorrência de conta fixa: apaga APENAS esta (o mês entra nas
        // exclusões da regra e não é recriado).
        await services.transactions.deleteTransaction(tx.id);
      }
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v11 (Req 1): exclusão de PARCELA em conta — regra padrão: da parcela em
   *  diante (pagas ficam intactas e o custo total é recalculado).
   *  v21 (bug 4): só roda após a confirmação, que também oferece "apenas esta". */
  const doExcluirParcela = async (info: { planId: string; sequence: number }, onlyOne: boolean) => {
    try {
      await services.installments.cancelFromSequence(info.planId, info.sequence, { onlyOne });
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v13: expandir/recolher o grupo consolidado — as LINHAS À VISTA já vêm
   *  carregadas junto com o mês (childrenByGroup); expandir é só estado visual.
   *  BUG 1.B resolvido: a expansão NÃO refaz busca nem acumula linhas — o que
   *  aparece é exatamente o conteúdo real do mês do grupo. */
  const toggleGroup = (grp: GroupMonth) => {
    const tx = grp.header;
    setExpanded((cur) => ({ ...cur, [tx.id]: !cur[tx.id] }));
  };

  /** v13 (2.B): status do GRUPO — a ação vale para TODO o agrupamento contido
   *  no card (linhas à vista + ocorrências de fixas em conta + parcelas em
   *  conta; itens de CARTÃO não entram — são pagos pela fatura). */
  const toggleGroupPayment = async (grp: GroupMonth) => {
    const children = childrenMap[grp.header.id] ?? [];
    const info = groupStatusInfo(grp, children);
    if (!info) return;
    const next = !info.allDone;
    const { txs, insts } = groupStatusItems(grp, children);
    try {
      for (const t of txs) {
        await services.transactions.setPaymentStatus(t.id, next);
      }
      for (const i of insts) {
        await services.installments.setPaymentStatus(i.installmentId, next);
      }
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v13 (2.B): chip de status do grupo — MESMO com a setinha RECOLHIDA. */
  const renderGroupStatusChip = (grp: GroupMonth) => {
    const children = childrenMap[grp.header.id] ?? [];
    const info = groupStatusInfo(grp, children);
    if (!info) return null;
    const isIncome = info.isIncome;
    const done = info.allDone;
    const label = isIncome ? (done ? '✓ Recebido' : 'Não recebido') : done ? '✓ Pago' : 'Não pago';
    const cls = isIncome
      ? done
        ? 'bg-emerald-600'
        : 'bg-emerald-50 border border-emerald-300'
      : done
        ? 'bg-rose-600'
        : 'bg-rose-50 border border-rose-300';
    const txt = done ? 'text-white' : isIncome ? 'text-emerald-700' : 'text-rose-700';
    return (
      <Pressable
        onPress={() => toggleGroupPayment(grp)}
        accessibilityRole="button"
        accessibilityLabel={`Status do grupo: ${label}. Toque para alternar para todo o agrupamento.`}
        className={`rounded-full px-2 py-0.5 ${cls}`}
      >
        <Text className={`text-[10px] font-bold ${txt}`}>{label}</Text>
      </Pressable>
    );
  };

  /** v9: alternar Pago/Não pago (despesa) e Recebido/Não recebido (receita). */
  const togglePayment = async (tx: FlowTx) => {
    const nowPaid = tx.status !== 'PENDING';
    try {
      await services.transactions.setPaymentStatus(tx.id, !nowPaid);
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** Long-press de 3 s → duplicar DIRETO (v11, Req 5: sem popup de confirmação). */
  const duplicateTx = (tx: FlowTx) => {
    router.push({ pathname: '/lancamento', params: { dup: tx.id } });
  };

  const amountColor = (tx: FlowTx) =>
    tx.type === 'INCOME' ? 'text-emerald-600' : tx.type === 'TRANSFER' ? 'text-slate-600' : 'text-rose-600';

  /** v10: chip de status Pago/Não pago — despesa VERMELHA; Recebido/Não recebido — receita VERDE. */
  const renderPaymentChip = (tx: FlowTx) => {
    if (tx.status === 'VOIDED') return null;
    if (tx.type !== 'INCOME' && tx.type !== 'EXPENSE') return null;
    if (tx.kind !== 'SIMPLE') return null;
    if (tx.card_id) return null; // compra no cartão é paga pela fatura
    const isIncome = tx.type === 'INCOME';
    const done = tx.status === 'CONFIRMED';
    const label = isIncome ? (done ? '✓ Recebido' : 'Não recebido') : done ? '✓ Pago' : 'Não pago';
    const cls = isIncome
      ? done
        ? 'bg-emerald-600'
        : 'bg-emerald-50 border border-emerald-300'
      : done
        ? 'bg-rose-600'
        : 'bg-rose-50 border border-rose-300';
    const txt = done ? 'text-white' : isIncome ? 'text-emerald-700' : 'text-rose-700';
    return (
      <Pressable
        onPress={() => togglePayment(tx)}
        accessibilityRole="button"
        accessibilityLabel={`${isIncome ? 'Recebido' : 'Pago'}: ${label}. Toque para alternar.`}
        className={`rounded-full px-2 py-0.5 ${cls}`}
      >
        <Text className={`text-[10px] font-bold ${txt}`}>{label}</Text>
      </Pressable>
    );
  };

  /** v10: toggle Pago/Não pago das PARCELAS em conta (mesmo visual dos comuns). */
  const toggleInstallment = async (inst: InstAgg) => {
    try {
      await services.installments.setPaymentStatus(inst.installmentId, inst.status !== 'PAID');
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v11 (Req 1): pode alterar? lançamentos SIMPLES (conta, transferência, fixa,
   *  OFX), LINHAS de grupo, o PRÓPRIO GRUPO e o CABEÇALHO do parcelamento. */
  const canEdit = (tx: FlowTx) =>
    tx.status !== 'VOIDED' && (tx.kind === 'SIMPLE' || isGroup(tx) || tx.source_system === 'INSTALLMENT');

  /** v11: para onde o "Alterar" leva — v21 (bug 1): o parcelado abre a TELA
   *  ESPECÍFICA do plano (todos os campos, conta ou cartão); demais abrem o
   *  formulário padrão. */
  const openAlterar = (tx: FlowTx) => {
    if (tx.source_system === 'INSTALLMENT' && tx.plan_id) {
      router.push({ pathname: '/plano/[id]', params: { id: tx.plan_id } });
      return;
    }
    router.push({ pathname: '/lancamento', params: { edit: tx.id } });
  };

  /** v14 (bug 4) → v67 (BUG 2): o esqueleto ÚNICO virou o COMPONENTE
   *  LancamentoRow (src/components/LancamentoRow.tsx) — usado por TODAS as
   *  linhas do Fluxo (lançamento, parcela, grupo, fatura e os cards de
   *  Orçamento/Poupança). Aqui fica só o adaptador com a assinatura antiga. */
  const renderFlowCard = (a: {
    key: string;
    dashed?: boolean;
    longPress?: (() => void) | null;
    disabled?: boolean;
    arrow?: { open: boolean; onPress: () => void; label: string } | null;
    title: string;
    voided?: boolean;
    subtitle: string;
    /** v19: símbolo do item interno (bolinha ✓ / pill X/N) ANTES da linha de detalhes. */
    subLeading?: React.ReactNode | null;
    chips: React.ReactNode;
    amount: string;
    amountClass: string;
    onAlterar?: (() => void) | null;
    /** v22 (bug 1): botão "+Incluir" do cabeçalho do consolidado. */
    onIncluir?: (() => void) | null;
    onExcluir?: (() => void) | null;
  }) => (
    <LancamentoRow
      key={a.key}
      dashed={a.dashed}
      longPress={a.longPress}
      disabled={a.disabled}
      arrow={a.arrow}
      title={a.title}
      voided={a.voided}
      subtitle={a.subtitle}
      subLeading={a.subLeading}
      chips={a.chips}
      amount={a.amount}
      amountClass={a.amountClass}
      onAlterar={a.onAlterar}
      onIncluir={a.onIncluir}
      onExcluir={a.onExcluir}
    />
  );

  /** v14: MESMO card para todo lançamento comum (à vista, fixa, transferência,
   *  OFX, NFC-e e as LINHAS do grupo — com recuo tracejado). */
  const renderTxCard = (tx: FlowTx, opts: { child?: boolean }) => {
    const hasPill = tx.plan_total_installments != null && tx.plan_total_installments > 1;
    // v19: item interno leva o marcador (bolinha ✓ de conta fixa / pill X/N de
    // parcela) para a LINHA DE DETALHES, alinhado ao texto — e não tem linha de
    // chips própria (o status é comandado pelo cabeçalho do grupo, v16).
    const childMarker =
      opts.child && (tx.source_system === 'RECURRENCE' || tx.recurrence_rule_id || hasPill) ? (
        <>
          {tx.source_system === 'RECURRENCE' || tx.recurrence_rule_id ? <FixedDot size={14} /> : null}
          {hasPill ? <InstallmentPill current={(tx.plan_paid_count ?? 0) + 1} total={tx.plan_total_installments ?? 1} /> : null}
        </>
      ) : null;
    return renderFlowCard({
      key: tx.id,
      dashed: opts.child,
      longPress: opts.child || isGroup(tx) ? null : () => duplicateTx(tx),
      disabled: tx.status === 'VOIDED',
      title: tx.description,
      voided: tx.status === 'VOIDED',
      subtitle:
        `${ymdToBr(tx.occurred_on)}` +
        `${tx.category_name ? ` · ${tx.category_name}` : ''}` +
        `${tx.card_name ? ` · ${tx.card_name}` : ''}` +
        `${tx.account_name && tx.type === 'TRANSFER' ? ` · ${tx.account_name} → ${tx.transfer_account_name}` : tx.account_name ? ` · ${tx.account_name}` : ''}`,
      subLeading: childMarker,
      chips: (
        <>
          {!opts.child && (tx.source_system === 'RECURRENCE' || tx.recurrence_rule_id) ? <FixedDot /> : null}
          {!opts.child && hasPill ? (
            <InstallmentPill
              current={(tx.plan_paid_count ?? 0) + 1}
              total={tx.plan_total_installments ?? 1}
            />
          ) : null}
          {!opts.child ? (
            <Text className="text-[10px] text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">{sourceLabel(tx.source_system)}</Text>
          ) : null}
          {/* v16 (melhoria 1): itens AGLUTINADOS no grupo NÃO têm botão de status
              individual — o controle é exclusivo do CABEÇALHO do grupo. Só o
              marcador de excluído permanece nos filhos. */}
          {!opts.child && tx.status === 'VOIDED' ? <Badge status="VOIDED" /> : !opts.child ? renderPaymentChip(tx) : null}
        </>
      ),
      // Semântica de cores: verde = receita, vermelho = despesa, cinza = transferência
      amount: `${tx.type === 'INCOME' ? '+' : tx.type === 'TRANSFER' ? '⇄ ' : '−'}${formatBRL(tx.amount_cents)}`,
      amountClass: `${amountColor(tx)} ${tx.status === 'VOIDED' ? 'line-through opacity-50' : ''}`,
      onAlterar: canEdit(tx) ? () => openAlterar(tx) : null,
      // v21 (bug 4): exclusão pede confirmação (modal)
      onExcluir: () =>
        tx.kind === 'CONSOLIDATED' && tx.source_system !== 'INSTALLMENT'
          ? setConfirm({ kind: 'group', tx })
          : setConfirm({ kind: 'tx', tx }),
    });
  };

  /** v14: card do CONSOLIDADO no mês — MESMO ESQUELETO dos demais cards (bug 4):
   *  setinha + título + data/detalhes + chips à esquerda; SALDO do mês à direita
   *  com Alterar/Excluir nos MESMOS pontos dos outros cards (a ação vale para
   *  TODO o grupo). Aparece EM TODO mês com conteúdo (linhas à vista no mês do
   *  cabeçalho + ocorrências das fixas + parcelas) e segue O PADRÃO ÚNICO
   *  independentemente do subtipo Fixo ou Parcelado (melhoria 1):
   *   · v13 (2.B mantido): chip de status MESMO RECOLHIDO, alterna o agrupamento
   *     inteiro de uma vez;
   *   · v13 (bug 1.B mantido): a expansão lista EXATAMENTE os itens reais do mês,
   *     todos no formato unificado de filho (recuo tracejado).
   *   · v17 (melhoria 2): os chips seguem o MESMO padrão dos lançamentos
   *     normais equivalentes, na MESMA LINHA — [✓ (fixa)] [Pill 3/12 (parcela)]
   *     [FIXO / PARCELADO] [Status Pago/Não pago ou Recebido/Não recebido]. */
  const renderGroupCard = (grp: GroupMonth) => {
    const tx = grp.header;
    const isOpen = !!expanded[tx.id];
    const children = childrenMap[tx.id] ?? [];
    // SALDO do mês = (créditos − débitos) incluindo fixas e parcelas do mês
    // (v14: parcelas de RECEITA PARCELADA entram como crédito)
    const { debits, credits } = totalsByGroupV48.get((grp as any)?.header?.id) ?? groupMonthTotals(grp); // v48 cache
    const groupSaldo = credits - debits;
    const saldoCor = groupSaldo > 0 ? 'text-emerald-600' : groupSaldo < 0 ? 'text-rose-600' : 'text-slate-500';
    // Itens EXATOS do mês — o que a expansão mostra é isto (bug 1.B)
    const itemCount = (grp.isHeaderMonth ? tx.child_count : 0) + grp.occurrences.length + grp.installments.length;
    // v17 (melhoria 2) substituída pela v18 (melhoria 1): o CABEÇALHO fica
    // LIMPO — sem texto nem iconografia de Fixo/Parcelado. Os marcadores
    // padrão (bolinha ✓, pill X/N, status) ficam EXCLUSIVAMENTE nos itens
    // internos do agrupamento (expandir o grupo mostra cada um com seu chip).
    return (
      <View key={tx.id} className="gap-1.5">
        {renderFlowCard({
          key: tx.id,
          arrow: {
            open: isOpen,
            onPress: () => toggleGroup(grp),
            label: isOpen ? `Recolher grupo ${tx.description}` : `Expandir grupo ${tx.description}`,
          },
          disabled: tx.status === 'VOIDED',
          voided: tx.status === 'VOIDED',
          title: tx.description,
          subtitle: `${ymdToBr(tx.occurred_on)} · ${itemCount} item(ns) neste mês`,
          chips: (
            <>
              <Text className="text-[10px] text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded font-semibold">
                {ICONS.consolidado} CONSOLIDADO
              </Text>
              {tx.source_system !== 'MANUAL' ? (
                <Text className="text-[10px] text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">{sourceLabel(tx.source_system)}</Text>
              ) : null}
              {/* Status do grupo visível MESMO com a setinha RECOLHIDA —
                  tocar alterna Pago/Não pago para TODO o agrupamento do card */}
              {tx.status === 'VOIDED' ? <Badge status="VOIDED" /> : renderGroupStatusChip(grp)}
            </>
          ),
          amount: `Saldo: ${formatBRL(groupSaldo)}`,
          amountClass: saldoCor,
          onAlterar: () => router.push({ pathname: '/lancamento', params: { edit: tx.id } }),
          // v22 (bug 1): "+Incluir" abre o Novo Lançamento EM MODAL no modo
          // "incluir no grupo" — as linhas novas passam a compor o saldo dele
          onIncluir: () => router.push({ pathname: '/incluir-grupo', params: { grupo: tx.id } }),
          onExcluir: () => setConfirm({ kind: 'group', tx }),
        })}
        {isOpen ? (
          <View className="gap-1.5">
            {/* Expansão = itens reais do mês: linhas à vista (só no mês do
                cabeçalho) + ocorrências das fixas + parcelas em conta — todos
                no MESMO formato unificado (v14). */}
            {grp.isHeaderMonth && children.length > 0
              ? children.map((ch) => renderTxCard(ch, { child: true }))
              : null}
            {grp.occurrences.map((ch) => renderTxCard(ch, { child: true }))}
            {grp.installments.map((inst) => renderInstallmentRow(inst, { child: true }))}
          </View>
        ) : null}
      </View>
    );
  };

  /** v9: fatura do cartão AGLUTINADA na data de vencimento, com expansor.
   *  v67 (BUG 2): usa o MESMO esqueleto LancamentoRow das demais linhas
   *  (setinha rose, corpo pressável, rodapé com os itens). */
  const renderInvoiceCard = (inv: InvoiceAgg) => {
    const isOpen = !!expandedInv[inv.invoiceId];
    const paid = inv.liveStatus === 'PAID';
    return (
      <LancamentoRow
        key={`inv-${inv.invoiceId}`}
        arrow={{
          open: isOpen,
          onPress: () => setExpandedInv((cur) => ({ ...cur, [inv.invoiceId]: !isOpen })),
          label: isOpen ? `Recolher fatura ${inv.cardName}` : `Ver lançamentos da fatura ${inv.cardName}`,
          tone: 'rose',
        }}
        onBodyPress={() => router.push(`/cartoes/${inv.cardId}/fatura/${inv.referenceMonth}`)}
        title={`${ICONS.cartoes} Fatura ${inv.cardName}`}
        voided={paid}
        subtitle={`Vence ${ymdToBr(inv.dueDate)} · ${inv.items.length} lançamento(s) ${paid ? '· quitada' : '· total − antecipados'}`}
        chips={
          <>
            <Badge status={inv.liveStatus} />
            <Text className="text-[10px] text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">FATURA</Text>
          </>
        }
        amount={`−${formatBRL(inv.dueCents)}`}
        amountClass={paid ? 'text-slate-400 line-through' : 'text-rose-600'}
        borderClass={paid ? 'border-slate-200' : 'border-rose-300'}
        footerOpen={isOpen}
        footer={
          inv.items.length === 0 ? (
            <Text className="text-xs text-slate-400">Sem lançamentos nesta fatura.</Text>
          ) : (
            <>
              {inv.items.map((it, idx) => (
                <View key={`${inv.invoiceId}-it-${idx}`} className="flex-row justify-between items-center gap-2">
                  <View className="flex-1 flex-row items-center gap-1.5">
                    {/* v16 (bug 3): CONTA FIXA no cartão com a MESMA iconografia
                        padrão do app (bolinha ✓ preta) — igual à tela da fatura */}
                    {it.sourceSystem === 'RECURRENCE' ? <FixedDot size={14} /> : null}
                    {it.sequenceNumber != null && it.totalInstallments != null ? (
                      <InstallmentPill current={it.sequenceNumber} total={it.totalInstallments} />
                    ) : null}
                    {/* v10: descrição do item SEM truncamento (detalhe da fatura) */}
                    <Text className="text-xs text-slate-700 flex-1 flex-shrink">
                      {it.description}
                      {it.date ? ` · ${ymdToBr(it.date)}` : ''}
                    </Text>
                  </View>
                  <Text className="text-xs font-bold text-rose-600">−{formatBRL(it.amountCents)}</Text>
                </View>
              ))}
              <Pressable
                onPress={() => router.push(`/cartoes/${inv.cardId}/fatura/${inv.referenceMonth}`)}
                className="mt-1 self-start bg-slate-100 rounded-lg px-2.5 py-1.5"
              >
                <Text className="text-xs font-semibold text-slate-600">Abrir fatura completa</Text>
              </Pressable>
            </>
          )
        }
      />
    );
  };

  /** v14 (bug 4): parcela de PARCELADO em CONTA — MESMO card dos demais (mesmo
   *  esqueleto, mesmas informações nos mesmos lugares): pill X/N + chip de
   *  status + valor à direita com Alterar/Excluir.
   *  v14 (bug 2): RECEITA PARCELADA — chip "Recebido/Não recebido" e sinal
   *  +/verde (antes toda parcela era tratada como despesa). */
  const renderInstStatusChip = (inst: InstAgg) => {
    const paid = inst.status === 'PAID';
    const isIncome = inst.type === 'INCOME';
    const label = isIncome ? (paid ? '✓ Recebido' : 'Não recebido') : paid ? '✓ Pago' : 'Não pago';
    const cls = isIncome
      ? paid
        ? 'bg-emerald-600'
        : 'bg-emerald-50 border border-emerald-300'
      : paid
        ? 'bg-rose-600'
        : 'bg-rose-50 border border-rose-300';
    const txt = paid ? 'text-white' : isIncome ? 'text-emerald-700' : 'text-rose-700';
    return (
      <Pressable
        onPress={() => toggleInstallment(inst)}
        accessibilityRole="button"
        accessibilityLabel={paid ? 'Parcela paga. Toque para marcar como não paga.' : 'Parcela em aberto. Toque para marcar como paga.'}
        className={`rounded-full px-2 py-0.5 ${cls}`}
      >
        <Text className={`text-[10px] font-bold ${txt}`}>{label}</Text>
      </Pressable>
    );
  };

  const renderInstallmentRow = (inst: InstAgg, opts: { child?: boolean } = {}) => {
    const paid = inst.status === 'PAID';
    const isIncome = inst.type === 'INCOME';
    const pill = <InstallmentPill current={inst.sequenceNumber} total={inst.totalInstallments} />;
    return renderFlowCard({
      key: `inst-${inst.installmentId}`,
      dashed: opts.child,
      title: inst.description,
      subtitle:
        `${ymdToBr(inst.dueDate)} · parcela em conta` +
        `${inst.accountName ? ` · ${inst.accountName}` : ''}` +
        `${paid ? ' · paga' : ' · previsão'}`,
      // v19: pill X/N ANTES da linha de detalhes nos itens internos do grupo
      subLeading: opts.child ? pill : null,
      chips: (
        <>
          {!opts.child ? pill : null}
          {!opts.child ? (
            <Text className="text-[10px] text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">{sourceLabel('INSTALLMENT')}</Text>
          ) : null}
          {/* v16 (melhoria 1): parcela DENTRO do grupo não tem botão próprio —
              o status é comandado pelo cabeçalho do consolidado */}
          {!opts.child ? renderInstStatusChip(inst) : null}
        </>
      ),
      amount: `${isIncome ? '+' : '−'}${formatBRL(inst.amountCents)}`,
      amountClass: paid ? 'text-slate-400' : isIncome ? 'text-emerald-600' : 'text-rose-600',
      // v21 (bug 1): "Alterar" abre a TELA do plano (todos os campos)
      onAlterar: () => router.push({ pathname: '/plano/[id]', params: { id: inst.planId } }),
      // v18 (bug 4): parcela PAGA não oferece Excluir (pagas nunca são excluídas —
      // era a fonte do erro "Não há parcelas em aberto" ao excluir pagamento)
      // v21 (bug 4): exclusão pede confirmação (modal com escopo)
      onExcluir: paid
        ? null
        : () => setConfirm({ kind: 'parcela', planId: inst.planId, sequence: inst.sequenceNumber, description: inst.description }),
    });
  };

  const renderEntry = (e: Entry) => {
    if (e.kind === 'invoice') return renderInvoiceCard(e.inv);
    if (e.kind === 'installment') return renderInstallmentRow(e.inst);
    if (e.kind === 'group') return renderGroupCard(e.grp);
    return renderTxCard(e.tx, { child: false });
  };

  // ---------- v42→v68: cards aglutinados ORÇAMENTO e POUPANÇA (flag de Ajustes) ----------

  /** Confirma a estimativa de poupança do fechamento (card expandido). */
  const confirmClosingHere = async (amountCents: number) => {
    setClosingBusy(true);
    try {
      await services.savings.confirmClosing(month, amountCents);
      showToast(`Poupança de ${formatBRL(amountCents)} criada (transferência no fim do mês)`);
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setClosingBusy(false);
    }
  };

  /** v42 → v68 (BUGS 1 e 2): cards aglutinados de ORÇAMENTO e POUPANÇA no
   *  MESMO esqueleto LancamentoRow das demais linhas. Expandidos:
   *   · ORÇAMENTO mostra "Orçado • Previsto • Gasto" por orçamento e no total
   *     (Orçado = limite cadastrado; Previsto = pendentes; Gasto = efetivados);
   *   · POUPANÇA mostra o PLANO CADASTRADO: nome, modalidade, valor e
   *     guardado/falta.
   *  A linha de orçamentos do cabeçalho dos dias SAIU — a participação
   *  do orçamento agora é DENTRO do saldo do dia (v68 BUG 1). */
  const budgetCard = budgetsOn ? (
    <LancamentoRow
      key="card-orcamento"
      arrow={{ open: budgetOpen, onPress: () => setBudgetOpen((v) => !v), label: budgetOpen ? 'Recolher orçamento' : 'Expandir orçamento' }}
      title={`${ICONS.orcamento} Orçamento`}
      subtitle={budgetSum && budgetSum.items.length > 0 ? `${budgetSum.items.length} orçamento(s) ativo(s) no mês` : 'Nenhum orçamento ativo'}
      amount={formatBRL(budgetSum?.remainingCents ?? 0)}
      amountClass={(budgetSum?.remainingCents ?? 0) < 0 ? 'text-rose-600' : 'text-emerald-700'}
      footer={
        budgetSum && budgetSum.items.length > 0 ? (
          <View className="gap-1.5">
            {/* v69 (BUG 3): "Orçado • Previsto • Gasto" TUDO NA MESMA LINHA, com
                porcentagem por movimento (número redondo, sem decimal) */}
            <Text className="text-[11px] text-slate-500">
              {orcadoPrevistoGastoLinha(budgetSum.budgetedCents, budgetSum.previstoCents, budgetSum.efetivadoCents)} · falta {formatBRL(budgetSum.remainingCents)}
            </Text>
            {budgetSum.items.map((it) => (
              <LancamentoRow
                key={it.budgetId}
                dashed
                title={it.label}
                subtitle={orcadoPrevistoGastoLinha(it.amountCents, it.previstoCents, it.efetivadoCents)}
                amount={`falta ${formatBRL(it.remainingCents)}`}
                amountClass={it.remainingCents < 0 ? 'text-rose-600' : 'text-slate-700'}
                footer={<ProgressBar pct={it.pct} />}
              />
            ))}
            {/* v70 (BUG 1.1): a METODOLOGIA da Lista de Desejos SAIU daqui —
                virou bloco PRÓPRIO no Fluxo (ordem: Orçamento → Lista de
                Desejos → Poupança), com a mesma fechinha de expandir. */}
          </View>
        ) : (
          <Text className="text-xs text-slate-500">Nenhum orçamento ativo — cadastre em Ações rápidas › Orçamento.</Text>
        )
      }
      footerOpen={budgetOpen}
      onCadastrar={() => router.push('/orcamento')}
      cadastrarLabel="Cadastrar / alterar orçamentos ›"
    />
  ) : null;

  // ---------- v70 (BUG 1.1 + MELHORIA 2.1): BLOCO PRÓPRIO da LISTA DE DESEJOS
  // (mesma visualização de Orçamento/Poupança: fechinha para expandir) —
  // saiu de DENTRO do card de Orçamento. Ordem no Fluxo: Orçamentos →
  // Lista de Desejos → Poupança. Mostra as classificações (Prioridade >
  // Necessário > Desejo) com itens, barra de progressão e o texto sucinto
  // de meses para comprar; o cadastro segue na tela da Lista de Desejos. */
  const wishTotalCents = wishClasses.reduce((a, c) => a + c.totalCents, 0);
  const wishTotalItens = wishClasses.reduce((a, c) => a + c.itemCount, 0);
  const wishlistCard = wishlistOn ? (
    <LancamentoRow
      key="card-lista-desejos"
      arrow={{ open: wishOpen, onPress: () => setWishOpen((v) => !v), label: wishOpen ? 'Recolher lista de desejos' : 'Expandir lista de desejos' }}
      title={`${ICONS.listaDesejos} Lista de Desejos`}
      subtitle={wishTotalItens > 0 ? `${wishTotalItens} item(ns) na lista` : 'Nenhum item cadastrado'}
      amount={formatBRL(wishTotalCents)}
      amountClass={wishTotalCents > 0 ? 'text-violet-700' : 'text-slate-900'}
      footer={
        <View className="gap-1.5">
          {/* v70 (MELHORIA 2.6): texto SUCCINTO — meses para comprar */}
          {wishMethod && (wishMethod.monthsPrioridade != null || wishMethod.monthsTotal != null) ? (
            <Text className="text-xs text-slate-700">
              {[wishMethod.messagePrioridade, wishMethod.messageTotal].filter(Boolean).join(' ')}
            </Text>
          ) : null}
          {wishMethod ? (
            <Text className="text-[11px] text-slate-500">
              Sobra do mês {formatBRL(wishMethod.sobraCents)} — Prioridade › Necessário › Desejo; o que sobrar é da Poupança Fechamento do Mês.
            </Text>
          ) : null}
          {wishClasses.filter((c) => c.itemCount > 0).map((c) => {
            const clsOpen = !!wishClassOpen[c.cls];
            return (
              <View key={c.cls} className="gap-1">
                <LancamentoRow
                  arrow={{
                    open: clsOpen,
                    onPress: () => setWishClassOpen((cur) => ({ ...cur, [c.cls]: !clsOpen })),
                    label: clsOpen ? `Recolher ${c.label}` : `Expandir ${c.label}`,
                  }}
                  dashed
                  title={c.label}
                  subtitle={`Total ${formatBRL(c.totalCents)} — ${c.itemCount} item(ns)`}
                  amount={formatBRL(c.totalCents)}
                  amountClass="text-slate-900"
                  footerOpen={clsOpen}
                  footer={
                    <View className="gap-1">
                      {c.items.map((it) => (
                        <View key={it.id} className="gap-0.5">
                          <View className="flex-row justify-between items-center gap-2">
                            <Text className="text-xs text-slate-700 flex-1" numberOfLines={1}>
                              {it.description}{it.pronto ? ' · ✓ Pronto para comprar' : ''}
                            </Text>
                            <Text className="text-xs font-semibold text-slate-800">{formatBRL(it.target_cents)}</Text>
                          </View>
                          <Text className="text-[10px] text-slate-400">
                            reservado {formatBRL(it.reserved_cents)} · falta {formatBRL(it.faltaCents)}
                          </Text>
                          <ProgressBar pct={it.pct} />
                        </View>
                      ))}
                    </View>
                  }
                />
              </View>
            );
          })}
          <Button label="Cadastrar / alterar itens ›" variant="outline" onPress={() => router.push('/lista-desejos')} />
        </View>
      }
      footerOpen={wishOpen}
      onCadastrar={() => router.push('/lista-desejos')}
      cadastrarLabel="Cadastrar / alterar itens ›"
    />
  ) : null;

  const savingsCard = savingsOn ? (
    <LancamentoRow
      key="card-poupanca"
      arrow={{ open: savingsOpen, onPress: () => setSavingsOpen((v) => !v), label: savingsOpen ? 'Recolher poupança' : 'Expandir poupança' }}
      title={`${ICONS.poupanca} Poupança`}
      // v69 (BUG do cabeçalho): o PLANO cadastrado aparece no cabeçalho —
      // planos contam mesmo sem entradas no mês (Fechamento do mês não cria
      // previsão) e o valor mostrado é o PROGRAMADO (previsões + estimativa
      // do saldo que sobraria no fim do mês) — nunca mais "R$ 0,00" +
      // "Nenhum plano cadastrado" com plano ativo.
      subtitle={
        savingsSum && savingsSum.plans.length > 0
          ? `${savingsSum.plans.length} plano(s) cadastrado(s)`
          : savingsSum && savingsSum.entries.length > 0
            ? `${savingsSum.entries.length} entrada(s) no mês`
            : 'Nenhum plano de poupança'
      }
      amount={formatBRL(savingsSum?.programadoCents ?? 0)}
      amountClass={(savingsSum?.programadoCents ?? 0) < 0 ? 'text-rose-600' : 'text-slate-900'}
      footer={
        savingsSum && (savingsSum.plans.length > 0 || savingsSum.entries.length > 0) ? (
          <View className="gap-1.5">
            {/* v67 (BUG 1): rótulos EXCLUSIVOS da poupança — não competem com o
                "Saldo do dia Previsto/Efetivado" do cabeçalho dos dias.
                v69 (BUGS): "Programado p/ poupança" = saldo que SOBRARIA no fim
                do mês quando "Fechamento do mês" está cadastrado (previsões +
                estimativa); "Falta transferir" = programado − já transferido
                (ex.: preciso transferir 10 mil, transferei 500 → 9.500);
                "Já transferido" = transferências CONFIRMADAS do mês. */}
            <View className="flex-row justify-between">
              <Text className="text-sm text-slate-700">Programado p/ poupança</Text>
              <Text className="text-sm font-semibold text-slate-900">{formatBRL(savingsSum.programadoCents)}</Text>
            </View>
            <View className="flex-row justify-between">
              <Text className="text-sm text-slate-700">Falta transferir</Text>
              <Text className="text-sm font-semibold text-amber-700">{formatBRL(savingsSum.remainingCents)}</Text>
            </View>
            <View className="flex-row justify-between">
              <Text className="text-sm text-slate-700">Já transferido p/ poupança</Text>
              <Text className="text-sm font-semibold text-emerald-700">{formatBRL(savingsSum.effectedCents)}</Text>
            </View>
            {/* v68 (BUG 3): o PLANO CADASTRADO — nome, modalidade, valor e
                guardado/falta (era isso que faltava ao expandir) */}
            {savingsSum.plans.map((p) => (
              <LancamentoRow
                key={p.planId}
                dashed
                title={p.name}
                subtitle={`Modalidade: ${p.modalityLabel} · Valor: ${p.amountCents != null ? formatBRL(p.amountCents) : 'o restante do mês'}`}
                amount={`falta ${formatBRL(p.faltaCents)}`}
                amountClass={p.faltaCents > 0 ? 'text-amber-700' : 'text-emerald-700'}
                chips={
                  <Text className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                    guardado {formatBRL(p.guardadoCents)}
                  </Text>
                }
              />
            ))}
            {savingsSum.closingSuggestion ? (
              <View className="border border-emerald-200 rounded-lg p-2 gap-1.5">
                <Text className="text-xs text-slate-600">
                  Fechamento: o saldo previsto do fim do mês está em {formatBRL(savingsSum.closingSuggestion.amountCents)} — virou estimativa.
                </Text>
                <Button
                  label={`Poupar ${formatBRL(savingsSum.closingSuggestion.amountCents)} (transferência no fim do mês)`}
                  variant="outline"
                  loading={closingBusy}
                  onPress={() => confirmClosingHere(savingsSum.closingSuggestion!.amountCents)}
                />
              </View>
            ) : null}
            {savingsSum.entries.filter((e) => e.effected).slice(0, 5).map((e) => (
              <LancamentoRow
                key={e.id}
                dashed
                title={e.description ?? 'Poupança'}
                subtitle={e.date ? `Transferido em ${ymdToBr(e.date)}` : 'Transferência da poupança'}
                amount={formatBRL(e.amountCents)}
                amountClass="text-emerald-700"
              />
            ))}
          </View>
        ) : (
          <Text className="text-xs text-slate-500">Nenhum plano de poupança — cadastre em Ações rápidas › Poupança.</Text>
        )
      }
      footerOpen={savingsOpen}
      onCadastrar={() => router.push('/poupanca')}
      cadastrarLabel="Cadastrar / alterar poupança ›"
    />
  ) : null;

  // ---------- v11 (Req 2): topo SEM "Saldo Consolidado" e SEM os textos
  //  "Saldo Efetivado"/"Saldo Previsto" — fica só o seletor de Mês/Ano ----------
  const headerArea = (
    <View className="gap-2">
      {/* Seletor de Mês/Ano FIXO no layout (não rola com a lista) —
          tocar em um mês ANIMA o chip até o CENTRO da barra */}
      <MonthScroller value={month} onChange={setMonth} />
    </View>
  );

  return (
    <Screen title="Fluxo" headerArea={headerArea}>
      <Segmented<Filter>
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'ALL', label: 'Tudo' },
          { value: 'INCOME', label: 'Entradas' },
          { value: 'EXPENSE', label: 'Saídas' },
        ]}
      />

      {/* v67 (MELHORIA 3): os atalhos "Parcelamentos" e "Recorrências" saíram
          DESTE tela ( Fluxo ) — os dados e a lógica continuam intactos: as
          contas fixas e parcelas seguem aparecendo na lista do mês normalmente
          (ocorrências, parcelas e faturas), e as telas continuam acessíveis
          pela Home (Ações rápidas). */}

      {/* v42: cards aglutinados ligados em Ajustes — v70 (MELHORIA 2.1): a
          ORDEM é Orçamentos → Lista de Desejos → Poupança; a Lista de Desejos
          é um BLOCO PRÓPRIO (v70 BUG 1.1), independente do Orçamento. */}
      {budgetCard}
      {wishlistCard}
      {savingsCard}

      {loading ? <Card><Text className="text-slate-500">Carregando...</Text></Card> : null}

      {!loading && days.length === 0 ? (
        <EmptyState icon="🗓" title="Sem lançamentos no mês" hint="Registre um lançamento manual ou importe um OFX." />
      ) : null}

      {/* v9: agrupamento por dia — com "Exibir saldo por dia" ativo, CADA dia
          mostra as DUAS visões (v11): Previsto e Efetivado.
          v67 (BUG 1): cabeçalho do dia em LINHAS EMPILHADAS — o saldo do dia
          (Previsto/Efetivado) tem linha PRÓPRIA.
          v68 (BUGS 1 e 4): a linha de orçamentos SAIU daqui — o orçamento e a
          poupança agora fazem PARTE do número: Previsto = do jeito que está +
          previsto no Orçamento + previsto na Poupança; Efetivado = do jeito
          que está + efetivado no Orçamento + efetivado na Poupança. Na
          modalidade Fechamento do Mês nada é somado/subtraído à força — o
          restante do saldo é que é da poupança. */}
      {!loading
        ? days.map(([day, list]) => {
            const prev = dailyShown.previsto[day];
            const efet = dailyShown.efetivado[day];
            return (
              <View key={day} className="gap-1.5">
                <View className="flex-row justify-between items-start mt-1 gap-2">
                  <Text className="text-xs font-bold uppercase tracking-wide text-slate-500 mt-0.5">
                    {ymdToBr(day).slice(0, 5)} · {weekdayOf(day)}
                  </Text>
                  {showDaily && prev != null ? (
                    <View className="items-end gap-0.5 shrink">
                      <Text className={`text-xs font-bold ${prev < 0 ? 'text-rose-600' : 'text-slate-700'}`}>
                        Saldo do dia Previsto: {formatBRL(prev)}
                      </Text>
                      {efet != null ? (
                        <Text className={`text-[11px] font-semibold ${efet < 0 ? 'text-rose-500' : 'text-slate-500'}`}>
                          Saldo do dia Efetivado: {formatBRL(efet)}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>
                {list.map(renderEntry)}
              </View>
            );
          })
        : null}

      {days.length > 0 ? (
        <Text className="text-[11px] text-slate-400 text-center px-8">
          Dica: segure um lançamento por 3 segundos para duplicar. Use "Alterar" para editar; toque no status para marcar Pago/Recebido. Faturas: toque na seta para ver os lançamentos.
        </Text>
      ) : null}

      {/* v21 (bug 4): CONFIRMAÇÃO de exclusão/alteração — modal antes de efetivar */}
      <ConfirmDialog
        visible={confirm?.kind === 'tx'}
        title="Excluir lançamento?"
        message={
          confirm?.kind === 'tx'
            ? `"${confirm.tx.description}" sai definitivamente do app (movimento no banco incluído).`
            : undefined
        }
        buttons={[
          {
            label: 'Excluir',
            color: 'red',
            onPress: () => {
              if (confirm?.kind === 'tx') doExcluirTx(confirm.tx);
              setConfirm(null);
            },
          },
          { label: 'Cancelar', color: 'green', onPress: () => setConfirm(null) },
        ]}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        visible={confirm?.kind === 'group'}
        title="Excluir a operação consolidada?"
        message={
          confirm?.kind === 'group'
            ? `"${confirm.tx.description}": o GRUPO INTEIRO será apagado — linhas à vista, contas fixas criadas dentro e parcelamentos em aberto. Parcelas já pagas permanecem no histórico.`
            : undefined
        }
        buttons={[
          {
            label: 'Excluir o grupo inteiro',
            color: 'red',
            onPress: () => {
              if (confirm?.kind === 'group') doExcluirTx(confirm.tx);
              setConfirm(null);
            },
          },
          { label: 'Cancelar', color: 'green', onPress: () => setConfirm(null) },
        ]}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        visible={confirm?.kind === 'parcela'}
        title="Excluir parcela(s) em aberto?"
        message={
          confirm?.kind === 'parcela'
            ? `Parcelas JÁ PAGAS nunca são excluídas — só as em aberto a partir da escolha. O custo total é recalculado (pagas + restante).`
            : undefined
        }
        buttons={
          confirm?.kind === 'parcela'
            ? [
                {
                  label: `Excluir apenas a ${confirm.sequence}º parcela`,
                  color: 'red',
                  onPress: () => {
                    doExcluirParcela({ planId: confirm.planId, sequence: confirm.sequence }, true);
                    setConfirm(null);
                  },
                },
                {
                  label: `Excluir da ${confirm.sequence}º em diante`,
                  color: 'red',
                  onPress: () => {
                    doExcluirParcela({ planId: confirm.planId, sequence: confirm.sequence }, false);
                    setConfirm(null);
                  },
                },
                { label: 'Cancelar', color: 'green', onPress: () => setConfirm(null) },
              ]
            : []
        }
        onClose={() => setConfirm(null)}
      />
    </Screen>
  );
}
