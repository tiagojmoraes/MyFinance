/** Tela Fluxo — v14/v16/v18:
 *  · v36 — 1 CARGA, 1 LISTA, 1 CÁLCULO (pedido do usuário):
 *     · CARGA ÚNICA POR MÊS (Promise.all): lançamentos do mês + Orçamento do
 *       mês + Poupança do mês + Programação do mês + 1 número (saldo de
 *       abertura = fechamento do mês anterior, lido do livro-razão). Trocar
 *       de mês faz outra carga única, só do mês visto — nunca o ano inteiro.
 *       Depois da carga, NINGUÉM consulta o banco para mostrar saldo/Orçamento/
 *       Poupança/Programação — só volta ao banco para SALVAR.
 *     · OS 3 VIRAM ITEM DA LISTA EM MEMÓRIA (ItemFluxo): origem
 *       LANCAMENTO/ORCAMENTO/POUPANCA/PROGRAMACAO, data, valor em centavos e
 *       status PAGO/PENDENTE/CANCELADO. Se não está na lista, NÃO desconta.
 *     · 1 CÁLCULO SÓ: `calcularFluxo(listaEmMemoria, saldoAberturaCents)` —
 *       função PURA (sem db, sem await) em src/lib/calcularFluxo.ts; devolve
 *       os dias com Saldo do dia Previsto (abertura + tudo) e Efetivado
 *       (abertura + só pago). Saiu de cena: getDailyBalancesDual, budAdj,
 *       savAdj, mergeDailyAdjust e o override do closing no dia-alvo.
 *     · ALTERAR SEM RECARREGAR: mexe na lista em memória → calcularFluxo de
 *       novo → renderiza na hora → salva no banco em background; falhou,
 *       a lista volta para o valor antigo + erro.
 *     · VIGÊNCIAS: poupança só gera ocorrência com data >= criação do plano
 *       (gerarOcorrenciasPoupanca) e permite cancelar SÓ o mês; orçamento e
 *       programação valem do mês planejado pra frente (nada retroativo).
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
import { orcadoGastoLinha } from '../src/lib/fluxoFormat'; // v94: linha única com % por movimento
// v36 — 1 CARGA, 1 LISTA, 1 CÁLCULO: o Saldo do dia sai da função PURA em
// memória (sem db, sem await, sem SELECT) — ver src/lib/calcularFluxo.ts.
import {
  calcularFluxo,
  gerarOcorrenciasPoupanca,
  ocorrenciaNaVigencia,
  type ItemFluxo,
} from '../src/lib/calcularFluxo';
import { sourceLabel } from '../src/lib/text';
import { todaySP, monthOf, monthAdd, ymdToBr, partsOf, lastDayNumberOf } from '../src/lib/dates';
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
import type { BudgetCommitment, BudgetMonthSummary } from '../src/services/BudgetService';
import type { SavingsMonthOverview, SavingsPlanRow, SavingsEntryView } from '../src/services/SavingsService';
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

/** v36 — movimento (perna) do mês nas contas do escopo do Fluxo. Cada linha
 *  vira 1 item de origem LANCAMENTO (ou POUPANCA, quando a transação pertence
 *  a um plano de poupança) na lista em memória. */
interface FluxoMoveRow {
  moveId: string;
  txId: string | null;
  data: string;
  amount: number;
  direction: string; // 'CREDIT' | 'DEBIT'
  status: string; // 'CONFIRMED' | 'VOIDED' (da perna)
  txStatus: string | null; // status da transação (null = pagamento de fatura)
  txType: string | null;
  descricao: string | null;
  instStatus: string | null; // parcela vinculada (PENDING = previsão)
  installmentId: string | null; // parcela dona do movimento (remoção em memória)
  entryIdPoupanca: string | null; // entrada do plano de poupança dona do lançamento
  planIdPoupanca: string | null;
}

