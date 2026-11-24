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
 *     · o "Saldo do dia Previsto/Efetivado" incorpora os ajustes de Orçamento
 *       e Poupança. No último lançamento do mês, o previsto aplica a hierarquia:
 *       Orçamento → Programação de Compras → Poupança Mensal → Fechamento.
 *       Os cálculos são MEMOIZADOS (useMemo) — recalculam só quando mudam
 *       dados/mês, nunca a cada digitação.
 *  · v69 (BUGS Poupança):
 *     · o cabeçalho do card MOSTRA O PLANO — subtitle conta os planos
 *       cadastrados (não só as entradas do mês) e o valor é o PROGRAMADO
 *       (previsões + estimativa do Fechamento do Mês — o saldo que sobraria
 *       no fim do mês), nunca mais "R$ 0,00" com plano ativo;
 *     · v90 — card da Poupança ficou ENXUTO: por plano só nome +
 *       "Guardado X de Y" + barra; nada de linhas repetindo "Programado /
 *       Falta / Já transferido" (eram repetição do próprio cabeçalho),
 *       nem modalidade, nem últimas 5 transferências;
 *     · "Orçado • Previsto • Gasto" TUDO NA MESMA LINHA com porcentagem por
 *       movimento, sempre número redondo sem decimal (ex.: Orçado R$ 350,00 •
 *       Previsto R$ 250,00 (71%) • Gasto R$ 100,00 (29%));
 *     · no fechamento do mês, a sobra após Orçamento, Programação de Compras
 *       e Poupança Mensal é destinada à Poupança de Fechamento.
 *  · v70 (BUGS):
 *     · PROGRAMAÇÃO DE COMPRA é um BLOCO PRÓPRIO do Fluxo (mesma visualização de
 *       Orçamento/Poupança, com fechinha para expandir) — saiu de dentro do
 *       card de Orçamento; a ORDEM no Fluxo é Orçamentos → Programação de Compra
 *       → Poupança (MELHORIA 2.1);
 *     · FECHAMENTO MENSAL RECALCULA NA HORA — qualquer alteração de data,
 *       valor, lançamento ou transferência refaz a estimativa (nada travado);
 *     · nos meses regidos pelo "Fechamento do mês", o saldo carregado dos
 *       meses anteriores foi RETIDO para a poupança; o previsto começa zerado
 *       no dia 1, e o fim do mês segue a hierarquia de abatimentos.
 *  · v97 (Programação de Compra — CARD):
 *     · as etiquetas roxas de Prioridade/Necessário/Desejo saíram do cabeçalho;
 *     · cabeçalho = valor que CABE no mês visto (`projectionMonthPlan`), nunca
 *       o total planejado;
 *     · subcards expandidos mostram "Falta R$ …" (o que ainda falta pagar do
 *       grupo) e "cabe R$ …" (quanto daquele grupo cabe naquele mês).
 *  · v17 (Programação de Compra — FONTE ÚNICA NO LIVRO-RAZÃO):
 *     · valor do cabeçalho = PLANO do mês visto (o que cabe/foi abatido na
 *       `projectionMonthPlan`), zerado em meses que não estão no plano —
 *       a previsão só vale para o mês planejado; no mês seguinte só baixa
 *       se o valor planejado exceder a disponibilidade do mês atual;
 *     · Saldo do dia abate o que ENTRA no mês visto
 *       (`projectionMonthPlan.faltaInicioCents`), não a lista inteira — o
 *       plano não se reflete automaticamente nos outros meses;
 *     · botão do card renomeado para "Cadastrar / alterar programação ›";
 *     · `getMethodology` e `getProjection` LEEM o cascade já persistido em
 *       `month_ledger_wishlist` via `MonthLedgerService.getMonthWishlistEntries`
 *       (a janela passa a ser `mês atual → mês visto`, lendo o livro
 *       encadeado mês a mês: o `closing` de um mês é a abertura do seguinte).
 *       Nada de override `saldoPrevistoAjustadoFimCents` nem do `startMonth`
 *       como "hoje do dispositivo" — o livro-razão é a fonte única.
 *  · Mantém v11–v13: Fixo/Parcelado perpetuando nos meses seguintes; saldos do
 *    dia (Previsto/Efetivado); compras no CARTÃO estritamente na fatura;
 *    duplicar (segurar 3 s).
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { Screen, Card, Button, EmptyState, Badge, Segmented, FixedDot, InstallmentPill, ProgressBar } from '../src/components/ui';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { LancamentoRow } from '../src/components/LancamentoRow'; // v67 (BUG 2): esqueleto ÚNICO das linhas
import { showToast } from '../lib/toast';
import { startLoad } from '../src/lib/perf';
import { MonthScroller } from '../src/components/MonthScroller';
import { useDataEffect } from '../src/components/useDataEffect';
import { formatBRL } from '../src/lib/money';
import { orcadoPrevistoGastoLinha, orcadoGastoLinha } from '../src/lib/fluxoFormat'; // v69: linha única com % por movimento | v94: sem Previsto
import { mergeDailyAdjust } from '../src/lib/monthEndBalance';
import { sourceLabel } from '../src/lib/text';
import { todaySP, monthOf, ymdToBr, partsOf, lastDayNumberOf } from '../src/lib/dates';
import {
  buildGroupMonths,
  groupMonthDate,
  groupMonthTotals,
  groupStatusInfo,
  groupStatusItems,
  sortGroupItems,
  type FlowTx,
  type GroupMonth,
  type InstAgg,
} from '../src/lib/flowModel';
import { useAppStore } from '../src/store/appStore';
import { SETTING_KEYS } from '../src/services/SettingsService';
import type { BudgetMonthSummary } from '../src/services/BudgetService';
import type { SavingsMonthOverview } from '../src/services/SavingsService';
import type { WishlistClassView, WishlistMethodology, WishlistProjection } from '../src/services/WishlistService';
import { projectionMonthPlan } from '../src/services/WishlistService'; // v95: plano do mês visto (card fixo + Saldo do dia)
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
    openingEfetivado?: number;
  }>({ efetivado: {}, previsto: {} });
  const [lastActivityDate, setLastActivityDate] = React.useState<string | null>(null);
  // v17: linha do livro-razão do mês (Persistida em SQLite, encadeada).
  // Quando presente, é a fonte da verdade do saldo do dia Previsto/Efetivado
  // E da cascata da Programação de Compra (lida via
  // `MonthLedgerService.getMonthWishlistEntries` — não passa mais o
  // `saldoPrevistoAjustadoFimCents` para a tela).
  const [monthLedgerRow, setMonthLedgerRow] = React.useState<import('../src/services/MonthLedgerService').MonthLedgerRow | null>(null);
  const [showDaily, setShowDaily] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  // v7.1: grupos consolidados
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [childrenMap, setChildrenMap] = React.useState<Record<string, FlowTx[]>>({});
  // v12 (bug A): o consolidado por mês — cabeçalho + ocorrências/parcelas do mês
  const [groupMonths, setGroupMonths] = React.useState<Record<string, GroupMonth>>({});
  // v9: expansor das faturas de cartão
  const [expandedInv, setExpandedInv] = React.useState<Record<string, boolean>>({});
  /**
   * v87 (BUG — o usuário reportou): a lista do Fluxo é virtualizada
   * (FlashList, v86) e o FlashList SÓ redesenha as linhas quando o `data`
   * muda. A expansão (Consolidado e Fatura) é estado VISUAL — o `data` não
   * muda — então a setinha girava o estado e a LINHA NÃO ERA REDESENHADA
   * (nem o Consolidado nem a fatura abriam). O `extraData` avisa o FlashList
   * que há mudança visual.
   */
  const [expansaoTick, setExpansaoTick] = React.useState(0);
  /** Último mês carregado — a expansão só é limpa quando o MÊS muda. */
  const mesExpandidoRef = React.useRef(month);
  // v18 (bug 3): ao voltar o foco para o Fluxo, recarrega TUDO (saldos do dia,
  // listas, grupos) — garantia de atualização imediata mesmo que a tela que
  // alterou o dado não tenha propagado o bump.
  const [focusTick, setFocusTick] = React.useState(0);
  // v42 — ORÇAMENTOS e POUPANÇA (flags de Ajustes; cards recolhidos/expandíveis)
  const [budgetsOn, setBudgetsOn] = React.useState(false);
  const [savingsOn, setSavingsOn] = React.useState(false);
  // v70 (BUG 1.1) — PROGRAMAÇÃO DE COMPRA: bloco PRÓPRIO no Fluxo (mesma visualização
  // de Orçamento/Poupança, com fechinha) — saiu de dentro do card de Orçamento.
  const [wishlistOn, setWishlistOn] = React.useState(false);
  const [wishMethod, setWishMethod] = React.useState<WishlistMethodology | null>(null);
  const [wishProjection, setWishProjection] = React.useState<WishlistProjection | null>(null);
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
  // v86 (DESEMPENHO): o foco só força recarga quando o DIA virou (o app pode
  // ficar aberto de um dia para o outro: promoção de vencidas e previsão das
  // fixas dependem de "hoje"). Voltar ao Fluxo sem mudanças não refaz a carga:
  // quem manda recarregar é o dataVersion (mudou dado) - ver useDataEffect.
  // A manutenção também roda UMA vez por mês por sessão: antes rodava em toda
  // carga - inclusive depois de cada gravação - reescrevendo o banco antes de
  // pintar a lista.
  const maintenanceRef = React.useRef<string | null>(null);
  const todayRef = React.useRef(todaySP());
  useFocusEffect(
    React.useCallback(() => {
      const hoje = todaySP();
      if (hoje !== todayRef.current) {
        todayRef.current = hoje;
        maintenanceRef.current = null; // dia virou: refaz a manutenção
        setFocusTick((t) => t + 1);
      }
    }, [])
  );
  // v21 (bug 4): CONFIRMAÇÃO antes de excluir/alterar — regra pedida pelo usuário
  type ConfirmState =
    | { kind: 'tx'; tx: FlowTx }
    | { kind: 'group'; tx: FlowTx }
    | { kind: 'parcela'; planId: string; sequence: number; description: string }
    | null;
  const [confirm, setConfirm] = React.useState<ConfirmState>(null);

  // v86 (DESEMPENHO): a manutenção roda uma vez por mês (ver maintenanceRef).
  useDataEffect(async (svc, isCurrent, dataVersion) => {
    // v86: cronômetro por estágio — em desenvolvimento sai uma linha
    // `[perf] Fluxo · …` no terminal do Metro (em produção é no-op).
    const perf = startLoad('Fluxo');
    // v24: `isCurrent` em TODOS os estágios - carga antiga nunca sobrescreve
    // carga nova (era a fonte do saldo do dia instável ao editar datas).
    try {
      // v21 (bug 2): previsões à vista vencidas viram efetivadas na abertura do Fluxo
      // v50 - promote + ensureForecast em PARALELO (independentes: tabelas diferentes).
      // v90 — savings.generateForecast entra na manutenção do Fluxo também:
      //   antes a previsão dos planos MENSAL ficava dependente da rotina de
      //   arranque terminar antes da tela pintar (a janela MONTHLY podia
      //   aparecer sem o lançamento do mês corrente no primeiro render).
      //   Agora, trocar de mês no Fluxo também REGERA as previsões.
      if (maintenanceRef.current !== month) {
        maintenanceRef.current = month;
        try {
          await Promise.all([
            svc.transactions.promoteDuePendings().catch(() => undefined),
            svc.recurrences.ensureForecastThrough(month).catch(() => undefined),
            // só roda se o módulo Poupança estiver ligado (a própria rotina é
            // idempotente e filtra por planos ativos).
            svc.savings.generateForecast().catch(() => undefined),
          ]);
        } catch {
          // best-effort
        }
      }
      if (!isCurrent()) return;
      perf.lap('manutenção');
      // v86 (DESEMPENHO): as preferências são lidas PRIMEIRO (leituras baratas) e
      // o saldo por dia só é calculado quando vai ser exibido — ou quando a
      // Programação de Compra depende dele. Antes, a rotina pesada (5 agregações
      // sobre o histórico inteiro) rodava em toda abertura do Fluxo, mesmo com a
      // opção "Exibir saldo por dia" desligada.
      type DailyDual = {
        efetivado: Record<string, number>;
        previsto: Record<string, number>;
        openingPrevisto?: number;
      };
      let showDailyFlag = false;
      let budgetsFlag = false;
      let savingsFlag = false;
      let wishlistFlag = false;
      try {
        const [show, lastDate, bFlag, sFlag, wFlag] = await Promise.all([
          svc.settings.getBool(SETTING_KEYS.fluxoSaldoPorDia, false),
          svc.balance.getLastActivityDate(month),
          svc.settings.getBool(SETTING_KEYS.budgetsAtivado, false),
          svc.settings.getBool(SETTING_KEYS.poupancaAtivado, false),
          svc.settings.getBool(SETTING_KEYS.wishlistNaHome, false),
        ]);
        if (!isCurrent()) return;
        showDailyFlag = show;
        budgetsFlag = bFlag;
        savingsFlag = sFlag;
        wishlistFlag = wFlag;
        setShowDaily(show);
        setBudgetsOn(bFlag);
        setSavingsOn(sFlag);
        setWishlistOn(wFlag);
        setLastActivityDate(lastDate);
      } catch (err) {
        console.warn('[Fluxo] preferências falharam:', err);
      }
      perf.lap('preferências');

      // v26: o SALDO DO DIA é calculado e pintado PRIMEIRO, isolado do resto da
      // carga - uma falha na lista/grupos/faturas não deixa mais o saldo parado
      // com o valor antigo (as etapas seguintes escreviam o saldo por último).
      let dailyDual: DailyDual | null = null;
      try {
        if (showDailyFlag || wishlistFlag) {
          dailyDual = (await svc.balance.getDailyBalancesDual(month, dataVersion)) ?? null; // v49: mesma versão=cache, versão nova=recalcula
          if (!isCurrent()) return;
          setDailyBal(dailyDual);
        } else {
          // Sem exibição e sem dependência: não recalcula nada.
          setDailyBal({ efetivado: {}, previsto: {} });
        }
      } catch (err) {
        console.warn('[Fluxo] saldo do dia falhou:', err);
      }
      perf.lap('saldo do dia');

      // v16 — LIVRO-RAZÃO: a linha do mês (Persistida em SQLite, encadeada
      // com o mês anterior) entra no state para uso no `dailyShown` e no
      // saldo passado à Programação de Compra.
      let monthRow: import('../src/services/MonthLedgerService').MonthLedgerRow | null = null;
      try {
        if (showDailyFlag || wishlistFlag || budgetsFlag || savingsFlag) {
          monthRow = await svc.monthLedger.getMonthLedgerSummary(month);
          if (!isCurrent()) return;
          setMonthLedgerRow(monthRow);
        } else {
          setMonthLedgerRow(null);
        }
      } catch (err) {
        console.warn('[Fluxo] livro-razão falhou:', err);
      }
      perf.lap('livro-razão');

      // v42 - cards de ORÇAMENTO e POUPANÇA (só quando a flag está ligada em Ajustes)
      try {
        const [bSum, sSum] = await Promise.all([
          budgetsFlag ? svc.budgets.getMonthSummary(month, dataVersion) : Promise.resolve(null),
          savingsFlag ? svc.savings.getMonthOverview(month, dataVersion) : Promise.resolve(null),
        ]);
        if (!isCurrent()) return;
        setBudgetSum(bSum);
        setSavingsSum(sSum);
        perf.lap('cards:orçamento/poupança');

        // v70 (BUG 1.1) - Programação de Compra: quando ativa, é um BLOCO PRÓPRIO do
        // Fluxo (ordem: Orçamentos → Programação de Compra → Poupança). A metodologia
        // (hierarquia Orçamento → Poupança Mensal → Prioridade/Necessário/Desejo
        // → Poupança Fechamento) vai no bloco dela, não no Orçamento.
        let wishItems: WishlistClassView[] = [];
        if (wishlistFlag) {
          try {
            wishItems = await svc.wishlist.listOpen(dataVersion);
            if (!isCurrent()) return;
            setWishClasses(wishItems);
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

        // v68 - ajustes do SALDO DO DIA: os módulos ativos entram no número
        // (Previsto = base + previsto Orçamento + previsto Poupança; Efetivado
        // idem). No último lançamento do mês, as reservas seguem a hierarquia abaixo.
        let ba: DayAdjust | null = null;
        let sa: DayAdjust | null = null;
        if (budgetsFlag || savingsFlag) {
          const scope = await svc.db.getAllAsync<{ id: string }>(
            'SELECT id FROM accounts WHERE include_in_general_balance = 1 AND archived_at IS NULL'
          );
          const scopeIds = scope.map((r) => r.id);
          [ba, sa] = await Promise.all([
            budgetsFlag ? svc.budgets.getMonthFluxAdjust(month, scopeIds, dataVersion) : Promise.resolve(null),
            savingsFlag ? svc.savings.getMonthFluxAdjust(month, scopeIds, dataVersion) : Promise.resolve(null),
          ]);
          if (!isCurrent()) return;
          setBudAdj(ba);
          setSavAdj(sa);
          perf.lap('cards:ajustes');
        } else {
          setBudAdj(null);
          setSavAdj(null);
        }

        if (wishlistFlag) {
          try {
            // v17: a Programação de Compra LE DIRETAMENTE do
            // `MonthLedgerService` (cascade persistida em
            // `month_ledger_wishlist`). Não há mais cálculo em memória nem
            // override de saldo — o livro é a fonte única.
            void monthRow;
            const wm = await svc.wishlist.getMethodology(month, {
              dataVersion,
            });
            if (!isCurrent()) return;
            setWishMethod(wm);
            // v17 — projeção mês a mês lê entries de `month_ledger_wishlist`
            // para cada mês (do corrente até o visto).
            const wp = await svc.wishlist.getProjection(month, {
              dataVersion,
            });
            if (!isCurrent()) return;
            setWishProjection(wp);
            perf.lap('cards:programação');
          } catch {
            if (isCurrent()) setWishMethod(null);
          }
        }
      } catch (err) {
        console.warn('[Fluxo] orçamentos/poupança falharam:', err);
      }
      perf.lap('cards');

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
    // v87 (BUG): antes a_expansão era LIMPA em TODA recarga — recarregar o
    // Fluxo (bump, foco, mudança de dados) fechava o grupo que o usuário
    // tinha acabado de abrir. Agora a limpeza acontece só quando o MÊS
    // muda (o grupo de outro mês não existe).
    if (mesExpandidoRef.current !== month) {
      mesExpandidoRef.current = month;
      setExpanded({});
      setExpandedInv({});
      setExpansaoTick((t) => t + 1);
    }
    perf.lap('lista+grupos');
    } finally {
      // v24: qualquer que seja o desfecho (erro incluído), a tela nunca fica
      // presa no "Carregando..." — e uma carga abandonada não mexe no loading.
      if (isCurrent()) setLoading(false);
      perf.end();
    }
  }, [month, focusTick], 'Fluxo');

  const isGroup = (t: FlowTx) => t.child_count > 0;

  // ---------- Saldo do dia com hierarquia mensal (memoizado) ----------
  // No último lançamento: Orçamento → Programação de Compras → Poupança Mensal →
  // Fechamento do Mês. Os demais dias continuam mostrando os ajustes diários.
  // v70 (BUGS 1.2/1.3): com Poupança + "Fechamento do mês" ativos, o mês visto
  // a partir da criação do plano é REGIDO pelo fechamento — o saldo carregado
  // dos meses anteriores foi RETIDO para a poupança, então o "Saldo do dia
  // Previsto" NÃO começa com ele (abertura zerada) e o ÚLTIMO dia com
  // lançamento do mês subsequente começa sem carregar saldo positivo.
  const closingRegendo = React.useMemo(() => {
    if (!savingsOn) return false;
    const since = savingsSum?.closingSinceMonth ?? null;
    return since != null && month >= since;
  }, [savingsOn, savingsSum, month]);

  /** v95: plano do mês visto (plano = parte do plano que cabe/foi abatida
   *  neste mês). Declarado AQUI porque o `dailyShown` (hierarquia do Saldo
   *  do dia) já o usa — o card e o Saldo do dia passam a depender do mesmo
   *  número. Vale a regra "previsão só para o mês planejado": a Projection
   *  só preenche meses a partir do mês corrente; para os demais devolve
   *  zeros (a falta não se reflete automaticamente). */
  const wishMonthPlan = React.useMemo(
    () => projectionMonthPlan(wishProjection, month),
    [wishProjection, month]
  );

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
      // v88 (BUG): a data do card é a DO MÊS VISTO (groupMonthDate) — no mês
      // do cabeçalho a data do lançamento; nos outros meses a 1ª ocorrência/
      // parcela do mês. Antes o card ficava preso na data do lançamento.
      list.push({ kind: 'group', date: groupMonthDate(grp), grp });
    }
    for (const inv of invoicesDue) list.push({ kind: 'invoice', date: inv.dueDate, inv });
    for (const inst of accountInst) list.push({ kind: 'installment', date: inst.dueDate, inst });
    return list;
  }, [txs, groupMonths, invoicesDue, accountInst]);

  // ---------- Saldo do dia com hierarquia mensal (memoizado) ----------
  // v16 — livro-razão: a abertura do mês vem do closing do mês anterior
  // (persistido em `month_ledger`), e o saldo do dia-alvo vem do closing
  // do próprio mês (depois de orçamento → programação → poupança → fechamento).
  // Os dias do mês são construídos em cima da nova abertura + budAdj diário.
  const dailyShown = React.useMemo(() => {
    const basePrev: Record<string, number> = { ...dailyBal.previsto };
    const baseEfet: Record<string, number> = { ...dailyBal.efetivado };
    // 1) abertura nova (do ledger): diferença entre a abertura do ledger
    //    (que JÁ carrega o saldo líquido do mês anterior) e a abertura
    //    bruta do dual. O sinal é aplicado a TODOS os dias do mês.
    const openPrevDelta = (monthLedgerRow?.openingPrevCents ?? 0)
      - (dailyBal.openingPrevisto ?? 0);
    const openEfetDelta = (monthLedgerRow?.openingEfetCents ?? 0)
      - (dailyBal.openingEfetivado ?? 0);
    let prev: Record<string, number> = {};
    let efet: Record<string, number> = {};
    for (const ymd of Object.keys(basePrev)) {
      prev[ymd] = (basePrev[ymd] ?? 0) + openPrevDelta;
    }
    for (const ymd of Object.keys(baseEfet)) {
      efet[ymd] = (baseEfet[ymd] ?? 0) + openEfetDelta;
    }
    // 2) ajustes diários do Orçamento (cartão reserva da compra até a
    //    véspera da fatura; fora do escopo reserva da data em diante).
    prev = mergeDailyAdjust(prev, budAdj?.previsto);
    efet = mergeDailyAdjust(efet, budAdj?.efetivado);
    // 3) dia-alvo: a hierarquia completa já foi aplicada no livro —
    //    o closing_prev/efet é o saldo exibido nesse dia.
    if (monthLedgerRow && lastActivityDate
        && monthLedgerRow.targetDate === lastActivityDate) {
      prev[lastActivityDate] = monthLedgerRow.closingPrevCents;
      efet[lastActivityDate] = monthLedgerRow.closingEfetCents;
    }
    return { previsto: prev, efetivado: efet };
  }, [
    dailyBal, budAdj, monthLedgerRow, lastActivityDate, month,
  ]);

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
  }, [entries, filter, showDaily, closingRegendo, month]);

  // ---------- v86: linhas da lista virtualizada ----------
  // Cada linha é OU o cabeçalho de um dia OU um lançamento. O FlashList monta
  // só o que está na tela; trocar mês/filtro não remonta o mês inteiro.
  type FlowRow =
    | { kind: 'day'; key: string; day: string; prev?: number; efet?: number }
    | { kind: 'entry'; key: string; entry: Entry };

  const entryId = (e: Entry): string =>
    e.kind === 'invoice'
      ? `inv:${e.inv.invoiceId}`
      : e.kind === 'installment'
        ? `inst:${e.inst.installmentId}`
        : e.kind === 'group'
          ? `grp:${e.grp.header.id}`
          : `tx:${e.tx.id}`;

  const flowRows = React.useMemo<FlowRow[]>(() => {
    const rows: FlowRow[] = [];
    for (const [day, list] of days) {
      rows.push({
        kind: 'day',
        key: `day:${day}`,
        day,
        prev: dailyShown.previsto[day],
        efet: dailyShown.efetivado[day],
      });
      list.forEach((entry, i) => rows.push({ kind: 'entry', key: `${day}:${i}:${entryId(entry)}`, entry }));
    }
    return rows;
  }, [days, dailyShown]);

  const renderRow = ({ item }: { item: FlowRow }) => {
    if (item.kind === 'day') {
      return (
        <View className="flex-row justify-between items-start mt-1 gap-2">
          <Text className="text-xs font-bold uppercase tracking-wide text-slate-500 mt-0.5">
            {ymdToBr(item.day).slice(0, 5)} · {weekdayOf(item.day)}
          </Text>
          {showDaily && item.prev != null ? (
            <View className="items-end gap-0.5 shrink">
              <Text className={`text-xs font-bold ${item.prev < 0 ? 'text-rose-600' : 'text-slate-700'}`}>
                Saldo do dia Previsto: {formatBRL(item.prev)}
              </Text>
              {item.efet != null ? (
                <Text className={`text-[11px] font-semibold ${item.efet < 0 ? 'text-rose-500' : 'text-slate-500'}`}>
                  Saldo do dia Efetivado: {formatBRL(item.efet)}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      );
    }
    return <View className="pb-1.5">{renderEntry(item.entry)}</View>;
  };


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
    // v87: avisa o FlashList que o desenho mudou (a lista é virtualizada)
    setExpansaoTick((t) => t + 1);
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
      // v87 (BUG MÉDIA): o grupo era marcado item a item SEM transação — uma
      // falha no meio deixava o grupo PARCIALMENTE pago. Agora é tudo ou nada.
      await services.db.transactionAsync(async () => {
        for (const t of txs) {
          await services.transactions.setPaymentStatus(t.id, next);
        }
        for (const i of insts) {
          await services.installments.setPaymentStatus(i.installmentId, next);
        }
      });
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

  /** v89: chip "Transferido / Não transferido" — SÓ nas transferências
   *  previstas pelo plano de poupança (MONTHLY/CLOSING ativo), no mesmo
   *  lugar do chip Pago/Não pago. Alterna PENDING↔CONFIRMED pelos moves. */
  const planTxIds = React.useMemo(() => {
    const ativos = new Set((savingsSum?.plans ?? []).map((p) => p.planId));
    const out = new Set<string>();
    for (const e of savingsSum?.entries ?? []) {
      if (e.planId && ativos.has(e.planId) && e.transactionId) out.add(e.transactionId);
    }
    return out;
  }, [savingsSum]);
  const renderSavingsChip = (tx: FlowTx) => {
    if (!planTxIds.has(tx.id) || tx.status === 'VOIDED') return null;
    const done = tx.status === 'CONFIRMED';
    const label = done ? '✓ Transferido' : 'Não transferido';
    const cls = done
      ? 'bg-sky-600'
      : 'bg-sky-50 border border-sky-300';
    const txt = done ? 'text-white' : 'text-sky-700';
    return (
      <Pressable
        onPress={() => toggleTransfer(tx)}
        accessibilityRole="button"
        accessibilityLabel={`${label}. Toque para alternar.`}
        className={`rounded-full px-2 py-0.5 ${cls}`}
      >
        <Text className={`text-[10px] font-bold ${txt}`}>{label}</Text>
      </Pressable>
    );
  };
  /** v89: alterna Transferido/Não transferido da transferência do plano. */
  const toggleTransfer = async (tx: FlowTx) => {
    const nowTransferred = tx.status !== 'CONFIRMED';
    try {
      await services.transactions.setTransferStatus(tx.id, nowTransferred);
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
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
    onExcluir?: (() => void) | null;
    /** Liquidado (pago/recebido): card em cinza. */
    settled?: boolean;
  }) => (
    <LancamentoRow
      key={a.key}
      settled={a.settled}
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
      settled:
        tx.status === 'CONFIRMED' &&
        (tx.type === 'INCOME' || tx.type === 'EXPENSE') &&
        tx.kind === 'SIMPLE' &&
        !tx.card_id,
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
          {!opts.child ? renderSavingsChip(tx) : null}
        </>
      ),
      // Semântica de cores: verde = receita, vermelho = despesa, cinza = transferência
      amount: `${tx.type === 'INCOME' ? '+' : tx.type === 'TRANSFER' ? '⇄ ' : '−'}${formatBRL(tx.amount_cents)}`,
      amountClass: `${amountColor(tx)} ${tx.status === 'VOIDED' ? 'line-through opacity-50' : ''}`,
      onAlterar: opts.child || !canEdit(tx) ? null : () => openAlterar(tx),
      // v21 (bug 4): exclusão pede confirmação (modal)
      onExcluir: opts.child
        ? null
        : () =>
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
          // v88 (BUG): a data exibida é a DO MÊS VISTO (não a do lançamento) —
          // antes, ao passar os meses, a data ficava presa na data original.
          subtitle: `${ymdToBr(groupMonthDate(grp))} · ${itemCount} item(ns) neste mês`,
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
          onExcluir: () => setConfirm({ kind: 'group', tx }),
        })}
        {isOpen ? (
          <View className="gap-1.5">
            {/* v14 — ordenação única do conteúdo expandido: 1º RECEITAS,
                depois DESPESAS; cada bloco do MAIOR valor para o MENOR;
                empate por descrição A→Z. `children` só entra no mês do
                cabeçalho. */}
            {sortGroupItems(
              grp.isHeaderMonth ? children : [],
              grp.occurrences,
              grp.installments
            ).map((item) => item.kind === 'tx'
              ? renderTxCard(item.node as FlowTx, { child: true })
              : renderInstallmentRow(item.node as InstAgg, { child: true }))}
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
          onPress: () => {
            setExpandedInv((cur) => ({ ...cur, [inv.invoiceId]: !isOpen }));
            // v87: avisa o FlashList (a lista é virtualizada)
            setExpansaoTick((t) => t + 1);
          },
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
      settled: paid,
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
      onAlterar: opts.child ? null : () => router.push({ pathname: '/plano/[id]', params: { id: inst.planId } }),
      // v18 (bug 4): parcela PAGA não oferece Excluir (pagas nunca são excluídas —
      // era a fonte do erro "Não há parcelas em aberto" ao excluir pagamento)
      // v21 (bug 4): exclusão pede confirmação (modal com escopo)
      onExcluir: opts.child || paid
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

  // ---------- v90 — cards de ORÇAMENTO/POUPANÇA: ESCONDIDOS em meses anteriores
//  à criação do plano/orçamento. O usuário vinha vendo o card com "N plano(s)
//  cadastrado(s)" / "0 orçamento(s) ativo(s)" em meses onde nem existia —
//  era fonte de confusão. Agora o card só aparece a partir do mês de criação.
const budgetFirstMonth = React.useMemo(() => {
  if (!budgetSum) return null;
  let m: string | null = null;
  for (const it of budgetSum.items) {
    const cm = it.createdMonth;
    if (cm && (!m || cm < m)) m = cm;
  }
  return m;
}, [budgetSum]);
const savingsFirstMonth = React.useMemo(() => {
  if (!savingsSum) return null;
  let m: string | null = null;
  for (const p of savingsSum.plans) {
    const cm = p.createdMonth;
    if (cm && (!m || cm < m)) m = cm;
  }
  return m;
}, [savingsSum]);
const showBudgetCard = budgetsOn && (budgetFirstMonth == null || month >= budgetFirstMonth);
const showSavingsCard = savingsOn && (savingsFirstMonth == null || month >= savingsFirstMonth);

  /** v42 → v68 (BUGS 1 e 2): cards aglutinados de ORÇAMENTO e POUPANÇA no
   *  MESMO esqueleto LancamentoRow das demais linhas. Expandidos:
   *   · ORÇAMENTO mostra "Orçado • Previsto • Gasto" por orçamento e no total
   *     (Orçado = limite cadastrado; Previsto = pendentes; Gasto = efetivados);
   *   · POUPANÇA mostra o PLANO CADASTRADO: nome, modalidade, valor e
   *     guardado/falta.
   *  A linha de orçamentos do cabeçalho dos dias SAIU — a participação
   *  do orçamento agora é DENTRO do saldo do dia (v68 BUG 1). */
  const budgetCard = showBudgetCard ? (
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
            {/* v94: o card mostra "Orçado R$ (x%) • Gasto R$ (x%)" na MESMA
                linha, com a MESMA regra de % por movimento do v69 (sem o
                "Previsto": agora o denominador é orçado+gasto).
                · falta (orçado − efetivado) segue ao lado, intacto. */}
            <Text className="text-[11px] text-slate-500">
              {orcadoGastoLinha(budgetSum.budgetedCents, budgetSum.efetivadoCents)} · falta {formatBRL(budgetSum.remainingCents)}
            </Text>
            {budgetSum.items.map((it) => (
              <LancamentoRow
                key={it.budgetId}
                dashed
                title={it.label}
                subtitle={orcadoGastoLinha(it.amountCents, it.efetivadoCents)}
                amount={`falta ${formatBRL(it.remainingCents)}`}
                amountClass={it.remainingCents < 0 ? 'text-rose-600' : 'text-slate-700'}
                footer={<ProgressBar pct={it.pct} />}
              />
            ))}
            {/* v98: botão "Cadastrar / alterar" dentro do footer (o link verde do
                LancamentoRow saiu — regra geral dos cards aqui). Vai para a
                tela de configuração do plano do orçamento (cadastro/altera os
                orçamentos do mês). */}
            <Button label="Cadastrar / alterar orçamento ›" variant="outline" onPress={() => router.push('/orcamento')} />
          </View>
        ) : (
          <View className="gap-2">
            <Text className="text-xs text-slate-500">Nenhum orçamento ativo — cadastre em Ações rápidas › Orçamento.</Text>
            <Button label="Cadastrar / alterar orçamento ›" variant="outline" onPress={() => router.push('/orcamento')} />
          </View>
        )
      }
      footerOpen={budgetOpen}
    />
  ) : null;

  // ---------- v70 (BUG 1.1 + MELHORIA 2.1) → v95: BLOCO PRÓPRIO da PROGRAMAÇÃO DE COMPRA
  // (mesma visualização de Orçamento/Poupança: fechinha para expandir) —
  // saiu de DENTRO do card de Orçamento. Ordem no Fluxo: Orçamentos →
  // Programação de Compra → Poupança.
  //
  // v95 (regras do usuário) → v97:
  //  · CONTRAÍDO NÃO mostra mais chips de Prioridade/Necessário/Desejo — o
  //    cabeçalho tem UM valor: o que CABE neste mês (`planoCents`);
  //  · valor do cabeçalho = `projectionMonthPlan.planoCents` (o que
  //    cabe/foi abatido NESTE mês). Meses fora do plano ficam zerados —
  //    a previsão só vale para o mês planejado (não se reflete);
  //  · cada linha de classificação EXPANDIDA mostra "Falta R$ …" (falta pagar
  //    do grupo) e "cabe R$ …" (o plano daquela classificação no mês visto,
  //    na ordem P → N → D);
  //  · o botão dentro do card virou "Cadastrar / alterar programação ›".
  const wishTotalItens = wishClasses.reduce((a, c) => a + c.itemCount, 0);
  const wishCardSubtitle =
    wishTotalItens === 0
      ? 'Nenhum item cadastrado'
      : wishMonthPlan.planoCents > 0
        ? `${wishTotalItens} item(ns) · cabe neste mês`
        : `${wishTotalItens} item(ns) na lista`;
  const wishlistCard = wishlistOn ? (
    <LancamentoRow
      key="card-lista-desejos"
      arrow={{ open: wishOpen, onPress: () => setWishOpen((v) => !v), label: wishOpen ? 'Recolher programação de compra' : 'Expandir programação de compra' }}
      title={`${ICONS.listaDesejos} Programação de Compra`}
      subtitle={wishCardSubtitle}
      amount={formatBRL(wishMonthPlan.planoCents)}
      amountClass={wishMonthPlan.planoCents > 0 ? 'text-violet-700' : 'text-emerald-700'}
      footer={
        <View className="gap-1.5">
          {/* v94: a barra de progress\u00e3o por m\u00eas (v90) saiu do rodap\u00e9
              (o saldo din\u00e2mico do cabe\u00e7alho j\u00e1 mostra o resultado). */}
          {wishClasses.filter((c) => c.itemCount > 0).map((c) => {
            const clsOpen = !!wishClassOpen[c.cls];
            // v97: o subcard mostra o que AINDA FALTA PAGAR no grupo e quanto
            // CABE NESTE MÊS (`abatidoCents` da cascata) — o total planejado
            // não aparece mais no cabeçalho nem como valor único do grupo.
            const faltaGrupoCents = c.items.reduce((a, it) => a + it.faltaCents, 0);
            const clsPlan = wishMonthPlan.classes.find((x) => x.cls === c.cls);
            const cabeCents = clsPlan?.abatidoCents ?? 0;
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
                  subtitle={`Falta ${formatBRL(faltaGrupoCents)} — ${c.itemCount} item(ns)`}
                  amount={`cabe ${formatBRL(cabeCents)}`}
                  amountClass={cabeCents > 0 ? 'text-violet-700' : 'text-slate-400'}
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
          {/* v94: "Cadastrar / alterar" agora vive dentro do footer (o link
              verde do LancamentoRow saiu — regra geral dos cards aqui). */}
          <Button label="Cadastrar / alterar programação ›" variant="outline" onPress={() => router.push('/lista-desejos')} />
        </View>
      }
      footerOpen={wishOpen}
    />
  ) : null;

  // v94: estado/busy do botão "Efetivar" do Fechamento do Mês (cria+efetiva
  // a transferência de fechamento quando o mês ainda não foi confirmado).
  const [efetivandoFechamento, setEfetivandoFechamento] = React.useState(false);
  const onEfetivarFechamento = async () => {
    if (!savingsSum) return;
    if (efetivandoFechamento) return;
    setEfetivandoFechamento(true);
    try {
      const r = await services.savings.efetivarFechamento(month);
      if (r.efetivadas > 0) {
        showToast(`Fechamento de ${formatBRL(r.amountCents)} transferido`);
      } else {
        showToast('Sem sobra para guardar neste mês — nada a efetivar');
      }
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setEfetivandoFechamento(false);
    }
  };
  const savingsCard = showSavingsCard ? (
    <LancamentoRow
      key="card-poupanca"
      arrow={{ open: savingsOpen, onPress: () => setSavingsOpen((v) => !v), label: savingsOpen ? 'Recolher poupança' : 'Expandir poupança' }}
      title={`${ICONS.poupanca} Poupança`}
      // v94: cabeçalho mantém o QUE importa — quanto JÁ está guardado e quanto
      // falta — sem contar "N plano(s) cadastrado(s)".
      subtitle={
        savingsSum && savingsSum.plans.length > 0
          ? `Guardado no mês ${formatBRL(savingsSum.effectedCents)} de ${formatBRL(savingsSum.programadoCents || 1)}`
          : 'Nenhum plano de poupança'
      }
      amount={formatBRL(savingsSum?.programadoCents ?? 0)}
      amountClass={(savingsSum?.programadoCents ?? 0) < 0 ? 'text-rose-600' : 'text-slate-900'}
      footer={
        savingsSum && savingsSum.plans.length > 0 ? (
          <View className="gap-1.5">
            {/* v94 — Card Poupança expandido: DUAS informações (a lista por
                plano saiu — o usuário só precisa do CONSOLIDADO por modalidade).
                · Linha 1 — Mensal: soma de TODAS as programações planejadas
                  (plannedCents já considera apenas planos ATIVOS, v87).
                · Linha 2 — Fechamento: saldo que SOBRA no fim do mês (sugestão
                  viva) ou 0 quando já foi confirmado/efetivado. */}
            <View className="flex-row justify-between items-center gap-2">
              <Text className="text-sm text-slate-700">Poupança · Mensal</Text>
              <Text className="text-sm font-bold text-slate-900">{formatBRL(savingsSum.plannedCents)}</Text>
            </View>
            <View className="flex-row justify-between items-center gap-2">
              <Text className="text-sm text-slate-700">Poupança · Fechamento</Text>
              <Text className={`text-sm font-bold ${(savingsSum.closingSuggestion?.amountCents ?? 0) > 0 ? 'text-violet-700' : 'text-emerald-700'}`}>
                {formatBRL(savingsSum.closingSuggestion?.amountCents ?? 0)}
              </Text>
            </View>
            {/* v94 — botão Efetivar (Fechamento). SÓ aparece quando existe plano
                CLOSING ativo e o fechamento do mês ainda não foi confirmado
                (uma sugestão de valor positiva OU uma transferência pendente). */}
            {(savingsSum.closingSuggestion && savingsSum.closingSuggestion.amountCents > 0) ||
            savingsSum.entries.some((e) => e.kind === 'CLOSING' && !e.effected) ? (
              <Button
                label={efetivandoFechamento ? 'Efetivando…' : 'Efetivar fechamento'}
                variant="primary"
                onPress={onEfetivarFechamento}
                loading={efetivandoFechamento}
              />
            ) : null}
            {/* v94 — botão "Cadastrar / alterar" dentro do footer (o link verde
                do LancamentoRow saiu — regra geral dos cards aqui). */}
            <Button label="Cadastrar / alterar poupança ›" variant="outline" onPress={() => router.push('/poupanca')} />
          </View>
        ) : (
          <View className="gap-2">
            <Text className="text-xs text-slate-500">Nenhum plano de poupança — cadastre em Ações rápidas › Poupança.</Text>
            <Button label="Cadastrar / alterar poupança ›" variant="outline" onPress={() => router.push('/poupanca')} />
          </View>
        )
      }
      footerOpen={savingsOpen}
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
    <Screen
      title="Fluxo"
      headerArea={headerArea}
      // v86 (DESEMPENHO): LISTA VIRTUALIZADA — antes o mês inteiro (dias +
      // lançamentos + faturas + grupos) era montado dentro de uma ScrollView.
      body={
        <FlashList
          data={flowRows}
          // v87: o FlashList só redesenha as linhas quando o `data` muda — a
          // expansão (Consolidado/Fatura) é estado visual. O extraData avisa
          // a lista de que o desenho mudou.
          extraData={expansaoTick}
          keyExtractor={(row) => row.key}
          renderItem={renderRow}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 }}
          ListHeaderComponent={
            <View className="gap-3 pb-3">
              <Segmented<Filter>
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'ALL', label: 'Tudo' },
                  { value: 'INCOME', label: 'Entradas' },
                  { value: 'EXPENSE', label: 'Saídas' },
                ]}
              />
              {budgetCard}
              {wishlistCard}
              {savingsCard}
              {loading ? (
                <Card>
                  <Text className="text-slate-500">Carregando...</Text>
                </Card>
              ) : null}
              {!loading && days.length === 0 ? (
                <EmptyState
                  icon="🗓️"
                  title="Sem lançamentos no mês"
                  hint="Registre um lançamento manual ou importe um OFX."
                />
              ) : null}
            </View>
          }
          ListFooterComponent={
            days.length > 0 ? (
              <Text className="text-[11px] text-slate-400 text-center px-8 pt-3">
                Dica: segure um lançamento por 3 segundos para duplicar. Use "Alterar" para editar; toque no status para marcar Pago/Recebido. Faturas: toque na seta para ver os lançamentos.
              </Text>
            ) : null
          }
        />
      }
    >{/* v21 (bug 4): CONFIRMAÇÃO de exclusão/alteração - modal antes de efetivar */}
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