const WEEK = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
function weekdayOf(ymd: string): string {
  const { y, m, d } = partsOf(ymd);
  return WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export default function FluxoScreen() {
  const services = useDataEffect();
  // v36: as mutações feitas DENTRO do Fluxo NÃO dão bump (nada de recarregar):
  // mexem na lista em memória, recalculam com `calcularFluxo`, renderizam e
  // salvam no banco em background (invalidarPosSalvar). O dataVersion segue
  // servindo para as cargas de mês e para os caches memoizados dos serviços.
  const dataVersion = useAppStore((s) => s.dataVersion);
  const [month, setMonth] = React.useState(monthOf(todaySP()));
  const [filter, setFilter] = React.useState<Filter>('ALL');
  const [txs, setTxs] = React.useState<FlowTx[]>([]);
  const [invoicesDue, setInvoicesDue] = React.useState<InvoiceAgg[]>([]);
  const [accountInst, setAccountInst] = React.useState<InstAgg[]>([]);
  // v36 — 1 CARGA, 1 LISTA, 1 CÁLCULO: o Saldo do dia é calculado pela função
  // PURA `calcularFluxo` sobre a lista em memória (itensFluxo) + 1 número, o
  // saldo de abertura (fechamento do mês anterior, lido do livro-razão).
  // NÃO existe mais consulta de banco para mostrar saldo/Orçamento/Poupança/
  // Programação — só a carga única do mês (Promise.all) e gravações.
  const [aberturaCents, setAberturaCents] = React.useState(0);
  /** Movimentos do mês nas contas do escopo (base dos itens LANCAMENTO). */
  const [movesRows, setMovesRows] = React.useState<FluxoMoveRow[]>([]);
  /** Compromissos do Orçamento no mês (viram itens de origem ORCAMENTO). */
  const [commitments, setCommitments] = React.useState<BudgetCommitment[]>([]);
  /** Planos de poupança (data de criação p/ vigência + ativos). */
  const [savingsPlans, setSavingsPlans] = React.useState<SavingsPlanRow[]>([]);
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
  const [budgetOpen, setBudgetOpen] = React.useState(false);
  const [resumoOpen, setResumoOpen] = React.useState(false);
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
  // v36: 'poupanca' = cancelar SÓ a ocorrência do mês visto (sem mexer no plano).
  type ConfirmState =
    | { kind: 'tx'; tx: FlowTx }
    | { kind: 'group'; tx: FlowTx }
    | { kind: 'parcela'; planId: string; sequence: number; description: string }
    | { kind: 'poupanca'; tx: FlowTx; planId: string; description: string }
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

      // v36 — CARGA ÚNICA POR MÊS (Promise.all): escopo + livro-razão (o 1
      // número do saldo de abertura) + lançamentos do mês + faturas + parcelas
      // + movimentos do escopo + planos de poupança. Trocar para dezembro faz
      // OUTRA carga única, só de dezembro — nunca o ano inteiro. Depois desta
      // leitura, NINGUÉM consulta o banco para mostrar saldo, Orçamento,
      // Poupança ou Programação: a tela só renderiza o que está em memória
      // (e volta ao banco apenas para SALVAR uma alteração).
      const scopeRows = await svc.db.getAllAsync<{ id: string }>(
        'SELECT id FROM accounts WHERE include_in_general_balance = 1 AND archived_at IS NULL'
      );
      if (!isCurrent()) return;
      const scopeIds = scopeRows.map((r) => r.id);
      const scopeMarks = scopeIds.length > 0 ? scopeIds.map(() => '?').join(',') : "''";

      const [
        prefs,
        monthRow,
        rows,
        invRows,
        instRows,
        moves,
        plans,
      ] = await Promise.all([
        Promise.all([
          svc.settings.getBool(SETTING_KEYS.fluxoSaldoPorDia, false),
          svc.settings.getBool(SETTING_KEYS.budgetsAtivado, false),
          svc.settings.getBool(SETTING_KEYS.poupancaAtivado, false),
          svc.settings.getBool(SETTING_KEYS.wishlistNaHome, false),
        ]) as Promise<[boolean, boolean, boolean, boolean]>,
        // SALDO DE ABERTURA — 1 número: o fechamento do mês anterior, lido do
        // livro-razão (a linha do mês visto já traz openingEfetCents; não
        // recarrega a lista do mês anterior para mostrar o mês atual).
        svc.monthLedger.getMonthLedgerSummary(month).catch(() => null),
        svc.transactions.listFlow(month),
        svc.invoices.listInvoicesDueInMonth(month),
        svc.installments.listAccountInstallmentsDueInMonth(month),
        // Movimentos do MÊS nas contas do escopo — viram itens LANCAMENTO da
        // lista em memória (pernas CONFIRMED = PAGO; pernas VOIDED de
        // transação PENDENTE e parcela em aberto = PENDENTE). Nada de soma de
        // saldo no banco — a soma é feita pelo calcularFluxo em memória.
        svc.db.getAllAsync<{
          moveId: string; txId: string | null; data: string; amount: number;
          direction: string; status: string; txStatus: string | null; txType: string | null;
          descricao: string | null; instStatus: string | null; installmentId: string | null;
          entryIdPoupanca: string | null; planIdPoupanca: string | null;
        }>(
          `SELECT fm.id AS moveId,
                  fm.transaction_id AS txId,
                  fm.effective_date AS data,
                  fm.amount_cents AS amount,
                  fm.direction AS direction,
                  fm.status AS status,
                  t.status AS txStatus,
                  t.type AS txType,
                  COALESCE(t.description, 'Pagamento de fatura') AS descricao,
                  i.status AS instStatus,
                  i.id AS installmentId,
                  se.id AS entryIdPoupanca,
                  se.plan_id AS planIdPoupanca
             FROM financial_moves fm
             JOIN accounts acc ON acc.id = fm.account_id
             LEFT JOIN transactions t ON t.id = fm.transaction_id
             LEFT JOIN installments i ON i.id = fm.installment_id
             LEFT JOIN savings_entries se ON se.transaction_id = fm.transaction_id AND se.status != 'CANCELED'
            WHERE fm.account_id IN (${scopeMarks})
              AND fm.effective_date >= COALESCE(acc.initial_balance_date, '0000-01-01')
              AND fm.effective_date >= ? || '-01'
              AND fm.effective_date <= ?`,
          [...scopeIds, month, `${month}-${String(lastDayNumberOf(month)).padStart(2, '0')}`] as never
        ),
        svc.savings.listPlans(),
      ]);
      if (!isCurrent()) return;
      const [show, bFlag, sFlag, wFlag] = prefs;
      setShowDaily(show);
      setBudgetsOn(bFlag);
      setSavingsOn(sFlag);
      setWishlistOn(wFlag);
      perf.lap('carga única');

      // Abertura do mês: linha do livro-razão quando existe; sem linha (mês
      // anterior ao horizonte do livro), o saldo geral real do fim do mês
      // anterior — 1 número, leitura única (nunca saldo por dia no banco).
      let abertura = monthRow?.openingEfetCents ?? 0;
      if (!monthRow) {
        try {
          const prevMonth = monthAdd(month, -1);
          abertura = await svc.balance.getGeneralBalance(
            `${prevMonth}-${String(lastDayNumberOf(prevMonth)).padStart(2, '0')}`
          );
        } catch {
          abertura = 0;
        }
      }
      if (!isCurrent()) return;
      setAberturaCents(abertura);
      setSavingsPlans(plans);
      setMovesRows(moves as FluxoMoveRow[]);

      // Orçamento / Poupança / Programação DO MÊS VISTO — leitura única em
      // paralelo; os cards e a lista em memória usam estes dados até que uma
      // alteração os mexa DENTRO do estado (sem nova consulta ao banco).
      const [bSum, sSum, wishItems, wm, wp, comms] = await Promise.all([
        bFlag ? svc.budgets.getMonthSummary(month, dataVersion) : Promise.resolve(null),
        sFlag ? svc.savings.getMonthOverview(month, dataVersion) : Promise.resolve(null),
        wFlag ? svc.wishlist.listOpen(dataVersion).catch(() => [] as WishlistClassView[]) : Promise.resolve([] as WishlistClassView[]),
        wFlag ? svc.wishlist.getMethodology(month, { dataVersion }).catch(() => null) : Promise.resolve(null),
        wFlag ? svc.wishlist.getProjection(month, { dataVersion }).catch(() => null) : Promise.resolve(null),
        bFlag ? svc.budgets.listCommitments(month, scopeIds).catch(() => [] as BudgetCommitment[]) : Promise.resolve([] as BudgetCommitment[]),
      ]);
      if (!isCurrent()) return;
      setBudgetSum(bSum);
      setSavingsSum(sSum);
      setWishClasses(wishItems);
      setWishMethod(wm);
      setWishProjection(wp);
      setCommitments(comms);
      perf.lap('cards');

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

  /** v95: plano do mês visto (plano = parte do plano que cabe/foi abatida
   *  neste mês). O card da Programação e o item de origem PROGRAMACAO da
   *  lista em memória dependem do MESMO número. Vale a regra "previsão só
   *  para o mês planejado": a Projection só preenche meses a partir do mês
   *  corrente; para os demais devolve zeros (mês passado não entra, não
   *  desconta — vigência do pedido). */
  const wishMonthPlan = React.useMemo(
    () => projectionMonthPlan(wishProjection, month),
    [wishProjection, month]
  );

  // ---------- 1 LISTA EM MEMÓRIA (v36) ----------
  // Lançamentos (pernas de movimento nas contas do escopo) + Orçamento
  // (compromissos) + Poupança (transferências dos planos, com vigência) +
  // Programação (reserva do mês planejado). Cada item tem data, valor em
  // centavos, status e origem. NÃO está na lista → NÃO desconta.
  const itensFluxo = React.useMemo<ItemFluxo[]>(() => {
    const itens: ItemFluxo[] = [];

    // --- POUPANÇA: marca as transferências dos planos (origem POUPANCA) e
    // aplica a VIGÊNCIA: data da ocorrência >= data de criação do plano —
    // ocorrência retroativa (ou cancelada) NÃO entra na lista.
    const planoPorId = new Map(savingsPlans.map((p) => [p.id, p]));
    const poupancaTxIds = new Set<string>();
    for (const e of savingsSum?.entries ?? []) {
      if (!e.transactionId || !e.planId) continue;
      const plano = planoPorId.get(e.planId);
      if (!plano || plano.is_active !== 1) continue;
      if (e.kind === 'MONTHLY') {
        const criacao = (plano.created_at ?? '').slice(0, 10);
        if (!e.date || !ocorrenciaNaVigencia(e.date, criacao)) continue;
      }
      poupancaTxIds.add(e.transactionId);
    }

    // --- LANCAMENTO / POUPANCA: 1 item por perna de movimento do mês.
    for (const m of movesRows) {
      const valor = m.direction === 'CREDIT' ? m.amount : -m.amount;
      let status: 'PAGO' | 'PENDENTE';
      if (m.status === 'CONFIRMED') {
        // Parcela EM ABERTO é previsão (o movimento dela não é realizado).
        status = m.instStatus === 'PENDING' ? 'PENDENTE' : 'PAGO';
      } else if (m.status === 'VOIDED' && m.txStatus === 'PENDING') {
        status = 'PENDENTE';
      } else {
        // Perna de transação excluída / movimento solto: fora da lista.
        continue;
      }
      const ehPoupanca = m.txId != null && poupancaTxIds.has(m.txId);
      itens.push({
        id: `mv:${m.moveId}`,
        origem: ehPoupanca ? 'POUPANCA' : 'LANCAMENTO',
        data: m.data,
        valorCents: valor,
        status,
        descricao: m.descricao ?? 'Lançamento',
        refId: m.txId ?? undefined,
      });
    }

    // --- Faturas de cartão em aberto: PENDENTE no vencimento (o saldo só
    // sente a fatura no dia do vencimento; o pagamento CONFIRMADO já entra
    // como lançamento pago na data em que foi pago).
    for (const inv of invoicesDue) {
      if (inv.liveStatus === 'PAID' || inv.dueCents <= 0) continue;
      itens.push({
        id: `inv:${inv.invoiceId}`,
        origem: 'LANCAMENTO',
        data: inv.dueDate,
        valorCents: -inv.dueCents,
        status: 'PENDENTE',
        descricao: `Fatura ${inv.cardName}`,
        refId: inv.invoiceId,
      });
    }

    // --- ORCAMENTO: compromissos do mês (cartão reserva da compra até a
    // véspera da fatura; conta fora do escopo reserva da data em diante).
    // VIGÊNCIA: só meses a partir da criação do orçamento (listCommitments).
    for (const c of commitments) {
      // Compromisso cuja fatura venceu até a data da compra não reserva mais
      // (intervalo vazio — mesma regra do ajuste que substituiu).
      if (c.invoiceDue && c.invoiceDue <= c.data) continue;
      itens.push({
        id: `bud:${c.txId}`,
        origem: 'ORCAMENTO',
        data: c.data,
        valorCents: c.valorCents,
        status: c.status,
        descricao: c.descricao || 'Orçamento',
        refId: c.txId,
      });
      // Reversão da reserva: quando a fatura vence, ela assume o compromisso
      // (item de fatura) — a reserva do orçamento termina ali (sem dobro).
      if (c.invoiceDue && c.invoiceDue > c.data && c.invoiceDue <= `${month}-${String(lastDayNumberOf(month)).padStart(2, '0')}`) {
        itens.push({
          id: `budrev:${c.txId}`,
          origem: 'ORCAMENTO',
          data: c.invoiceDue,
          valorCents: -c.valorCents,
          status: c.status,
          descricao: 'Fatura assume o compromisso do orçamento',
          refId: c.txId,
        });
      }
    }

    // --- PROGRAMACAO: reserva do mês planejado (o que ENTRA no mês visto).
    // Mês fora do plano (passado ou não planejado) devolve zero → sem item.
    if (wishlistOn && wishMonthPlan.faltaInicioCents !== 0) {
      itens.push({
        id: `prog:${month}`,
        origem: 'PROGRAMACAO',
        data: `${month}-01`,
        valorCents: -wishMonthPlan.faltaInicioCents,
        status: 'PENDENTE',
        descricao: 'Programação de Compra · reserva do mês',
        refId: month,
      });
    }

    return itens;
  }, [movesRows, invoicesDue, commitments, savingsSum, savingsPlans, wishlistOn, wishMonthPlan, month]);

  // ---------- 1 CÁLCULO SÓ (v36): função PURA, em memória, sem db ----------
  const fluxoCalculado = React.useMemo(
    () => calcularFluxo(itensFluxo, aberturaCents),
    [itensFluxo, aberturaCents]
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

  // ---------- Saldo do dia (v36) ----------
  // O CÁLCULO ANTIGO SAIU: getDailyBalancesDual + budAdj (mergeDailyAdjust) +
  // savAdj + override do closing do livro no dia-alvo. Agora o saldo exibido
  // é EXCLUSIVAMENTE o resultado de calcularFluxo (itensFluxo + abertura).

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
  }, [entries, filter, showDaily, month]);

  // ---------- Saldo do dia por dia (v36) ----------
  const saldosByDay = React.useMemo(() => {
    const m = new Map<string, { previstoCents: number; efetivadoCents: number }>();
    for (const d of fluxoCalculado.dias) m.set(d.data, d);
    // Ponto 6: NUNCA em branco — um dia com linha na tela mas sem item próprio
    // (ex.: dia do cabeçalho de um grupo) mostra o saldo CARREGADO até ali.
    const asc = [...fluxoCalculado.dias].reverse(); // ordem crescente
    const saldoCarregado = (dia: string) => {
      let prev: { previstoCents: number; efetivadoCents: number } | null = null;
      for (const d of asc) {
        if (d.data < dia) prev = d;
        else break;
      }
      return prev ?? { previstoCents: aberturaCents, efetivadoCents: aberturaCents };
    };
    for (const [day] of days) {
      if (!m.has(day)) m.set(day, saldoCarregado(day));
    }
    return m;
  }, [fluxoCalculado, days, aberturaCents]);

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
      // v36: o saldo do dia vem do calcularFluxo (memória) — saldosByDay.
      const saldo = saldosByDay.get(day);
      rows.push({
        kind: 'day',
        key: `day:${day}`,
        day,
        prev: saldo?.previstoCents,
        efet: saldo?.efetivadoCents,
      });
      list.forEach((entry, i) => rows.push({ kind: 'entry', key: `${day}:${i}:${entryId(entry)}`, entry }));
    }
    return rows;
  }, [days, saldosByDay]);

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
                <Text className={`text-xs font-semibold ${item.efet < 0 ? 'text-rose-500' : 'text-slate-500'}`}>
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


  // ================= v36 — ORDEM OBRIGATÓRIA DAS ALTERAÇÕES =================
  // mexe na LISTA EM MEMÓRIA → calcularFluxo recalcula (via estado) →
  // renderiza NA HORA → salva no banco em background. Sem recarregar a tela,
  // sem "Carregando...", sem consultar o banco para recalcular. Se o salvar
  // falhar, a lista VOLTA para o valor antigo e mostra o erro.
  // ==========================================================================

  /** Patch de STATUS de um tx em TODAS as cópias do estado (raiz, cabeçalho/
   *  ocorrências de grupo, filhos à vista). */
  const patchTxStatusEmMemoria = (txId: string, status: string) => {
    setTxs((cur) => cur.map((t) => (t.id === txId ? { ...t, status } : t)));
    setGroupMonths((cur) => {
      const next: Record<string, GroupMonth> = {};
      for (const [gid, g] of Object.entries(cur)) {
        next[gid] = {
          ...g,
          header: g.header.id === txId ? { ...g.header, status } : g.header,
          occurrences: g.occurrences.map((t) => (t.id === txId ? { ...t, status } : t)),
        };
      }
      return next;
    });
    setChildrenMap((cur) => {
      const next: Record<string, FlowTx[]> = {};
      for (const [gid, list] of Object.entries(cur)) {
        next[gid] = list.map((t) => (t.id === txId ? { ...t, status } : t));
      }
      return next;
    });
    // A lista em memória do saldo usa o status do MOVIMENTO — espelha o tx.
    setMovesRows((cur) =>
      cur.map((m) => {
        if (m.txId !== txId) return m;
        if (status === 'CONFIRMED') return { ...m, status: 'CONFIRMED', txStatus: 'CONFIRMED' };
        return { ...m, status: 'VOIDED', txStatus: 'PENDING' };
      })
    );
  };

  /** Patch de status de PARCELA (em conta) nas cópias do estado + movimentos. */
  const patchInstStatusEmMemoria = (installmentId: string, status: string) => {
    setAccountInst((cur) => cur.map((i) => (i.installmentId === installmentId ? { ...i, status } : i)));
    setGroupMonths((cur) => {
      const next: Record<string, GroupMonth> = {};
      for (const [gid, g] of Object.entries(cur)) {
        next[gid] = { ...g, installments: g.installments.map((i) => (i.installmentId === installmentId ? { ...i, status } : i)) };
      }
      return next;
    });
    setMovesRows((cur) => cur.map((m) => (m.installmentId === installmentId ? { ...m, instStatus: status } : m)));
  };

  /** Remove transações (e movimentos) e/ou parcelas da lista em memória. */
  const removerEmMemoria = (txIds: Set<string>, instIds: Set<string>) => {
    if (txIds.size === 0 && instIds.size === 0) return;
    setTxs((cur) => cur.filter((t) => !txIds.has(t.id)));
    setGroupMonths((cur) => {
      const next: Record<string, GroupMonth> = {};
      for (const [gid, g] of Object.entries(cur)) {
        if (txIds.has(gid)) continue; // cabeçalho do grupo excluído
        next[gid] = { ...g, occurrences: g.occurrences.filter((t) => !txIds.has(t.id)) };
      }
      return next;
    });
    setChildrenMap((cur) => {
      const next: Record<string, FlowTx[]> = {};
      for (const [gid, list] of Object.entries(cur)) {
        if (txIds.has(gid)) continue;
        next[gid] = list.filter((t) => !txIds.has(t.id));
      }
      return next;
    });
    setAccountInst((cur) => cur.filter((i) => !instIds.has(i.installmentId)));
    setMovesRows((cur) =>
      cur.filter((m) => !(m.txId && txIds.has(m.txId)) && !(m.installmentId && instIds.has(m.installmentId)))
    );
  };

  /** Snapshot/rollback do estado que as mutações mexem. */
  const snapshotFluxo = () => ({ txs, groupMonths, childrenMap, movesRows, accountInst });
  const restaurarFluxo = (
    snap: ReturnType<typeof snapshotFluxo>,
    extra?: { savingsSum: SavingsMonthOverview | null }
  ) => {
    setTxs(snap.txs);
    setGroupMonths(snap.groupMonths);
    setChildrenMap(snap.childrenMap);
    setMovesRows(snap.movesRows);
    setAccountInst(snap.accountInst);
    if (extra) setSavingsSum(extra.savingsSum);
  };

  /** v36 — recalcula o resumo do card da Poupança EM MEMÓRIA a partir das
   *  entradas restantes (o card acompanha a lista sem nova consulta ao banco). */
  const recomputarSavingsSum = (entries: SavingsEntryView[]): SavingsMonthOverview | null => {
    if (!savingsSum) return null;
    const ativos = new Set(savingsPlans.filter((p) => p.is_active === 1).map((p) => p.id));
    const planned = entries
      .filter((e) => e.planId == null || ativos.has(e.planId))
      .reduce((a, b) => a + b.amountCents, 0);
    const effected = entries.filter((e) => e.effected).reduce((a, b) => a + b.amountCents, 0);
    const plans = savingsSum.plans.map((p) => {
      const own = entries.filter((e) => e.planId === p.planId);
      const guardado = own.filter((e) => e.effected).reduce((a, b) => a + b.amountCents, 0);
      const programado = own.reduce((a, b) => a + b.amountCents, 0);
      return { ...p, guardadoCents: guardado, faltaCents: Math.max(0, programado - guardado) };
    });
    return {
      ...savingsSum,
      entries,
      plannedCents: planned,
      programadoCents: planned + (savingsSum.closingSuggestion?.amountCents ?? 0),
      effectedCents: effected,
      plans,
    };
  };

  /** v36 — mapa txId → ocorrência de poupança (plano, pago?) da lista em memória. */
  const poupancaPorTx = React.useMemo(() => {
    const m = new Map<string, { planId: string; effected: boolean }>();
    const planoPorId = new Map(savingsPlans.map((p) => [p.id, p]));
    for (const e of savingsSum?.entries ?? []) {
      if (!e.transactionId || !e.planId) continue;
      const plano = planoPorId.get(e.planId);
      if (!plano || plano.is_active !== 1) continue;
      if (e.kind === 'MONTHLY') {
        const criacao = (plano.created_at ?? '').slice(0, 10);
        if (!e.date || !ocorrenciaNaVigencia(e.date, criacao)) continue;
      }
      m.set(e.transactionId, { planId: e.planId, effected: e.effected });
    }
    return m;
  }, [savingsSum, savingsPlans]);

  /** v36 — gravação em background: marca o livro-razão sujo e invalida os
   *  caches dos serviços (sem bump — a tela NÃO recarrega). */
  const invalidarPosSalvar = (mes: string = month) => {
    void (async () => {
      try {
        await services.monthLedger.markDirty(mes);
      } catch { /* best-effort */ }
    })();
    try {
      services.budgets.invalidateAll();
      services.savings.invalidateMonth(mes);
      services.wishlist.invalidateListOpen();
      services.balance.invalidateDaily(mes);
    } catch { /* best-effort */ }
  };

  // ---------- Exclusão FÍSICA (v10) — v21 (bug 4): exige CONFIRMAÇÃO ----------
  const doExcluirTx = async (tx: FlowTx) => {
    const snap = snapshotFluxo();
    const ehGrupo = tx.kind === 'CONSOLIDATED' && tx.source_system !== 'INSTALLMENT';
    // 1) LISTA EM MEMÓRIA: sai agora — o saldo volta na hora.
    if (ehGrupo) {
      const grp = groupMonths[tx.id];
      const ids = new Set<string>([tx.id, ...(childrenMap[tx.id] ?? []).map((c) => c.id), ...(grp?.occurrences ?? []).map((o) => o.id)]);
      const instIds = new Set<string>((grp?.installments ?? []).map((i) => i.installmentId));
      removerEmMemoria(ids, instIds);
    } else {
      removerEmMemoria(new Set([tx.id]), new Set());
    }
    try {
      // 2) BANCO em background.
      // v12 (UX): CONSOLIDADO → exclusão do GRUPO INTEIRO (linhas à vista +
      // contas fixas criadas dentro + parcelamentos criados dentro).
      if (ehGrupo) await services.transactions.deleteGroupDeep(tx.id);
      else await services.transactions.deleteTransaction(tx.id);
      invalidarPosSalvar();
    } catch (err) {
      // 3) Falhou: a lista volta e o erro aparece.
      restaurarFluxo(snap);
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v11 (Req 1): exclusão de PARCELA em conta — regra padrão: da parcela em
   *  diante (pagas ficam intactas e o custo total é recalculado).
   *  v21 (bug 4): só roda após a confirmação, que também oferece "apenas esta". */
  const doExcluirParcela = async (info: { planId: string; sequence: number }, onlyOne: boolean) => {
    const snap = snapshotFluxo();
    // 1) LISTA EM MEMÓRIA: as parcelas do plano a partir da escolha saem agora.
    const instIds = new Set<string>(
      [...accountInst, ...Object.values(groupMonths).flatMap((g) => g.installments)]
        .filter((i) => i.planId === info.planId && (onlyOne ? i.sequenceNumber === info.sequence : i.sequenceNumber >= info.sequence))
        .map((i) => i.installmentId)
    );
    removerEmMemoria(new Set(), instIds);
    try {
      // 2) BANCO em background.
      await services.installments.cancelFromSequence(info.planId, info.sequence, { onlyOne });
      invalidarPosSalvar();
    } catch (err) {
      // 3) Falhou: volta.
      restaurarFluxo(snap);
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /**
   * v36 — CANCELAR SÓ A OCORRÊNCIA DE UM MÊS da poupança (linha da lista com
   * chip de transferência do plano): a ocorrência do mês visto sai da lista
   * NA HORA (saldo volta) e o banco é atualizado em background; o plano
   * inteiro continua — as demais ocorrências ficam.
   */
  const doCancelarOcorrenciaPoupanca = async (tx: FlowTx, planId: string) => {
    const snap = snapshotFluxo();
    const snapSum = savingsSum;
    // 1) LISTA EM MEMÓRIA: o lançamento do mês sai agora.
    removerEmMemoria(new Set([tx.id]), new Set());
    if (savingsSum) {
      const entries = savingsSum.entries.filter((e) => e.transactionId !== tx.id);
      setSavingsSum(recomputarSavingsSum(entries));
    }
    try {
      // 2) BANCO em background (marca CANCELED no mês + apaga a pendente).
      await services.savings.cancelarOcorrenciaMes(planId, month);
      invalidarPosSalvar();
    } catch (err) {
      // 3) Falhou: volta.
      restaurarFluxo(snap, { savingsSum: snapSum });
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
   *  conta; itens de CARTÃO não entram — são pagos pela fatura).
   *  v36: mexe na lista em memória primeiro, salva depois. */
  const toggleGroupPayment = async (grp: GroupMonth) => {
    const children = childrenMap[grp.header.id] ?? [];
    const info = groupStatusInfo(grp, children);
    if (!info) return;
    const next = !info.allDone;
    const { txs: grpTxs, insts } = groupStatusItems(grp, children);
    const snapTxs = txs;
    const snapGM = groupMonths;
    const snapChildren = childrenMap;
    const snapMoves = movesRows;
    const snapInst = accountInst;
    // 1) LISTA EM MEMÓRIA: todos os itens do agrupamento mudam de uma vez.
    for (const t of grpTxs) patchTxStatusEmMemoria(t.id, next ? 'CONFIRMED' : 'PENDING');
    for (const i of insts) patchInstStatusEmMemoria(i.installmentId, next ? 'PAID' : 'PENDING');
    try {
      // 2) BANCO em background — v87 (BUG MÉDIA): tudo ou nada.
      await services.db.transactionAsync(async () => {
        for (const t of grpTxs) {
          await services.transactions.setPaymentStatus(t.id, next);
        }
        for (const i of insts) {
          await services.installments.setPaymentStatus(i.installmentId, next);
        }
      });
      invalidarPosSalvar();
    } catch (err) {
      // 3) Falhou: volta.
      setTxs(snapTxs); setGroupMonths(snapGM); setChildrenMap(snapChildren); setMovesRows(snapMoves); setAccountInst(snapInst);
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
        <Text className={`text-xs font-bold ${txt}`}>{label}</Text>
      </Pressable>
    );
  };

  /** v9: alternar Pago/Não pago (despesa) e Recebido/Não recebido (receita).
   *  v36: mexe na lista em memória → recalc → renderiza → salva em background.
   *  Mudou PAGO/PENDENTE: só o Efetivado muda na hora; o Previsto fica igual. */
  const togglePayment = async (tx: FlowTx) => {
    const nowPaid = tx.status !== 'PENDING';
    const anterior = tx.status;
    patchTxStatusEmMemoria(tx.id, nowPaid ? 'PENDING' : 'CONFIRMED');
    try {
      await services.transactions.setPaymentStatus(tx.id, !nowPaid);
      invalidarPosSalvar();
    } catch (err) {
      patchTxStatusEmMemoria(tx.id, anterior);
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
        <Text className={`text-xs font-bold ${txt}`}>{label}</Text>
      </Pressable>
    );
  };

  /** v89: chip "Transferido / Não transferido" — SÓ nas transferências
   *  previstas pelo plano de poupança (MONTHLY/CLOSING ativo), no mesmo
   *  lugar do chip Pago/Não pago. Alterna PENDING↔CONFIRMED pelos moves.
   *  v36: usa a MESMA lista em memória (poupancaPorTx, já com vigência). */
  const renderSavingsChip = (tx: FlowTx) => {
    if (!poupancaPorTx.has(tx.id) || tx.status === 'VOIDED') return null;
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
        <Text className={`text-xs font-bold ${txt}`}>{label}</Text>
      </Pressable>
    );
  };
  /** v89: alterna Transferido/Não transferido da transferência do plano.
   *  v36: mexe na lista em memória → recalc → renderiza → salva em background.
   *  Mudou PAGO/PENDENTE: só o Efetivado muda na hora; o Previsto fica igual. */
  const toggleTransfer = async (tx: FlowTx) => {
    const nowTransferred = tx.status !== 'CONFIRMED';
    const anterior = tx.status;
    patchTxStatusEmMemoria(tx.id, nowTransferred ? 'CONFIRMED' : 'PENDING');
    try {
      await services.transactions.setTransferStatus(tx.id, nowTransferred);
      invalidarPosSalvar();
    } catch (err) {
      patchTxStatusEmMemoria(tx.id, anterior);
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v10: toggle Pago/Não pago das PARCELAS em conta (mesmo visual dos comuns).
   *  v36: mexe na lista em memória → recalc → renderiza → salva em background. */
  const toggleInstallment = async (inst: InstAgg) => {
    const anterior = inst.status;
    patchInstStatusEmMemoria(inst.installmentId, inst.status !== 'PAID' ? 'PAID' : 'PENDING');
    try {
      await services.installments.setPaymentStatus(inst.installmentId, inst.status !== 'PAID');
      invalidarPosSalvar();
    } catch (err) {
      patchInstStatusEmMemoria(inst.installmentId, anterior);
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
  // v25: a conta só aparece na linha quando o mês tem lançamentos em mais de uma.
  const multiAccount = React.useMemo(() => new Set(txs.map((t) => t.account_name).filter(Boolean)).size > 1, [txs]);
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
        (tx.type === 'TRANSFER' ||
          ((tx.type === 'INCOME' || tx.type === 'EXPENSE') && tx.kind === 'SIMPLE' && !tx.card_id)),
      title: tx.description,
      voided: tx.status === 'VOIDED',
      subtitle:
        `${ymdToBr(tx.occurred_on)}` +
        `${tx.category_name ? ` · ${tx.category_name}` : ''}` +
        `${tx.card_name ? ` · ${tx.card_name}` : ''}` +
        `${tx.account_name && tx.type === 'TRANSFER' ? ` · ${tx.account_name} → ${tx.transfer_account_name}` : tx.account_name && multiAccount ? ` · ${tx.account_name}` : ''}`,
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
          {!opts.child && (tx.source_system === 'OFX_BANK' || tx.source_system === 'OFX_CARD' || tx.source_system === 'NFCE') ? (
            <Text className="text-xs text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">{sourceLabel(tx.source_system)}</Text>
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
      // v36: transferência do PLANO DE POUPANÇA → cancelar SÓ A OCORRÊNCIA do
      // mês visto (o plano continua); ocorrência PAGA não se cancela (histórico).
      onExcluir: opts.child
        ? null
        : poupancaPorTx.has(tx.id)
          ? poupancaPorTx.get(tx.id)!.effected
            ? null
            : () => setConfirm({ kind: 'poupanca', tx, planId: poupancaPorTx.get(tx.id)!.planId, description: tx.description })
          : tx.kind === 'CONSOLIDATED' && tx.source_system !== 'INSTALLMENT'
            ? () => setConfirm({ kind: 'group', tx })
            : () => setConfirm({ kind: 'tx', tx }),
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
          settled: tx.status !== 'VOIDED' && !!groupStatusInfo(grp, childrenMap[tx.id] ?? [])?.allDone,
          title: tx.description,
          // v88 (BUG): a data exibida é a DO MÊS VISTO (não a do lançamento) —
          // antes, ao passar os meses, a data ficava presa na data original.
          subtitle: `${ymdToBr(groupMonthDate(grp))} · ${itemCount} item(ns) neste mês`,
          chips: (
            <>
              <Text className="text-xs text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded font-semibold">
                {ICONS.consolidado} CONSOLIDADO
              </Text>
              {tx.source_system !== 'MANUAL' ? (
                <Text className="text-xs text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">{sourceLabel(tx.source_system)}</Text>
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
        settled={paid}
        subtitle={`Vence ${ymdToBr(inv.dueDate)} · ${inv.items.length} lançamento(s) ${paid ? '· quitada' : '· total − antecipados'}`}
        chips={
          <>
            <Badge status={inv.liveStatus} />
            <Text className="text-xs text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">FATURA</Text>
          </>
        }
        amount={`−${formatBRL(inv.dueCents)}`}
        amountClass={paid ? undefined : 'text-rose-600'}
        borderClass={paid ? undefined : 'border-rose-300'}
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
        <Text className={`text-xs font-bold ${txt}`}>{label}</Text>
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
            <Text className="text-xs text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">{sourceLabel('INSTALLMENT')}</Text>
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
            <Text className="text-xs text-slate-500">
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
                          <Text className="text-xs text-slate-400">
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
  // v36: mexe na lista em memória primeiro (saldo do dia muda na hora),
  // salva (o próprio efetivarFechamento grava) e só invalida caches depois.
  const [efetivandoFechamento, setEfetivandoFechamento] = React.useState(false);
  const onEfetivarFechamento = async () => {
    if (!savingsSum) return;
    if (efetivandoFechamento) return;
    setEfetivandoFechamento(true);
    const snapSum = savingsSum;
    const snapMoves = movesRows;
    try {
      const r = await services.savings.efetivarFechamento(month);
      if (r.efetivadas > 0) {
        // 1) LISTA EM MEMÓRIA: a transferência do fechamento entra como PAGO
        //    no último dia do mês (o saldo do dia muda na hora, sem recarregar).
        const fecha = `${month}-${String(lastDayNumberOf(month)).padStart(2, '0')}`;
        const entryAntiga = savingsSum.entries.find((e) => e.kind === 'CLOSING' && e.transactionId);
        if (entryAntiga?.transactionId) {
          patchTxStatusEmMemoria(entryAntiga.transactionId, 'CONFIRMED');
          const entries = savingsSum.entries.map((e) => (e.kind === 'CLOSING' && e.transactionId === entryAntiga.transactionId ? { ...e, effected: true } : e));
          setSavingsSum(recomputarSavingsSum(entries));
        } else {
          setMovesRows((cur) => [
            ...cur,
            {
              moveId: `poup-fech-${month}`,
              txId: `poup-fech-tx-${month}`,
              data: fecha,
              amount: r.amountCents,
              direction: 'DEBIT',
              status: 'CONFIRMED',
              txStatus: 'CONFIRMED',
              txType: 'TRANSFER',
              descricao: 'Poupança · fechamento do mês',
              instStatus: null,
              installmentId: null,
              entryIdPoupanca: `poup-fech-entry-${month}`,
              planIdPoupanca: null,
            },
          ]);
          setSavingsSum(
            recomputarSavingsSum([
              ...savingsSum.entries,
              {
                id: `poup-fech-entry-${month}`,
                planId: null,
                month,
                kind: 'CLOSING',
                amountCents: r.amountCents,
                effected: true,
                transactionId: `poup-fech-tx-${month}`,
                date: fecha,
                description: 'Poupança · fechamento do mês',
              },
            ])
          );
        }
        invalidarPosSalvar();
        showToast(`Fechamento de ${formatBRL(r.amountCents)} transferido`);
      } else {
        showToast('Sem sobra para guardar neste mês — nada a efetivar');
      }
    } catch (err) {
      // Falhou: a lista volta para o valor antigo + erro.
      setSavingsSum(snapSum);
      setMovesRows(snapMoves);
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

  /** v25 (menos é mais): com 2+ módulos ativos (Orçamento, Programação,
   *  Poupança) o topo do Fluxo mostra UMA linha recolhida "Resumo do mês";
   *  com 1 só, o card aparece direto. */
  const modulosMes = [budgetCard, wishlistCard, savingsCard].filter(Boolean);
  const resumoMes =
    modulosMes.length >= 2 ? (
      <View className="gap-3">
        <Pressable
          onPress={() => setResumoOpen((v) => !v)}
          accessibilityLabel={resumoOpen ? 'Recolher resumo do mês' : 'Expandir resumo do mês'}
        >
          <Card className="!py-3 flex-row items-center justify-between">
            <Text className="font-semibold text-slate-900">Resumo do mês</Text>
            <Text className="text-xs text-slate-500">
              {[budgetCard ? 'Orçamento' : null, wishlistCard ? 'Programação' : null, savingsCard ? 'Poupança' : null]
                .filter(Boolean)
                .join(' · ')}{' '}
              {resumoOpen ? ICONS.recolher : ICONS.expandir}
            </Text>
          </Card>
        </Pressable>
        {resumoOpen ? modulosMes : null}
      </View>
    ) : (
      modulosMes
    );

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
              {resumoMes}
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
      {/* v36: cancelar SÓ a ocorrência do mês visto da poupança — o plano
          inteiro continua (as demais ocorrências ficam). */}
      <ConfirmDialog
        visible={confirm?.kind === 'poupanca'}
        title="Cancelar só esta ocorrência?"
        message={
          confirm?.kind === 'poupanca'
            ? `"${confirm.description}" (${ymdToBr(confirm.tx.occurred_on)}) sai de ${ymdToBr(confirm.tx.occurred_on).slice(3)} — a ocorrência dos OUTROS meses continua. O plano de poupança não é apagado.`
            : undefined
        }
        buttons={[
          {
            label: 'Cancelar só este mês',
            color: 'red',
            onPress: () => {
              if (confirm?.kind === 'poupanca') doCancelarOcorrenciaPoupanca(confirm.tx, confirm.planId);
              setConfirm(null);
            },
          },
          { label: 'Manter', color: 'green', onPress: () => setConfirm(null) },
        ]}
        onClose={() => setConfirm(null)}
      />
    </Screen>
  );
}
