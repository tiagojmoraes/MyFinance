/** Tela Lançamento — 4 tipos com tema por cor (v7.1):
 *  Despesa (VERMELHO) · Receita (VERDE) · Transferência (PRETO) · Consolidado (VIOLETA).
 *  v14 — CONSOLIDADO: PARCELADO passa a valer também para RECEITA (linha
 *  Crédito + Parcelado — aluguel 36x, corretagem 36x, obras 5x): em CONTA cada
 *  parcela nasce como CRÉDITO na data do vencimento; no CARTÃO o item entra
 *  NEGATIVO na fatura (abate o total). O campo do grupo passa a se chamar
 *  apenas "Conta do grupo" (melhoria 2).
 *  v13 — CONSOLIDADO: cada linha Fixo/Parcelado escolhe o DESTINO — a conta do
 *  grupo OU um CARTÃO DE CRÉDITO. O PARCELADO no cartão dentro do grupo
 *  funciona de ponta a ponta (bug 1.C): as parcelas nascem direto na FATURA.
 *  v7.1: seletor de tipo por PICTOGRAMAS (mapa único de ícones);
 *  campo Valor em pt-BR estrito (MoneyInput v10: máscara "0,00", digitação da
 *  DIREITA para a ESQUERDA, centavos fixos, milhar com ponto, máx 999.999.999,00).
 *  v10 — regras novas:
 *   · SEM ALERTAS DE SUCESSO: ao salvar/alterar, o app fecha a tela e vai
 *     DIRETO PARA O FLUXO (sem modal/snackbar/popup de confirmação);
 *   · CONSOLIDADO: a exigência de ao menos uma linha "À Vista" foi REMOVIDA
 *     (pode salvar só com linhas Fixo/Parcelado); cada linha tem seletor de
 *     CATEGORIA (válido para débito e para crédito); a "Descrição do Grupo
 *     Geral" é a que aparece no Fluxo (sem texto padrão);
 *   · DESPESA FIXA em CARTÃO DESBLOQUEADA: a conta fixa mensal no cartão
 *     entra na FATURA do mês do vencimento;
 *   · ALTERAR GRUPO: o cabeçalho do consolidado abre em modo edição
 *     (Descrição do Grupo Geral, data e linhas editáveis no mesmo formulário).
 *  v41 — QR CODE NO NOVO LANÇAMENTO (pedido do usuário): a leitura da NFC-e
 *   NÃO cria lançamento sozinha — a nota PREENCHE este formulário: o valor
 *   passa a ser o TOTAL da nota, descrição e data vêm do cabeçalho e um card
 *   "Itens da nota fiscal" aparece com um botão ESTOQUE (sim/não) em CADA
 *   item. Todas as opções da tela seguem valendo: categoria (item ▸ subitem),
 *   pagamento (conta/cartão), mês da fatura, data, descrição, modalidade.
 *   Ao salvar em Despesa À vista, a nota é anexada ao lançamento e o estoque
 *   recebe os itens marcados (os outros ficam para revisão na tela NFC-e).
 */

import React from 'react';
import { View, Text, ScrollView,  Pressable } from 'react-native';
import { showToast } from '../lib/toast';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen, Card, TextField, Select, Button, DateField, Segmented, QrGlyph } from '../src/components/ui';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { CategorySelect, categoryMatchesFilter, type CategoryOption } from '../src/components/CategorySelect';
import { NfceScannerModal } from '../src/components/NfceScannerModal';
import { MoneyInput } from '../src/components/MoneyInput';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { extractAccessKey as extractAccessKeyNfce, type NfceHeader } from '../src/parsers/nfce';
import type { NfcePreparedItem } from '../src/services/NfceService';
import { nfceLog, nfceHtmlSummary } from '../src/lib/nfcelog';
import { kindTheme, theme, type TxKind } from '../src/theme';
import { ICONS } from '../src/theme/icons';
import { todaySP, spDateOfIso, monthOf, monthAdd, monthLabel, lastDayOfMonth } from '../src/lib/dates';
import { formatBRL, divideCents } from '../src/lib/money';
import { consolidatedGroupTotals } from '../src/lib/consolidado';

const KIND_ICONS: Record<TxKind, string> = {
  EXPENSE: ICONS.despesa,
  INCOME: ICONS.receita,
  TRANSFER: ICONS.transferencia,
  CONSOLIDATED: ICONS.consolidado,
};

type Modality = 'AVISTA' | 'FIXO' | 'PARCELADO';

/** v68 "Repetir": cadência do Fixo e do Parcelado — Semanal para todas as
 *  semanas; Mensal para todos os meses; Bimestral para todos os bimestres;
 *  Trimestral, Semestral e Anual. */
type Repeat = 'SEMANAL' | 'MENSAL' | 'BIMESTRAL' | 'TRIMESTRAL' | 'SEMESTRAL' | 'ANUAL';

/** v68: mapa Repetir → cadência do banco (step_days para semanal;
 *  step_months para as demais). */
function repeatToStep(r: Repeat): { stepMonths: number; stepDays: number | null } {
  if (r === 'SEMANAL') return { stepMonths: 1, stepDays: 7 };
  const months: Record<Exclude<Repeat, 'SEMANAL'>, number> = {
    MENSAL: 1, BIMESTRAL: 2, TRIMESTRAL: 3, SEMESTRAL: 6, ANUAL: 12,
  };
  return { stepMonths: months[r], stepDays: null };
}

function repeatFromStep(stepMonths: number | null | undefined, stepDays: number | null | undefined): Repeat {
  if (stepDays && stepDays > 0) return 'SEMANAL';
  const repeats: Record<number, Repeat> = {
    1: 'MENSAL',
    2: 'BIMESTRAL',
    3: 'TRIMESTRAL',
    6: 'SEMESTRAL',
    12: 'ANUAL',
  };
  return repeats[stepMonths ?? 1] ?? 'MENSAL';
}

/** v10: linha do consolidado — direção EXPLÍCITA (Débito/Crédito) + modalidade
 *  À vista / Fixo / Parcelado (mesmo comportamento das demais formas) + CATEGORIA
 *  por linha (v10 — vale para débito e para crédito).
 *  À vista = linha do grupo; Fixo = conta fixa; Parcelado = plano (só débito).
 *  v13 (bug 1.C): linhas Fixo/Parcelado escolhem o DESTINO — a CONTA do grupo
 *  ou um CARTÃO DE CRÉDITO (parcelas/ocorrências vão para a FATURA do cartão).
 *  v21 (melhoria 1): linha PARCELADO ganha o seletor de CÁLCULO — "Dividir
 *  total" (reparte o valor entre as parcelas) ou "Parcela fixa" (repete o
 *  valor informado por mês) — igual ao Parcelado do formulário simples.
 *  v69: linha Fixo/Parcelado ganha o PRÓPRIO "Repetir" em BOTÕES (cores da
 *  direção da linha — débito rose / crédito emerald). */
interface ConsolidatedLine {
  key: number;
  dir: 'DEBIT' | 'CREDIT';
  description: string;
  cents: number;
  modality: 'AVISTA' | 'FIXO' | 'PARCELADO';
  parcelas: string;
  categoryId: string | null;
  /** v13: destino da linha Fixo/Parcelado (À vista fica sempre na conta do grupo). */
  target: 'ACCOUNT' | 'CARD';
  cardId: string | null;
  /** v21 (melhoria 1): modo de cálculo da linha parcelada. */
  planMode: 'DIVIDE_TOTAL' | 'FIXED_PER_MONTH';
  /** v26: "mês da fatura" escolhido para linha Fixo/Parcelado no CARTÃO (null = sugerido pelo fechamento). */
  invoiceMonth: string | null;
  /** v69: cadência "Repetir" da linha (Fixo/Parcelado). */
  repeat: Repeat;
  persistedId?: string;
  persistedKind?: 'AVISTA' | 'FIXO' | 'PARCELADO';
  persistedPlanId?: string;
  persistedAnchorId?: string;
  persistedDir?: 'DEBIT' | 'CREDIT';
  persistedModality?: Modality;
  persistedTarget?: 'ACCOUNT' | 'CARD';
  persistedCardId?: string | null;
  persistedPlanMode?: 'DIVIDE_TOTAL' | 'FIXED_PER_MONTH';
  persistedParcelas?: string;
  persistedRepeat?: Repeat;
  persistedCents?: number;
  pendingInstallments?: number;
  paidCents?: number;
}

let lineKeySeq = 1;

/** v69 — BOTÕES de "Repetir" (Semanal → Anual) no esquema de cores do tipo
 *  (débito = rose, crédito = emerald): o usuário CLICA e escolhe a cadência —
 *  no formulário simples (Fixo/Parcelado) e em CADA linha do Consolidado. */
type RepeatTone = 'rose' | 'emerald';
export function RepeatButtons({ value, onChange, tone }: {
  value: Repeat;
  onChange: (v: Repeat) => void;
  tone: RepeatTone;
}) {
  const solid = tone === 'rose' ? 'bg-rose-600' : 'bg-emerald-600';
  const soft = tone === 'rose' ? 'bg-rose-50 border border-rose-200' : 'bg-emerald-50 border border-emerald-200';
  const softText = tone === 'rose' ? 'text-rose-700' : 'text-emerald-700';
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {REPEAT_BUTTONS.map((o) => {
        const active = value === o.value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="button"
            accessibilityLabel={`Repetir ${o.label}`}
            className={`px-2.5 py-2 rounded-lg border ${active ? `${solid} border-transparent` : soft}`}
          >
            <Text className={`text-xs font-bold ${active ? 'text-white' : softText}`}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** v69: rótulos curtos dos botões (a explicação longa fica no texto abaixo). */
const REPEAT_BUTTONS: Array<{ value: Repeat; label: string }> = [
  { value: 'SEMANAL', label: 'Semanal' },
  { value: 'MENSAL', label: 'Mensal' },
  { value: 'BIMESTRAL', label: 'Bimestral' },
  { value: 'TRIMESTRAL', label: 'Trimestral' },
  { value: 'SEMESTRAL', label: 'Semestral' },
  { value: 'ANUAL', label: 'Anual' },
];

/** v41: rótulo do casamento produto↔item (mesma semântica da revisão NFC-e). */
function nfceMatchBadge(it: NfcePreparedItem): { text: string; cls: string } {
  switch (it.matchType) {
    case 'EAN':
      return { text: 'auto · EAN', cls: 'text-emerald-700 bg-emerald-50' };
    case 'ALIAS':
      return { text: 'auto · código da loja', cls: 'text-emerald-700 bg-emerald-50' };
    case 'FUZZY': {
      const pct = it.matchScore != null ? Math.round(it.matchScore * 100) : null;
      if (it.matchScore != null && it.matchScore >= 0.94) {
        return { text: `auto · parecido (${pct}%)`, cls: 'text-emerald-700 bg-emerald-50' };
      }
      return { text: `sugestão${pct != null ? ` ${pct}%` : ''} — confirme`, cls: 'text-amber-700 bg-amber-50' };
    }
    case 'MANUAL':
      return { text: 'sua decisão', cls: 'text-sky-700 bg-sky-50' };
    case 'NEW':
      return { text: 'novo — classifique uma vez', cls: 'text-amber-700 bg-amber-50' };
    default:
      return it.productId
        ? { text: 'vinculado', cls: 'text-sky-700 bg-sky-50' }
        : { text: 'produto não vinculado', cls: 'text-slate-500 bg-slate-100' };
  }
}

/** v9: mês da fatura sugerido para uma data (dia <= fechamento -> mês atual; senão próximo). */
function suggestInvoiceMonth(closingDay: number, dateYmd: string): string {
  const ym = monthOf(dateYmd);
  const [ys, ms] = ym.split('-').map((x) => parseInt(x, 10));
  const closing = Math.min(closingDay, lastDayOfMonth(ys, ms));
  const day = parseInt(dateYmd.slice(8, 10), 10);
  return day <= closing ? ym : monthAdd(ym, 1);
}

export default function LancamentoScreen() {
  const params = useLocalSearchParams<{ card?: string; dup?: string; edit?: string; msg?: string; nfce?: string }>();
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);

  const [kind, setKind] = React.useState<TxKind>('EXPENSE');
  const ks = kindTheme[kind];
  const [dupFrom, setDupFrom] = React.useState<string | null>(null);
  /** v69: mensagem bancária vinda da tela "Mensagens bancárias" (botão Lançar) —
   *  preenche o formulário (débito/crédito, valor, data e descrição); ao SALVAR,
   *  a mensagem é marcada como lançada e o OFX já importado é conciliado
   *  automaticamente por data + valor. */
  const [msgId, setMsgId] = React.useState<string | null>(null);
  const [msgInfo, setMsgInfo] = React.useState<{ kind: 'DEBIT' | 'CREDIT'; sender: string | null } | null>(null);
  /** v9: modo edição (botão Alterar do Fluxo). */
  const [editId, setEditId] = React.useState<string | null>(null);
  const [editLabel, setEditLabel] = React.useState<string | null>(null);
  const [editIsRecurrence, setEditIsRecurrence] = React.useState(false);
  /** v21 (bug 3): regra da conta fixa da ocorrência em edição — a alteração de
   *  DESCRIÇÃO propaga para a regra e para os meses seguintes. */
  const [editRuleId, setEditRuleId] = React.useState<string | null>(null);
  const [editOrigDescription, setEditOrigDescription] = React.useState<string>('');
  /** v10: tipo do lançamento em edição (grupo consolidado tem edição própria). */
  const [editKind, setEditKind] = React.useState<'SIMPLE' | 'CONSOLIDATED' | null>(null);
  const [cents, setCents] = React.useState(0);
  const [description, setDescription] = React.useState('');
  const [date, setDate] = React.useState(todaySP());
  const [categoryId, setCategoryId] = React.useState<string | null>(null);
  const [modality, setModality] = React.useState<Modality>('AVISTA');
  // v26 (menos é mais): o essencial (tipo, valor, descrição, data, categoria,
  // conta/cartão) fica à vista; Fixo, Parcelado e Grupo ficam em "Mais opções".
  const [moreOpen, setMoreOpen] = React.useState(false);
  // v68 "Repetir": cadência do Fixo/Parcelado (padrão Mensal = como sempre foi)
  const [repeat, setRepeat] = React.useState<Repeat>('MENSAL');
  const [installments, setInstallments] = React.useState('2');
  // v29 "Parcela atual": parcelamento que já está andando (ex.: 125 de 360). Vazio = 1.
  const [parcelaAtual, setParcelaAtual] = React.useState('');
  // v11 (Req 4): "Dividir total" e "Parcela fixa" migradas dos Parcelamentos
  const [planMode, setPlanMode] = React.useState<'DIVIDE_TOTAL' | 'FIXED_PER_MONTH'>('DIVIDE_TOTAL');
  const [target, setTarget] = React.useState<'ACCOUNT' | 'CARD'>(params.card ? 'CARD' : 'ACCOUNT');
  const [accountId, setAccountId] = React.useState<string | null>(null);
  const [cardId, setCardId] = React.useState<string | null>(params.card ?? null);
  const [fromId, setFromId] = React.useState<string | null>(null);
  const [toId, setToId] = React.useState<string | null>(null);
  // Consolidado (v7.1)
  const [groupDescription, setGroupDescription] = React.useState('');
  const [lines, setLines] = React.useState<ConsolidatedLine[]>([
    { key: 0, dir: 'DEBIT', description: '', cents: 0, modality: 'AVISTA', parcelas: '2', categoryId: null, target: 'ACCOUNT', cardId: null, planMode: 'DIVIDE_TOTAL', invoiceMonth: null, repeat: 'MENSAL' },
  ]);
  const [deletedGroupLines, setDeletedGroupLines] = React.useState<ConsolidatedLine[]>([]);
  /** v9: sanfona das linhas — só a linha aberta mostra o formulário. */
  const [openLineKey, setOpenLineKey] = React.useState<number | null>(0);
  const [categories, setCategories] = React.useState<CategoryOption[]>([]);
  const [accounts, setAccounts] = React.useState<Array<{ id: string; label: string }>>([]);
  const [cards, setCards] = React.useState<Array<{ id: string; label: string; closingDay: number }>>([]);
  /** v9: mês da fatura escolhido (cartão) — default = sugestão do dia de fechamento. */
  const [invoiceMonth, setInvoiceMonth] = React.useState<string | null>(null);
  const [invoiceMonthTouched, setInvoiceMonthTouched] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  // v21 (bug 4): confirmação antes de efetivar ALTERAÇÕES
  const [confirmEditOpen, setConfirmEditOpen] = React.useState(false);
  const [scannerOpen, setScannerOpen] = React.useState(false);
  const [scanning, setScanning] = React.useState(false);
  const [scannerError, setScannerError] = React.useState<string | null>(null);
  // v21 (bug 6): leitura NFC-e pelo NAVEGADOR INTERNO (a página da SEFAZ-SP
  // exige navegador — fetch direto cai na verificação e nunca libera)
  /** v41 — NOTA LIDA ESPERANDO O SALVAR: cabeçalho + itens com a escolha de
   *  estoque do usuário (botão SIM/NÃO por item). null = sem nota no formulário. */
  const [nfceNote, setNfceNote] = React.useState<{
    accessKey: string;
    storeName: string | null;
    totalCents: number | null;
    items: Array<NfcePreparedItem & { include?: boolean }>;
  } | null>(null);
  /** v103 — "Itens da nota fiscal" nasce RECOLHIDO. Ao carregar outra nota,
   *  volta a recolhido (dropdown useEffect abaixo). */
  const [itemsOpen, setItemsOpen] = React.useState(false);
  React.useEffect(() => {
    if (nfceNote) setItemsOpen(false);
  }, [nfceNote?.accessKey]);

  /**
   * v99 — Preenche o "Novo Lançamento" com a nota já LIDA (QR da rotina NFC-e
   * ou reabertura via `?nfce=<chave>`). Devolve true quando o formulário foi
   * preenchido; false quando a nota já está registrada (a tela decide o
   * caminho — toast + abertura da revisão ou só o toast).
   */
  const applyPreparedNote = React.useCallback(
    (prepared: { accessKey: string; header: NfceHeader; items: NfcePreparedItem[]; alreadyRegistered: boolean }) => {
      if (prepared.alreadyRegistered) {
        nfceLog('tela: fim — nota já registrada → mostrando aviso');
        // v101: padrão do sistema — aviso PRETO + ✓ (ToastKind 'ok'); sem
        // abrir a tela de revisão nem mudar de tela.
        showToast('NFC já cadastrada');
        return false;
      }
      const total = prepared.header.amountPaidCents ?? prepared.header.grossTotalCents ?? null;
      // v100 — sem toggle por item (prompt §3.2/§9.4): inclui é decidido no Catálogo
      setNfceNote({
        accessKey: prepared.accessKey,
        storeName: prepared.header.storeName,
        totalCents: total,
        items: prepared.items,
      });
      // v100 — categoria por CNPJ (lembrada pelo Banco): SE não houver escolha,
      // já abre com a categoria que o usuário usou na última nota deste CNPJ.
      if (prepared.header.cnpj) {
        services.db.getFirstAsync<{ category_id: string | null }>(
          'SELECT category_id FROM nfce_store_categories WHERE cnpj = ?',
          [prepared.header.cnpj]
        ).then((row) => {
          if (row?.category_id) setCategoryId(row.category_id);
        });
      }
      setCents(total ?? 0);
      const loja = prepared.header.storeName ? `NFC-e ${prepared.header.storeName}` : '';
      setDescription((cur) => (cur.trim() === '' || cur.startsWith('NFC-e') ? loja || cur : cur));
      if (prepared.header.issuedAt) setDate(spDateOfIso(prepared.header.issuedAt));
      setKind('EXPENSE');
      setModality('AVISTA');
      const elegiveis = prepared.items.filter((i) => i.canApplyStock && !i.needsReview).length;
      nfceLog(
        `tela: NOTA NO FORMULÁRIO — total ${total != null ? formatBRL(total) : 'não lido'} · ` +
        `${prepared.items.length} item(ns) · ${elegiveis} no estoque por padrão · escolha categoria, pagamento e o estoque, depois SALVE`
      );
      return true;
    },
    []
  );

  useDataEffect(async (svc) => {
    const [cats, accs, cds] = await Promise.all([
      // v17 (melhoria 5): categorias ARQUIVADAS saem das escolhas de lançamento
      svc.db.getAllAsync<CategoryOption>('SELECT id, name, parent_id, icon, direction FROM categories WHERE archived_at IS NULL ORDER BY name'),
      // contas/cartões ARQUIVADOS não aparecem nas escolhas (regra de arquivamento)
// v94: no cadastro de RECEITA e DESPESA só conta CORRENTE entra — poupança/
// dinheiro ficam fora (não são destino/débito do lançamento à vista). A edição
// mantém a conta original SOMANDO o id dela à lista (legacy).
      svc.db.getAllAsync<{ id: string; name: string }>("SELECT id, name FROM accounts WHERE archived_at IS NULL AND type = 'CHECKING' ORDER BY name"),
      svc.db.getAllAsync<{ id: string; name: string; last_four_digits: string | null; closing_day: number }>(
        'SELECT id, name, last_four_digits, closing_day FROM cards WHERE archived_at IS NULL ORDER BY name'
      ),
    ]);
    setCategories(cats);
    // v94: lista é só CORRENTE; mas, em modo EDIÇÃO, devolvemos também a conta
    // do lançamento original (cacheada do banco), caso ela seja POUPANÇA/
    // DINHEIRO de um registro já criado — sem isso, a tela Editar não
    // conseguiria nem mostrar o nome.
    let accList = accs.map((a) => ({ id: a.id, label: a.name }));
    if (params.edit) {
      const originalAccId = await svc.db.getFirstAsync<{ account_id: string | null }>(
        'SELECT account_id FROM transactions WHERE id = ?',
        [String(params.edit)]
      );
      const oid = originalAccId?.account_id;
      if (oid && !accList.some((a) => a.id === oid)) {
        const orig = await svc.db.getFirstAsync<{ name: string }>(
          'SELECT name FROM accounts WHERE id = ?',
          [oid]
        );
        if (orig) accList = [...accList, { id: oid, label: `${orig.name} (orig.)` }];
      }
    }
    setAccounts(accList);
    setCards(cds.map((c) => ({ id: c.id, closingDay: c.closing_day, label: c.last_four_digits ? `${c.name} ••${c.last_four_digits}` : c.name })));

    // ---------- ALTERAR (v9/v10): preenche o formulário com o lançamento real ----------
    if (params.edit) {
      const row = await svc.db.getFirstAsync<{
        kind: string; type: string; amount_cents: number; description: string;
        occurred_on: string; category_id: string | null; account_id: string | null;
        transfer_account_id: string | null; card_id: string | null; source_system: string;
        status: string; recurrence_rule_id: string | null;
      }>('SELECT kind, type, amount_cents, description, occurred_on, category_id, account_id, transfer_account_id, card_id, source_system, status, recurrence_rule_id FROM transactions WHERE id = ?', [params.edit]);
      // v10: GRUPO CONSOLIDADO — edição do cabeçalho (Descrição do Grupo Geral + data)
      if (row && row.kind === 'CONSOLIDATED') {
        const [children, rules, plans] = await Promise.all([
          svc.db.getAllAsync<{
            id: string; type: string; amount_cents: number; description: string;
            category_id: string | null; account_id: string | null;
          }>(
            `SELECT id, type, amount_cents, description, category_id, account_id
               FROM transactions
              WHERE parent_transaction_id = ? AND status != 'VOIDED'
              ORDER BY occurred_on, occurred_at`,
            [params.edit]
          ),
          svc.db.getAllAsync<{
            id: string; type: string; amount_cents: number; description: string;
            category_id: string | null; account_id: string | null; card_id: string | null;
            step_months: number | null; step_days: number | null;
          }>(
            `SELECT id, type, amount_cents, description, category_id, account_id, card_id,
                    step_months, step_days
               FROM recurrence_rules
              WHERE group_transaction_id = ?`,
            [params.edit]
          ),
          svc.db.getAllAsync<{
            plan_id: string; anchor_id: string | null; type: string; amount_cents: number;
            description: string; category_id: string | null; account_id: string | null;
            card_id: string | null; total_installments: number; mode: 'DIVIDE_TOTAL' | 'FIXED_PER_MONTH';
            total_cents: number | null; fixed_amount_cents: number | null;
            step_months: number | null; step_days: number | null; pending_count: number;
            paid_cents: number;
          }>(
            `SELECT p.id AS plan_id, t.id AS anchor_id, t.type, t.amount_cents, t.description,
                    t.category_id, p.account_id, p.card_id, p.total_installments, p.mode,
                    p.total_cents, p.fixed_amount_cents, p.step_months, p.step_days,
                    (SELECT COUNT(*) FROM installments i WHERE i.plan_id = p.id AND i.status = 'PENDING') AS pending_count,
                    COALESCE((SELECT SUM(i.amount_cents) FROM installments i WHERE i.plan_id = p.id AND i.status = 'PAID'), 0) AS paid_cents
               FROM installment_plans p
               LEFT JOIN transactions t ON t.id = p.original_transaction_id
              WHERE p.group_transaction_id = ?
              ORDER BY p.first_due_date`,
            [params.edit]
          ),
        ]);
        const existingLines: ConsolidatedLine[] = [
          ...children.map((item) => ({
            key: lineKeySeq++,
            dir: item.type === 'INCOME' ? 'CREDIT' as const : 'DEBIT' as const,
            description: item.description,
            cents: item.amount_cents,
            modality: 'AVISTA' as const,
            parcelas: '2',
            categoryId: item.category_id,
            target: 'ACCOUNT' as const,
            cardId: null,
            planMode: 'DIVIDE_TOTAL' as const,
            invoiceMonth: null,
            repeat: 'MENSAL' as const,
            persistedId: item.id,
            persistedKind: 'AVISTA' as const,
            persistedDir: item.type === 'INCOME' ? 'CREDIT' as const : 'DEBIT' as const,
            persistedModality: 'AVISTA' as const,
          })),
          ...rules.map((rule) => ({
            key: lineKeySeq++,
            dir: rule.type === 'INCOME' ? 'CREDIT' as const : 'DEBIT' as const,
            description: rule.description,
            cents: rule.amount_cents,
            modality: 'FIXO' as const,
            parcelas: '2',
            categoryId: rule.category_id,
            target: rule.card_id ? 'CARD' as const : 'ACCOUNT' as const,
            cardId: rule.card_id,
            planMode: 'DIVIDE_TOTAL' as const,
            invoiceMonth: null,
            repeat: repeatFromStep(rule.step_months, rule.step_days),
            persistedId: rule.id,
            persistedKind: 'FIXO' as const,
            persistedDir: rule.type === 'INCOME' ? 'CREDIT' as const : 'DEBIT' as const,
            persistedModality: 'FIXO' as const,
            persistedTarget: rule.card_id ? 'CARD' as const : 'ACCOUNT' as const,
            persistedCardId: rule.card_id,
            persistedRepeat: repeatFromStep(rule.step_months, rule.step_days),
          })),
          ...plans.map((plan) => ({
            key: lineKeySeq++,
            dir: plan.type === 'INCOME' ? 'CREDIT' as const : 'DEBIT' as const,
            description: plan.description,
            cents: plan.mode === 'FIXED_PER_MONTH' ? plan.fixed_amount_cents ?? 0 : plan.total_cents ?? plan.amount_cents,
            modality: 'PARCELADO' as const,
            parcelas: String(plan.total_installments),
            categoryId: plan.category_id,
            target: plan.card_id ? 'CARD' as const : 'ACCOUNT' as const,
            cardId: plan.card_id,
            planMode: plan.mode,
            invoiceMonth: null,
            repeat: repeatFromStep(plan.step_months, plan.step_days),
            persistedId: plan.anchor_id ?? plan.plan_id,
            persistedKind: 'PARCELADO' as const,
            persistedPlanId: plan.plan_id,
            persistedAnchorId: plan.anchor_id ?? undefined,
            persistedCents: plan.mode === 'FIXED_PER_MONTH' ? plan.fixed_amount_cents ?? 0 : plan.total_cents ?? plan.amount_cents,
            persistedDir: plan.type === 'INCOME' ? 'CREDIT' as const : 'DEBIT' as const,
            persistedModality: 'PARCELADO' as const,
            persistedTarget: plan.card_id ? 'CARD' as const : 'ACCOUNT' as const,
            persistedCardId: plan.card_id,
            persistedPlanMode: plan.mode,
            persistedParcelas: String(plan.total_installments),
            persistedRepeat: repeatFromStep(plan.step_months, plan.step_days),
            pendingInstallments: plan.pending_count,
            paidCents: plan.paid_cents,
          })),
        ];
        if (existingLines.length > 0) {
          setLines(existingLines);
          setDeletedGroupLines([]);
          setOpenLineKey(existingLines[0].key);
          const groupAccount =
            children[0]?.account_id ??
            rules.find((r) => r.account_id)?.account_id ??
            plans.find((p) => p.account_id)?.account_id ??
            null;
          setAccountId(groupAccount);
        }
        setEditId(params.edit);
        setEditLabel(row.description);
        setEditKind('CONSOLIDATED');
        setKind('CONSOLIDATED');
        setGroupDescription(row.description ?? '');
        setDate(row.occurred_on);
        return;
      }
      if (row && row.kind === 'SIMPLE') {
        setEditId(params.edit);
        setEditKind('SIMPLE');
        setEditLabel(row.description);
        setEditIsRecurrence(row.source_system === 'RECURRENCE');
        setEditRuleId(row.recurrence_rule_id ?? null);
        setEditOrigDescription(row.description ?? '');
        setKind(row.type === 'TRANSFER' ? 'TRANSFER' : row.type === 'INCOME' ? 'INCOME' : 'EXPENSE');
        setCents(row.amount_cents);
        setDescription(row.description ?? '');
        setDate(row.occurred_on);
        setCategoryId(row.category_id);
        if (row.type === 'TRANSFER') {
          setTarget('ACCOUNT');
          setFromId(row.account_id);
          setToId(row.transfer_account_id);
        } else if (row.card_id) {
          setTarget('CARD');
          setCardId(row.card_id);
          const inv = await svc.db.getFirstAsync<{ reference_month: string }>(
            `SELECT i.reference_month FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
              WHERE ii.transaction_id = ?`, [params.edit]
          );
          if (inv) {
            setInvoiceMonth(inv.reference_month);
            setInvoiceMonthTouched(true);
          }
        } else if (row.account_id) {
          setTarget('ACCOUNT');
          setAccountId(row.account_id);
        }
      }
      return;
    }

    // Duplicar (v7.0.4): preenche o formulário com os dados do lançamento de origem.
    // A data vem como hoje — duplicar registra um lançamento NOVO, não um retroativo.
    if (params.dup) {
      const row = await svc.db.getFirstAsync<{
        type: string; amount_cents: number; description: string;
        category_id: string | null; account_id: string | null;
        transfer_account_id: string | null; card_id: string | null;
      }>('SELECT type, amount_cents, description, category_id, account_id, transfer_account_id, card_id FROM transactions WHERE id = ?', [params.dup]);
      if (row) {
        setDupFrom(row.description);
        setKind(row.type === 'TRANSFER' ? 'TRANSFER' : row.type === 'INCOME' ? 'INCOME' : 'EXPENSE');
        setCents(row.amount_cents);
        setDescription(row.description ?? '');
        setDate(todaySP());
        setCategoryId(row.category_id);
        if (row.type === 'TRANSFER') {
          setFromId(row.account_id);
          setToId(row.transfer_account_id);
        } else if (row.card_id) {
          setTarget('CARD');
          setCardId(row.card_id);
        } else if (row.account_id) {
          setTarget('ACCOUNT');
          setAccountId(row.account_id);
        }
      }
    }

    // v69→v70 — NOTIFICAÇÃO BANCÁRIA (botão "Lançar" da lista): preenche
    // débito/crédito (ENTRADA/SAÍDA), valor, data e descrição. v70: quando a
    // notificação cita a FORMA DE PAGAMENTO, distingue CARTÃO CRÉDITO (compra
    // no crédito) de débito — e se o final do cartão bater com um cartão
    // cadastrado, ele já vem selecionado. NUNCA cria lançamento sozinho.
    if (params.msg) {
      const m = await svc.bankMessages.getById(String(params.msg));
      if (m && m.status === 'NEW') {
        setMsgId(m.id);
        setMsgInfo({ kind: m.kind, sender: m.sender });
        setKind(m.kind === 'CREDIT' ? 'INCOME' : 'EXPENSE');
        setCents(m.amount_cents);
        setDescription(m.description ?? m.sender ?? 'Compra bancária');
        if (m.tx_date) setDate(m.tx_date);
        setModality('AVISTA');
        // v70: "compra no crédito nacional, com o cartão final 6830" → o
        // lançamento vai para o CARTÃO com final 6830 (quando cadastrado);
        // sem forma de pagamento ou no débito, segue em CONTA.
        if (m.payment_method === 'CREDITO' && m.card_final) {
          const card = await svc.db.getFirstAsync<{ id: string }>(
            'SELECT id FROM cards WHERE last_four_digits = ? AND archived_at IS NULL LIMIT 1',
            [m.card_final]
          );
          if (card) {
            setCardId(card.id);
            setTarget('CARD');
          }
        }
      }
      return;
    }

    // v99 — NOTA CONFIRMADA NA ROTINA NFC-e: a tela /nfce/[key] já guardou o
    // cabeçalho e os itens da nota; aqui só RECUPERAMOS do banco (sem rede e
    // sem criar transação) e PREENCHEMOS este formulário. Ao SALVAR, o
    // attachToTransaction cria a transação e Anexa o estoque dos itens
    // marcados — fim do "lançamento não é finalizado".
    if (params.nfce) {
      const key = String(params.nfce);
      try {
        const prepared = await svc.nfce.prepareFromDocument(key);
        if (!applyPreparedNote(prepared)) {
          // Já registrada — apenas o toast (não muda de tela, o usuário fica
          // no formulário e decide; normalmente quer salvar outra coisa).
        } else {
          setScannerOpen(false);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        nfceLog(`tela: v99 — falha ao preparar nota ${key.slice(0, 8)}… a partir do banco: ${msg}`);
        showToast(`Não consegui carregar a nota: ${msg}`, 'err');
      }
    }
  });

  /** Ingestão NFC-e direto do lançamento (QR Code do "Novo Lançamento").
   *  v72 (LEITURA INVISÍVEL): o aparelho lê pelo MOTOR (WebView oculta 1×1).
   *  v99 — SEM TRANSACTION AUTOMÁTICA: `prepareByDirectFetch` grava só o
   *  cabeçalho + itens; a transação nasce no botão SALVAR deste formulário.
   *  Antes (v41), isso já era o comportamento do `finalizeNfceHtml`; a v99
   *  remove o caminho `ingestByDirectFetch` daqui para não criar a
   *  transação CONSOLEDAD fantasma que nunca aparecia no fluxo do usuário. */
  const ingestNfce = async (input: string) => {
    if (scanning) return;
    setScanning(true);
    setScannerError(null);
    try {
      const accessKey = extractAccessKeyNfce(input);
      if (!accessKey) {
        // v31: entrada ilegível aparece no terminal
        nfceLog(`entrada: texto lido pelo QR NÃO tem chave de 44 dígitos: "${input.trim().slice(0, 120)}"`);
        setScannerError('Não consegui ler o QR Code. Enquadre o código fiscal ou cole a URL completa da nota.');
        return;
      }
      // v31: início do processo no Novo Lançamento — entrada e chave no terminal
      nfceLog(`entrada: QR lido (novo lançamento): "${input.trim().slice(0, 120)}${input.trim().length > 120 ? '…' : ''}"`);
      nfceLog(`entrada: chave de 44 dígitos OK: ${accessKey}`);
      // v24: "já registrada" só com transação real — documento PENDING/FAILED
      // de tentativa antiga NÃO trava: a nota é buscada e reprocessada.
      const registeredId = await services.nfce.findRegisteredTransactionId(accessKey);
      if (registeredId) {
        nfceLog('tela: nota já registrada (novo lançamento) → mostrando aviso');
        // v101: SEM abrir tela de revisão — só avisar em preto (padrão do sistema)
        // e fechar o modal. O lançamento NÃO é adulterado.
        showToast('NFC já cadastrada');
        setScannerOpen(false);
        return;
      }
      // v99 — leitura ÚNICA e INVISÍVEL pelo motor do aparelho + só PREPARE
      // (cabeçalho + itens, SEM criar lançamento — `attachToTransaction` faz
      // isso no botão Salvar).
      nfceLog(`entrada: leitura pelo MOTOR DO APARELHO (WebView oculta, invisível) — preparando ${nfceHtmlSummary('')}`);
      const prepared = await services.nfce.prepareByDirectFetch(input);
      if (!prepared) {
        nfceLog('tela: motor não conseguiu a página (novo lançamento) — FIM, sem fallback');
        setScannerError('Não consegui ler a nota agora. Tente novamente em alguns minutos.');
        return;
      }
      bump();
      applyPreparedNote(prepared);
      setScannerOpen(false);
    } catch (err) {
      setScannerError(`Não consegui consultar a nota: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScanning(false);
    }
  };

  /** v100 — REMOVIDO o toggle "incluir no estoque" por item (prompt §3.2 + §9.4):
   *  o controle de estoque é decidido no Catálogo (Com/Sem controle). A NF
   *  só exibe a lista de itens como CONSULTIVEIS — a confirmação fica no
   *  Catálogo quando há "Novos da NF" pendentes. */

  /** v100 — anexa a nota lida ao lançamento criado. Aplica estoque dos itens
   *  Com controle + dimensão ok, congela o split de orçamento e lembra a
   *  categoria do CNPJ para futuras notas. */
  const attachNfceNote = async (txId: string) => {
    if (!nfceNote) return;
    try {
      const res = await services.nfce.attachToTransaction(nfceNote.accessKey, txId, {
        storeCategoryId: categoryId,
        includeItemIds: null,
      });
      nfceLog(`tela: v100 — nota anexada — ${res.applied} item(ns) ao estoque · ${res.split.length} fatia(s) de orçamento`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      nfceLog(`tela: FALHA ao anexar a nota ao lançamento: ${msg} — o lançamento segue; revise na tela NFC-e`);
      showToast(`Lançamento criado, mas a nota não foi anexada: ${msg}`, 'err');
    }
  };

  // ---------- Linhas do consolidado (v9 — sanfona) ----------
  const updateLine = (key: number, patch: Partial<ConsolidatedLine>) => {
    setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };
  const addLine = () => {
    const key = lineKeySeq++;
    setLines((cur) => [...cur, { key, dir: 'DEBIT', description: '', cents: 0, modality: 'AVISTA', parcelas: '2', categoryId: null, target: 'ACCOUNT', cardId: null, planMode: 'DIVIDE_TOTAL', invoiceMonth: null, repeat: 'MENSAL' }]);
    // Sanfona: retrai as linhas anteriores e abre a nova
    setOpenLineKey(key);
  };
  const removeLine = (key: number) => {
    if (lines.length <= 1) return;
    const removed = lines.find((line) => line.key === key);
    if (removed?.persistedId) {
      setDeletedGroupLines((current) =>
        current.some((line) => line.persistedId === removed.persistedId)
          ? current
          : [...current, removed]
      );
    }
    setLines((cur) => {
      const next = cur.filter((l) => l.key !== key);
      if (key === openLineKey) setOpenLineKey(next[0]?.key ?? null);
      return next;
    });
  };
  // v72 — totais CALCULADOS do grupo (como os outros tipos calculam o valor):
  // TODAS as linhas entram — à vista inteira, fixa mensal, parcela do mês
  // (Dividir total = 1ª parcela; Parcela fixa = valor digitado).
  const avistaLines = lines.filter((l) => l.modality === 'AVISTA');
  const grupoTotais = consolidatedGroupTotals(lines);
  const debitTotal = grupoTotais.debitCents;
  const creditTotal = grupoTotais.creditCents;
  const fixoCount = grupoTotais.fixoCount;
  const parceladoCount = grupoTotais.parceladoCount;

  const createGroupLines = async (groupId: string, groupLines: ConsolidatedLine[]) => {
    const avista = groupLines.filter((l) => l.modality === 'AVISTA');
    const fixas = groupLines.filter((l) => l.modality === 'FIXO');
    const parceladas = groupLines.filter((l) => l.modality === 'PARCELADO');
    const usesAccount = avista.length > 0 || [...fixas, ...parceladas].some((l) => l.target === 'ACCOUNT');
    if (!accountId && usesAccount) throw new Error('Selecione a conta do grupo');

    if (avista.length > 0) {
      await services.transactions.addAvistaLinesToGroup(groupId, {
        date,
        accountId: accountId!,
        lines: avista.map((l) => ({
          direction: l.dir,
          description: l.description.trim(),
          amountCents: l.cents,
          categoryId: l.categoryId,
        })),
      });
    }

    for (const l of fixas) {
      await services.recurrences.createRule({
        description: l.description.trim(),
        type: l.dir === 'CREDIT' ? 'INCOME' : 'EXPENSE',
        amountCents: l.cents,
        dayOfMonth: parseInt(date.slice(8, 10), 10),
        startDate: date,
        accountId: l.target === 'CARD' ? null : accountId,
        cardId: l.target === 'CARD' ? l.cardId : null,
        categoryId: l.categoryId,
        groupTransactionId: groupId,
        invoiceMonth: l.target === 'CARD' ? l.invoiceMonth ?? undefined : undefined,
        ...repeatToStep(l.repeat),
      });
    }
    if (fixas.length > 0) {
      await services.recurrences.runDueRecurrences();
      await services.recurrences.runForecast();
    }

    for (const l of parceladas) {
      const count = parseInt(l.parcelas, 10);
      const planBase = l.planMode === 'FIXED_PER_MONTH'
        ? { mode: 'FIXED_PER_MONTH' as const, fixedAmountCents: l.cents, totalInstallments: count }
        : { mode: 'DIVIDE_TOTAL' as const, totalCents: l.cents, totalInstallments: count };
      await services.installments.createPlan({
        description: l.description.trim(),
        ...planBase,
        firstDueDate: date,
        purchaseDate: date,
        categoryId: l.categoryId,
        accountId: l.target === 'ACCOUNT' ? accountId : null,
        cardId: l.target === 'CARD' ? l.cardId : null,
        type: l.dir === 'CREDIT' ? 'INCOME' : 'EXPENSE',
        groupTransactionId: groupId,
        firstInvoiceMonth: l.invoiceMonth ?? undefined,
        ...repeatToStep(l.repeat),
      });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      // ---------- v9/v10: ALTERAR — v21 (bug 4): só chega aqui após confirmação ----------
      if (editId) {
        if (editKind === 'CONSOLIDATED') {
          const valid = lines.filter((l) => l.cents > 0);
          if (valid.length === 0) throw new Error('Adicione ao menos uma linha com valor maior que zero');
          if (!groupDescription.trim()) throw new Error('Informe a Descrição do Grupo Geral');
          for (const l of valid) {
            if (!l.description.trim()) throw new Error('Informe a descrição de cada linha');
            if (l.modality === 'PARCELADO' && (!Number.isInteger(parseInt(l.parcelas, 10)) || parseInt(l.parcelas, 10) < 2)) {
              throw new Error('Informe o número de parcelas (2 ou mais) nas linhas parceladas');
            }
            if (l.modality !== 'AVISTA' && l.target === 'CARD' && !l.cardId) {
              throw new Error(`A linha "${l.description.trim()}" vai para o CARTÃO — selecione o cartão de crédito`);
            }
            if (l.persistedKind && l.modality !== l.persistedModality) {
              throw new Error('Para mudar o tipo de uma linha existente, exclua-a e adicione uma nova linha.');
            }
            if (l.persistedKind === 'FIXO' &&
                (l.dir !== l.persistedDir || l.target !== l.persistedTarget || l.cardId !== l.persistedCardId || l.repeat !== l.persistedRepeat)) {
              throw new Error('Em uma linha fixa existente, altere descrição, valor ou categoria. Para mudar tipo, destino ou frequência, exclua-a e adicione outra.');
            }
            if (l.persistedKind === 'PARCELADO' && (l.dir !== l.persistedDir || l.repeat !== l.persistedRepeat)) {
              throw new Error('Em uma linha parcelada existente, a direção e a frequência não podem ser alteradas.');
            }
            if (l.persistedKind === 'PARCELADO' && (l.pendingInstallments ?? 0) === 0 &&
                (l.cents !== l.persistedCents || l.planMode !== l.persistedPlanMode ||
                 l.parcelas !== l.persistedParcelas || l.dir !== l.persistedDir ||
                 l.target !== l.persistedTarget || l.cardId !== l.persistedCardId)) {
              throw new Error('Este parcelamento não tem parcelas em aberto; só descrição, categoria e data podem ser alteradas.');
            }
            if (l.persistedKind === 'PARCELADO' && l.planMode === 'DIVIDE_TOTAL' &&
                (l.planMode !== l.persistedPlanMode || l.cents !== l.persistedCents) &&
                l.cents <= (l.paidCents ?? 0)) {
              throw new Error('O valor total precisa ser maior que o valor das parcelas já pagas.');
            }
          }
          const usesAccount = valid.some((l) => l.modality === 'AVISTA' || l.target === 'ACCOUNT');
          if (usesAccount && !accountId) throw new Error('Selecione a conta do grupo');

          const groupDebit = valid.filter((l) => l.dir === 'DEBIT').reduce((sum, l) => sum + l.cents, 0);
          const groupCredit = valid.filter((l) => l.dir === 'CREDIT').reduce((sum, l) => sum + l.cents, 0);
          const newAvistaTotal = valid
            .filter((l) => !l.persistedId && l.modality === 'AVISTA')
            .reduce((sum, l) => sum + l.cents, 0);
          await services.db.transactionAsync(async () => {
            await services.transactions.updateGroupHeader(editId, {
              description: groupDescription,
              date,
              amountCents: groupDebit + groupCredit - newAvistaTotal,
              type: groupDebit >= groupCredit ? 'EXPENSE' : 'INCOME',
            });

            for (const l of valid) {
              if (l.persistedKind === 'AVISTA' && l.persistedId) {
                await services.transactions.updateSimple(l.persistedId, {
                  type: l.dir === 'CREDIT' ? 'INCOME' : 'EXPENSE',
                  description: l.description,
                  amountCents: l.cents,
                  date,
                  categoryId: l.categoryId,
                  accountId: accountId ?? undefined,
                });
              } else if (l.persistedKind === 'FIXO' && l.persistedId) {
                await services.recurrences.updateRule(l.persistedId, {
                  description: l.description,
                  amountCents: l.cents,
                  dayOfMonth: parseInt(date.slice(8, 10), 10),
                });
                await services.db.runAsync(
                  'UPDATE recurrence_rules SET category_id = ? WHERE id = ?',
                  [l.categoryId, l.persistedId]
                );
                await services.db.runAsync(
                  'UPDATE transactions SET category_id = ? WHERE recurrence_rule_id = ? AND status != ?',
                  [l.categoryId, l.persistedId, 'VOIDED']
                );
              } else if (l.persistedKind === 'PARCELADO' && l.persistedPlanId) {
                if ((l.pendingInstallments ?? 0) > 0) {
                  const newMode = l.planMode;
                  await services.installments.updatePlanFields(l.persistedPlanId, {
                    description: l.description,
                    categoryId: l.categoryId,
                    purchaseDate: date,
                    mode: newMode,
                    divideTotalCents: newMode === 'DIVIDE_TOTAL' && (newMode !== l.persistedPlanMode || l.cents !== l.persistedCents)
                      ? l.cents - (l.paidCents ?? 0)
                      : undefined,
                    fixedAmountCents: newMode === 'FIXED_PER_MONTH' ? l.cents : undefined,
                    totalInstallments: parseInt(l.parcelas, 10),
                    accountId: l.target === 'ACCOUNT' ? accountId : null,
                    cardId: l.target === 'CARD' ? l.cardId : null,
                  });
                  if (l.persistedAnchorId) {
                    await services.db.runAsync('UPDATE transactions SET category_id = ? WHERE id = ?', [l.categoryId, l.persistedAnchorId]);
                  }
                } else {
                  if (l.persistedAnchorId) {
                    await services.db.runAsync(
                      'UPDATE transactions SET description = ?, category_id = ?, occurred_on = ? WHERE id = ?',
                      [l.description, l.categoryId, date, l.persistedAnchorId]
                    );
                  }
                }
              }
            }

            for (const l of deletedGroupLines) {
              if (l.persistedKind === 'AVISTA') {
                await services.transactions.deleteConsolidatedLine(editId, l.persistedId!);
              } else if (l.persistedKind === 'FIXO') {
                await services.recurrences.excludeFrom(l.persistedId!, todaySP());
              } else if (l.persistedKind === 'PARCELADO' && l.persistedPlanId) {
                const firstOpen = await services.db.getFirstAsync<{ sequence_number: number }>(
                  "SELECT MIN(sequence_number) AS sequence_number FROM installments WHERE plan_id = ? AND status = 'PENDING'",
                  [l.persistedPlanId]
                );
                if (firstOpen?.sequence_number != null) {
                  await services.installments.cancelFromSequence(l.persistedPlanId, firstOpen.sequence_number);
                }
                await services.db.runAsync(
                  'UPDATE installment_plans SET group_transaction_id = NULL WHERE id = ?',
                  [l.persistedPlanId]
                );
              }
            }

            await createGroupLines(editId, valid.filter((l) => !l.persistedId));
          });
        } else {
          // v21 (bug 3): CONTA FIXA — a alteração de DESCRIÇÃO propaga para a
          // regra e para as ocorrências da competência atual em diante (meses
          // seguintes passam a nascer com a descrição nova). Valor/data/categoria
          // continuam valendo só para ESTE mês (histórico e flexibilidade).
          if (
            editIsRecurrence &&
            editRuleId &&
            description.trim() &&
            description.trim() !== editOrigDescription.trim()
          ) {
            await services.recurrences.updateRule(editRuleId, { description: description.trim() });
          }
          await services.transactions.updateSimple(editId, {
            description,
            amountCents: cents,
            date,
            categoryId,
            accountId: accountId ?? undefined,
            toAccountId: toId ?? undefined,
            referenceMonth: target === 'CARD' && kind !== 'TRANSFER' && invoiceMonth ? invoiceMonth : undefined,
          });
        }
        bump();
        router.replace('/fluxo');
        return;
      }

      if (kind === 'TRANSFER') {
        if (cents <= 0) throw new Error('Informe um valor maior que zero');
        if (!fromId || !toId) throw new Error('Selecione origem e destino');
        if (fromId === toId) throw new Error('Origem e destino devem ser diferentes');
        await services.transactions.createTransfer({
          description: description.trim() || 'Transferência',
          amountCents: cents,
          date,
          fromAccountId: fromId,
          toAccountId: toId,
        });
      } else if (kind === 'CONSOLIDATED') {
        // v13 (bug 1.C): a CONTA do grupo só é exigida quando alguém de fato
        // usa a conta (linhas À vista e Fixo/Parcelado com destino CONTA).
        // Grupo só com Fixo/Parcelado no CARTÃO DE CRÉDITO salva sem conta.
        const valid = lines.filter((l) => l.cents > 0);
        if (valid.length === 0) throw new Error('Adicione ao menos uma linha com valor maior que zero');
        if (!groupDescription.trim()) throw new Error('Informe a Descrição do Grupo Geral');
        for (const l of valid) {
          if (!l.description.trim()) throw new Error('Informe a descrição de cada linha');
          if (l.modality === 'PARCELADO') {
            // v14 (bug 2): PARCELADO vale para DÉBITO (despesa) e para CRÉDITO
            // (receita parcelada — ex.: aluguel em 36 meses, corretagem 36x,
            // obras 5 meses). Em conta: parcela como crédito; no cartão:
            // item negativo na fatura (abate o total).
            const n = parseInt(l.parcelas, 10);
            if (!Number.isInteger(n) || n < 2) throw new Error('Informe o número de parcelas (2 ou mais) nas linhas parceladas');
            if (l.target === 'CARD' && !l.cardId) throw new Error(`A linha "${l.description.trim()}" vai para o CARTÃO — selecione o cartão de crédito`);
          }
          if (l.modality === 'FIXO' && l.target === 'CARD' && !l.cardId) {
            throw new Error(`A linha "${l.description.trim()}" vai para o CARTÃO — selecione o cartão de crédito`);
          }
        }

        const avista = valid.filter((l) => l.modality === 'AVISTA');
        const fixo = valid.filter((l) => l.modality === 'FIXO');
        const parceladas = valid.filter((l) => l.modality === 'PARCELADO');
        const usesAccount =
          avista.length > 0 || [...fixo, ...parceladas].some((l) => l.target === 'ACCOUNT');
        if (!accountId && usesAccount) throw new Error('Selecione a conta do grupo');
        // v10 (Req 4): a exigência de ao menos uma linha À VISTA foi REMOVIDA —
        // o grupo é criado apenas quando existem linhas à vista; linhas Fixo/
        // Parcelado seguem as regras próprias (conta fixa / parcelamento)
        // v12 (bug A): o grupo SEMPRE nasce — mesmo sem linhas à vista (só
        // Fixo/Parcelado), o cabeçalho-âncora garante a consolidação igual ao
        // "À Vista" (as linhas ficam VINCULADAS ao grupo no Fluxo).
        const debitAll = valid.filter((l) => l.dir === 'DEBIT').reduce((a, b) => a + b.cents, 0);
        const creditAll = valid.filter((l) => l.dir === 'CREDIT').reduce((a, b) => a + b.cents, 0);
        // v11 (bug 3.1): as linhas Fixo/Parcelado ficam VINCULADAS ao grupo —
        // na expansão do consolidado no Fluxo aparece o histórico completo.
        // v87 (BUG MÉDIA): grupo + fixas + parcelamentos passam a ser criados
        // numa ÚNICA transação — uma falha no meio não deixa a operação pela
        // metade (e o retry do botão "Salvar" não duplica nada).
        await services.db.transactionAsync(async () => {
        const grupo = await services.transactions.createConsolidatedGroup({
          description: groupDescription.trim(),
          date,
          categoryId: null,
          accountId: usesAccount ? accountId : undefined,
          // v10: cada linha leva a própria CATEGORIA (débito ou crédito)
          lines: avista.map((l) => ({
            direction: l.dir,
            description: l.description.trim() || (l.dir === 'DEBIT' ? 'Débito' : 'Crédito'),
            amountCents: l.cents,
            categoryId: l.categoryId,
          })),
          headerAmountCents: debitAll + creditAll,
          headerType: debitAll >= creditAll ? 'EXPENSE' : 'INCOME',
        });
        // v10: linhas FIXAS → conta fixa por linha (com a categoria da linha).
        // v13 (bug 1.C): a fixa pode ir para o CARTÃO DE CRÉDITO escolhido na
        // linha — a ocorrência de todo mês entra na FATURA do cartão.
        for (const l of fixo) {
          const day = parseInt(date.slice(8, 10), 10);
          await services.recurrences.createRule({
            description: l.description.trim(),
            type: l.dir === 'CREDIT' ? 'INCOME' : 'EXPENSE',
            amountCents: l.cents,
            dayOfMonth: day,
            startDate: date,
            accountId: l.target === 'CARD' ? null : accountId,
            cardId: l.target === 'CARD' ? l.cardId : null,
            categoryId: l.categoryId,
            groupTransactionId: grupo?.id ?? null,
            invoiceMonth: l.target === 'CARD' ? l.invoiceMonth ?? undefined : undefined,
            // v69 "Repetir" da linha: cadência Semanal → Anual
            ...repeatToStep(l.repeat),
          });
        }
        if (fixo.length > 0) {
          await services.recurrences.runDueRecurrences();
          await services.recurrences.runForecast();
        }
        // v10: linhas PARCELADAS → plano (com a categoria da linha).
        // v13 (bug 1.C): PARCELADO NO CARTÃO DE CRÉDITO dentro do grupo — as
        // parcelas nascem DIRETO NA FATURA do cartão escolhido (não na conta).
        for (const l of parceladas) {
          const n = parseInt(l.parcelas, 10);
          // v14 (bug 2): a direção da linha define o TIPO do plano — Crédito
          // cria RECEITA PARCELADA (parcelas como crédito em conta ou item
          // negativo na fatura do cartão); Débito continua como despesa.
          const planType = l.dir === 'CREDIT' ? ('INCOME' as const) : ('EXPENSE' as const);
          // v21 (melhoria 1): a linha escolhe o MODO — Dividir total (o valor da
          // linha é o TOTAL repartido) ou Parcela fixa (o valor se repete/mês).
          const planBase =
            l.planMode === 'FIXED_PER_MONTH'
              ? {
                  mode: 'FIXED_PER_MONTH' as const,
                  fixedAmountCents: l.cents,
                  totalInstallments: n,
                }
              : {
                  mode: 'DIVIDE_TOTAL' as const,
                  totalCents: l.cents,
                  totalInstallments: n,
                };
          if (l.target === 'CARD') {
            await services.installments.createPlan({
              description: l.description.trim(),
              ...planBase,
              firstDueDate: date,
              purchaseDate: date,
              categoryId: l.categoryId,
              cardId: l.cardId!,
              type: planType,
              groupTransactionId: grupo?.id ?? null,
              firstInvoiceMonth: l.invoiceMonth ?? undefined,
              // v69 "Repetir" da linha: cadência Semanal → Anual
              ...repeatToStep(l.repeat),
            });
          } else {
            await services.installments.createPlan({
              description: l.description.trim(),
              ...planBase,
              firstDueDate: date,
              purchaseDate: date,
              accountId,
              categoryId: l.categoryId,
              type: planType,
              groupTransactionId: grupo?.id ?? null,
              // v69 "Repetir" da linha: cadência Semanal → Anual
              ...repeatToStep(l.repeat),
            });
          }
        }
        }); // fim da transação do consolidado (v87)
        bump();
        router.replace('/fluxo');
        return;
      } else {
        // Despesa / Receita
        if (cents <= 0) throw new Error('Informe um valor maior que zero');

        if (modality === 'FIXO') {
          // Conta fixa: recorrência mensal — em CONTA ou em CARTÃO (v10, Req 5;
          // v12: despesa E receita no cartão — a receita entra como CRÉDITO na fatura)
          if (!description.trim()) throw new Error('Informe a descrição');
          const day = parseInt(date.slice(8, 10), 10);
          if (target === 'CARD') {
            if (!cardId) throw new Error('Selecione o cartão');
            await services.recurrences.createRule({
              description: description.trim(),
              type: kind === 'INCOME' ? 'INCOME' : 'EXPENSE',
              amountCents: cents,
              dayOfMonth: day,
              startDate: date,
              cardId,
              categoryId,
              // v26: "mês da fatura" da 1ª ocorrência (vale p/ todas, via deslocamento)
              invoiceMonth: invoiceMonth ?? undefined,
              // v68 "Repetir": Semanal/Mensal/Bimestral/Trimestral/Semestral/Anual
              ...repeatToStep(repeat),
            });
          } else {
            if (!accountId) throw new Error('Selecione a conta');
            await services.recurrences.createRule({
              description: description.trim(),
              type: kind === 'INCOME' ? 'INCOME' : 'EXPENSE',
              amountCents: cents,
              dayOfMonth: day,
              startDate: date,
              accountId,
              categoryId,
              // v68 "Repetir": cadência escolhida
              ...repeatToStep(repeat),
            });
          }
          // Mês atual (efetivado) + próximos meses (previsão no Fluxo)
          await services.recurrences.runDueRecurrences();
          await services.recurrences.runForecast();
          bump();
          router.replace('/fluxo');
          return;
        }

        if (modality === 'PARCELADO') {
          // v26: Crédito parcelado liberado — em CONTA as parcelas entram como crédito;
          // no CARTÃO entram negativas na fatura (abatem o total a pagar).
          const n = parseInt(installments, 10);
          if (!Number.isInteger(n) || n < 2) throw new Error('Informe o número de parcelas (2 ou mais)');
          if (!atualOk) throw new Error(`A parcela atual deve estar entre 1 e ${n}`);
          if (!description.trim()) throw new Error('Informe a descrição');
          // v11 (Req 4): os dois modos migrados da tela Parcelamentos
          const base =
            planMode === 'FIXED_PER_MONTH'
              ? {
                  description: description.trim(),
                  mode: 'FIXED_PER_MONTH' as const,
                  fixedAmountCents: cents,
                  totalInstallments: n,
                  startSequence: atualParc,
                  firstDueDate: date,
                  purchaseDate: date,
                  categoryId,
                  type: kind === 'INCOME' ? ('INCOME' as const) : ('EXPENSE' as const),
                }
              : {
                  description: description.trim(),
                  mode: 'DIVIDE_TOTAL' as const,
                  totalCents: cents,
                  totalInstallments: n,
                  startSequence: atualParc,
                  firstDueDate: date,
                  purchaseDate: date,
                  categoryId,
                  type: kind === 'INCOME' ? ('INCOME' as const) : ('EXPENSE' as const),
                };
          if (target === 'CARD') {
            if (!cardId) throw new Error('Selecione o cartão');
            // v26: "mês da fatura" da 1ª parcela (as demais seguem mês a mês)
            // v68 "Repetir": cadência escolhida (mensal múltiplo salta a fatura N a N)
            await services.installments.createPlan({ ...base, cardId, firstInvoiceMonth: invoiceMonth ?? undefined, ...repeatToStep(repeat) });
          } else {
            if (!accountId) throw new Error('Selecione a conta');
            await services.installments.createPlan({ ...base, accountId, ...repeatToStep(repeat) });
          }
          bump();
          router.replace('/fluxo');
          return;
        }

        // À vista (comportamento clássico)
        if (!description.trim()) {
          throw new Error('Informe a descrição.');
        }
        if (target === 'ACCOUNT') {
          if (!accountId) throw new Error('Selecione a conta');
          const input = { description: description.trim(), amountCents: cents, date, categoryId, accountId } as const;
          // v41: o lançamento criado recebe a nota lida (vínculo + estoque dos itens marcados)
          const tx = kind === 'EXPENSE'
            ? await services.transactions.createAccountExpense(input)
            : await services.transactions.createAccountIncome(input);
          await attachNfceNote(tx.id);
          // v69: mensagem bancária lançada — marca na lista e CONCILIA o OFX já
          // importado automaticamente por data + valor (sem duplicar).
          if (msgId) {
            try {
              await services.bankMessages.markLancado(msgId, tx.id, tx.account_id);
            } catch {
              // best-effort — o lançamento já existe
            }
          }
        } else {
          if (!cardId) throw new Error('Selecione o cartão');
          if (kind === 'INCOME') throw new Error('Receita não se aplica a cartão');
          const tx = await services.transactions.createCardExpense({
            description: description.trim(),
            amountCents: cents,
            date,
            categoryId,
            cardId,
            // v9: fatura escolhida (sugestão pelo fechamento ou manual até +6 meses)
            referenceMonth: invoiceMonth ?? undefined,
          });
          // v41: nota no cartão também é anexada (o estoque segue os itens marcados)
          await attachNfceNote(tx.id);
          // v69: mensagem no CARTÃO também é marcada (a conciliação com OFX
          // por data + valor fica para a fatura/extrato do banco).
          if (msgId) {
            try {
              await services.bankMessages.markLancado(msgId, tx.id, tx.account_id);
            } catch {
              // best-effort
            }
          }
        }
      }
      // v10: SEM alerta de sucesso — direto para o FLUXO
      bump();
      router.replace('/fluxo');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setSaving(false);
    }
  };

  const isTransfer = kind === 'TRANSFER';
  const isConsolidated = kind === 'CONSOLIDATED';
  const isPlain = kind === 'EXPENSE' || kind === 'INCOME';
  const advanced = moreOpen || modality !== 'AVISTA' || kind === 'CONSOLIDATED';
  // v29 — parcela atual (125/360) e quantas parcelas ainda faltam gerar
  const nParc = parseInt(installments, 10);
  const atualParc = parcelaAtual.trim() === '' ? 1 : parseInt(parcelaAtual, 10);
  const atualOk = Number.isInteger(atualParc) && atualParc >= 1 && (!Number.isInteger(nParc) || atualParc <= nParc);
  const restantes = Number.isInteger(nParc) ? (atualOk ? nParc - atualParc + 1 : nParc) : 0;
  const emAndamento = modality === 'PARCELADO' && atualOk && atualParc > 1;
  // v29 — Subcategoria (lançamento manual): a categoria gravada é a sub quando escolhida,
  // senão a principal. Fica escondida quando o lançamento vem de QR code (NF).
  const catSel = categories.find((c) => c.id === categoryId) ?? null;
  const catPaiId = catSel ? (catSel.parent_id ?? catSel.id) : null;
  const subcats = catPaiId
    ? categories
        .filter((c) => c.parent_id === catPaiId && categoryMatchesFilter(c, kind === 'INCOME' ? 'CREDIT' : kind === 'EXPENSE' ? 'DEBIT' : 'ANY'))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    : [];
  const isEdit = editId != null;
  /** Edição de grupo: o formulário inclui cabeçalho e linhas. */
  const isEditGroup = isEdit && editKind === 'CONSOLIDATED';

  // v8: filtro dinâmico de categorias por tipo de operação (regra geral)
  const categoryFilter: 'DEBIT' | 'CREDIT' | 'ANY' =
    kind === 'INCOME' ? 'CREDIT' : kind === 'EXPENSE' ? 'DEBIT' : 'ANY';

  // v67 (BUG 5): ao TROCAR Despesa↔Receita, a categoria selecionada que não
  // pertence ao novo tipo é LIMPA — cada direção mostra (e grava) só as
  // categorias dela; categoria BOTH vale para as duas e não é mexida.
  React.useEffect(() => {
    if (kind !== 'EXPENSE' && kind !== 'INCOME') return;
    const dirFilter: 'DEBIT' | 'CREDIT' = kind === 'INCOME' ? 'CREDIT' : 'DEBIT';
    setCategoryId((cur) => {
      if (!cur) return cur;
      const cat = categories.find((c) => c.id === cur);
      if (!cat) return cur; // ainda não carregou — não mexe
      return categoryMatchesFilter(cat, dirFilter) ? cur : null;
    });
  }, [kind, categories]);

  // v9: sugere o mês da fatura ao escolher cartão/data (não sobrescreve escolha manual)
  const selectedCard = cards.find((c) => c.id === cardId) ?? null;
  React.useEffect(() => {
    if (isEdit || invoiceMonthTouched) return;
    // v26: mês da fatura também para Fixo e Parcelado (despesa e crédito) no cartão
    const hasInvoiceMonth = kind === 'EXPENSE' || (kind === 'INCOME' && modality !== 'AVISTA');
    if (target !== 'CARD' || !selectedCard || !hasInvoiceMonth) {
      setInvoiceMonth(null);
      return;
    }
    setInvoiceMonth(suggestInvoiceMonth(selectedCard.closingDay, date));
  }, [target, cardId, date, kind, modality, isEdit, invoiceMonthTouched, selectedCard]);

  // Opções de fatura: mês anterior (retroativo), sugestão e até 6 meses à frente
  const invoiceOptions = React.useMemo(() => {
    if (!invoiceMonth) return [] as Array<{ id: string; label: string }>;
    const out: Array<{ id: string; label: string }> = [];
    out.push({ id: monthAdd(invoiceMonth, -1), label: `${monthLabel(monthAdd(invoiceMonth, -1))} (anterior)` });
    out.push({ id: invoiceMonth, label: `${monthLabel(invoiceMonth)} (sugerida)` });
    for (let i = 1; i <= 6; i++) {
      const ym = monthAdd(invoiceMonth, i);
      out.push({ id: ym, label: monthLabel(ym) });
    }
    return out;
  }, [invoiceMonth]);

  const saveLabel = isEdit
    ? 'Salvar alterações'
    : isTransfer
      ? 'Transferir'
      : isConsolidated
        ? 'Salvar operação consolidada'
        : modality === 'FIXO'
          ? 'Criar conta fixa'
          : modality === 'PARCELADO'
            ? 'Criar parcelamento'
            : 'Salvar lançamento';

  return (
    <Screen
      title={isEdit ? 'Alterar lançamento' : 'Novo lançamento'}
      subtitle={
        isEdit
          ? `Editando: ${editLabel ?? ''}`
          : dupFrom
            ? `Duplicando: ${dupFrom}`
            : isTransfer
              ? 'Transferência · entre contas'
              : isConsolidated
                ? `Grupo: −${formatBRL(debitTotal)} / +${formatBRL(creditTotal)}`
                : `Valor: ${formatBRL(cents)}`
      }
      accent={ks.solid}
      accentTextClass={ks.softText}
    >
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Seletor de tipo por pictogramas (regra geral de design) */}
        <Card className="gap-3">
          <Text className={`text-sm font-medium ${theme.textMuted}`}>Tipo de operação</Text>
          {isEdit ? (
            <Text className="text-xs text-slate-500 -mt-1">
              {isEditGroup
                ? 'Edite o grupo e suas linhas no mesmo formulário de criação.'
                : 'No modo Alterar o tipo não muda — exclua e crie um novo caso precise de outro tipo.'}
            </Text>
          ) : (
            <View className="flex-row gap-1.5">
              {(Object.keys(KIND_ICONS) as TxKind[]).filter((k) => advanced || k !== 'CONSOLIDATED').map((k) => {
                const active = kind === k;
                return (
                  <Pressable
                    key={k}
                    onPress={() => setKind(k)}
                    accessibilityRole="button"
                    accessibilityLabel={kindTheme[k].label}
                    className={`flex-1 items-center gap-0.5 rounded-xl border py-2 ${
                      active ? `${kindTheme[k].solid} border-transparent` : `${theme.surface} ${theme.border} border`
                    }`}
                  >
                    <Text className="text-xl leading-6">{KIND_ICONS[k]}</Text>
                    <Text className={`text-xs font-semibold ${active ? 'text-white' : theme.textMuted}`}>
                      {kindTheme[k].label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {!isEdit && !advanced ? (
            <Pressable
              onPress={() => setMoreOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Mais opções: fixo, parcelado e grupo"
              className="self-start py-1"
            >
              <Text className="text-sm font-medium text-slate-500">Mais opções {ICONS.expandir}</Text>
            </Pressable>
          ) : null}

          {isPlain && !isEdit && advanced ? (
            <>
              <Segmented<Modality>
                value={modality}
                onChange={setModality}
                options={[
                  { value: 'AVISTA', label: `${ICONS.avista} À vista` },
                  { value: 'FIXO', label: `${ICONS.fixo} Fixo` },
                  { value: 'PARCELADO', label: `${ICONS.parcelado} Parcelado` },
                ]}
                activeBg={ks.solid}
              />
              {/* v68→v69 "Repetir": SÓ quando for Crédito/Débito E Fixo/Parcelado —
                  AGORA em BOTÕES no esquema de cores do tipo (débito rose /
                  crédito emerald): Semanal → Anual, clique direto. */}
              {modality !== 'AVISTA' ? (
                <>
                  <Text className={`text-sm font-medium ${theme.textMuted}`}>Repetir</Text>
                  <RepeatButtons value={repeat} onChange={(v) => setRepeat(v)} tone={kind === 'INCOME' ? 'emerald' : 'rose'} />
                </>
              ) : null}
              {modality === 'PARCELADO' ? (
                <>
                  {/* v11 (Req 4): modos migrados da tela Parcelamentos ("Novo plano" extinto) */}
                  <Segmented<'DIVIDE_TOTAL' | 'FIXED_PER_MONTH'>
                    value={planMode}
                    onChange={setPlanMode}
                    options={[
                      { value: 'DIVIDE_TOTAL', label: 'Dividir total' },
                      { value: 'FIXED_PER_MONTH', label: 'Parcela fixa' },
                    ]}
                    activeBg={ks.solid}
                  />
                </>
              ) : null}
            </>
          ) : null}
          {isEdit && editIsRecurrence ? (
            <Text className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2.5 py-2">
              Descrição vale para a fixa inteira; valor, data e categoria, só para este mês.
            </Text>
          ) : null}

          <View className="flex-row items-end gap-2">
            <View className="flex-1">
              {isConsolidated && !isEditGroup ? null : isEditGroup ? (
                <Text className={`text-sm font-medium ${theme.textMuted} h-[22px]`}>Edição do grupo</Text>
              ) : (
                <MoneyInput
                  label={modality === 'PARCELADO' && planMode === 'FIXED_PER_MONTH' ? 'Valor da parcela (R$)' : emAndamento && planMode === 'DIVIDE_TOTAL' ? 'Valor total restante (R$)' : 'Valor'}
                  cents={cents}
                  onChangeCents={setCents}
                  autoFocus
                  accentTextClass={ks.softText}
                />
              )}
            </View>
            {kind === 'EXPENSE' && modality === 'AVISTA' && !isEdit ? (
              <Pressable
                onPress={() => {
                  setScannerError(null);
                  setScannerOpen(true);
                }}
                accessibilityLabel="Escanear QR Code da NFC-e"
                className="bg-black rounded-lg px-2 h-[52px] items-center justify-center self-end"
              >
                <QrGlyph size={16} />
              </Pressable>
            ) : null}
          </View>
          <TextField
            label={isTransfer ? 'Descrição (opcional)' : isConsolidated ? 'Descrição do Grupo Geral' : 'Descrição'}
            value={isConsolidated ? groupDescription : description}
            onChangeText={isConsolidated ? setGroupDescription : setDescription}
            placeholder={
              isTransfer ? 'Ex.: Guardando na poupança' : isConsolidated ? 'Ex.: Feira + farmácia do mês' : 'Ex.: Mercado da esquina'
            }
          />
          {/* v69: banner da mensagem bancária preenchida (débito/crédito) */}
          {msgInfo ? (
            <Text className={`text-xs rounded-lg px-2.5 py-2 ${msgInfo.kind === 'CREDIT' ? 'text-emerald-700 bg-emerald-50' : 'text-rose-700 bg-rose-50'}`}>
              💬 Mensagem bancária ({msgInfo.kind === 'CREDIT' ? 'entrada' : 'saída'}{msgInfo.sender ? ` · ${msgInfo.sender}` : ''}) — ao salvar, sai da lista de mensagens.
            </Text>
          ) : null}
          <DateField label="Data" value={date} onChange={setDate} />
          {/* v10: no CONSOLIDADO o campo "Categoria (opcional)" foi REMOVIDO de vez —
              fica apenas para despesa/receita (a transferência nunca teve).
              v100: com NF o campo aparece — a categoria do lançamento é a do
              CNPJ (lembrada depois da 1ª nota) e o split por item cuida das
              subcategorias. */}
          {!isTransfer && !isConsolidated ? (
            <CategorySelect
              label={
                // v94 — o filtro já vinha por direção (v67); o rótulo passa a
                // dizer a direção: "Categoria de despesa" / "Categoria de
                // receita" para deixar claro EXATAMENTE o que está aparecendo.
                kind === 'INCOME'
                  ? 'Categoria de receita'
                  : kind === 'EXPENSE'
                  ? 'Categoria de despesa'
                  : 'Categoria (opcional)'
              }
              categories={categories}
              value={catPaiId}
              onChange={setCategoryId}
              filter={categoryFilter}
              allowEmpty
              onlyParents
            />
          ) : null}
          {!isTransfer && !isConsolidated && !nfceNote && subcats.length > 0 ? (
            <Select
              label="Subcategoria (opcional)"
              items={subcats.map((c) => ({ id: c.id, label: c.name }))}
              selectedId={catSel?.parent_id ? catSel.id : null}
              onSelect={(id) => setCategoryId(id ?? catPaiId)}
              allowEmpty
              emptyLabel="Sem subcategoria"
            />
          ) : null}
          {/* A conta do grupo vale para todas as linhas à vista e as linhas em conta. */}
          {isConsolidated ? (
            <Select
              label={`${ICONS.contaDoGrupo} Conta do grupo`}
              items={accounts}
              selectedId={accountId}
              onSelect={setAccountId}
            />
          ) : null}
          {/* v41: nota lida exige DESPESA — em outro tipo ela fica na tela NFC-e */}
          {nfceNote && !isPlain ? (
            <Text className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2.5 py-2">
              🧾 Nota lida ({nfceNote.storeName ?? 'loja'} · {formatBRL(nfceNote.totalCents ?? 0)}) só é lançada em DESPESA — em outro tipo ela fica na tela NFC-e para revisão.
            </Text>
          ) : null}
        </Card>


        {/* v103 — ITENS DA NOTA LIDA (QR). RECOLHIDO por padrão; no padrão da
            "fechinha" do app (ajustes:42-74). O aviso de Fixo/Parcelado fica
            FORA do card, sempre visível mesmo recolhido. */}
        {nfceNote && kind === 'EXPENSE' && !isEdit ? (
          <View className="mt-3 gap-2">
            <Pressable
              onPress={() => setItemsOpen((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={`${itemsOpen ? 'Recolher' : 'Expandir'} itens da nota fiscal`}
              className="flex-row items-center gap-2 bg-white border border-slate-200 rounded-2xl px-3 py-3"
            >
              <Text className="text-sm font-bold text-emerald-700 w-4">{itemsOpen ? ICONS.recolher : ICONS.expandir}</Text>
              <View className="flex-1">
                <Text className="text-sm font-bold uppercase tracking-wide text-slate-800">
                  Itens da nota fiscal (NFC-e)
                </Text>
              </View>
              <Text className="text-xs text-slate-500">{nfceNote.items.length} item(ns)</Text>
            </Pressable>
            {itemsOpen ? (
              <Card className="gap-2">
                {nfceNote.items.map((it) => (
                  <View key={it.id} className="rounded-xl border border-slate-200 p-2.5 gap-1">
                    <View className="flex-row justify-between gap-2">
                      <Text className="text-sm font-semibold text-slate-800 flex-1" numberOfLines={2}>
                        {it.lineNumber}. {it.description ?? '(sem descrição)'}
                      </Text>
                      <Text className="text-sm font-bold text-slate-700">
                        {it.totalCents != null ? formatBRL(it.totalCents) : '—'}
                      </Text>
                    </View>
                    <Text className="text-xs text-slate-500">
                      Qtde: {it.qty ?? '—'} {it.unitOriginal ?? ''}
                      {it.productName ? ` · produto: ${it.productName}` : ''}
                      {it.totalCents == null ? ' · valor não lido' : ''}
                    </Text>
                    <View className="flex-row items-center justify-between gap-2">
                      <Text className={`text-xs px-1.5 py-0.5 rounded ${nfceMatchBadge(it).cls}`}>
                        {nfceMatchBadge(it).text}
                      </Text>
                      {it.stockApplied ? (
                        <Text className="text-xs text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded font-semibold">
                          já no estoque
                        </Text>
                      ) : it.productId ? (
                        <Text className="text-xs text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded font-semibold">
                          classificado (estoque via Catálogo)
                        </Text>
                      ) : (
                        <Text className="text-xs text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded font-semibold">
                          classificar no Catálogo
                        </Text>
                      )}
                    </View>
                  </View>
                ))}
              </Card>
            ) : null}
            {modality !== 'AVISTA' ? (
              <Text className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2.5 py-2">
                Em Fixo/Parcelado a nota NÃO é anexada nem aplica estoque — salve em À vista para vincular a nota aos itens.
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* ---------- CONSOLIDADO: linhas (débito/crédito, modalidade, descrição, valor e categoria). ---------- */}
        {isConsolidated ? (
          <Card className="gap-3 mt-3">
            <View className="flex-row justify-between items-center">
              <Text className="font-semibold text-slate-900">Linhas do grupo</Text>
              <Text className="text-xs text-slate-500">
                {ICONS.despesa} −{formatBRL(debitTotal)} · {ICONS.receita} +{formatBRL(creditTotal)}
              </Text>
            </View>
            {lines.map((l) => {
              const isOpen = l.key === openLineKey;
              const destinationLocked =
                l.persistedKind === 'FIXO' ||
                (l.persistedKind === 'PARCELADO' && (l.pendingInstallments ?? 0) === 0);
              return isOpen ? (
                <View key={l.key} className="gap-1.5 rounded-xl border border-slate-200 p-2.5">
                  {/* v10: alternância EXPLÍCITA — Débito e Crédito sempre visíveis.
                      v67 (BUG 5): trocar o lado LIMPA a categoria da linha que
                      não pertence ao novo lado (cada direção com a sua lista). */}
                  {l.persistedKind === 'FIXO' || l.persistedKind === 'PARCELADO' ? (
                    <Text className="text-sm font-medium text-slate-600">
                      Direção: {l.dir === 'DEBIT' ? 'Débito' : 'Crédito'} · para trocar, remova e adicione outra linha.
                    </Text>
                  ) : (
                    <Segmented<'DEBIT' | 'CREDIT'>
                      value={l.dir}
                      onChange={(v) => {
                        const cat = categories.find((c) => c.id === l.categoryId);
                        const keep = !l.categoryId || (cat ? categoryMatchesFilter(cat, v) : true);
                        updateLine(l.key, { dir: v, categoryId: keep ? l.categoryId : null });
                      }}
                      options={[
                        { value: 'DEBIT', label: `${ICONS.despesa} Débito` },
                        { value: 'CREDIT', label: `${ICONS.receita} Crédito` },
                      ]}
                      activeBg={l.dir === 'DEBIT' ? 'bg-rose-600' : 'bg-emerald-600'}
                    />
                  )}
                  {/* v10: modalidade da linha — mesmo comportamento das outras formas */}
                  {l.persistedKind ? (
                    <Text className="text-sm font-medium text-slate-600">
                      Modalidade: {l.modality === 'AVISTA' ? 'À vista' : l.modality === 'FIXO' ? 'Fixo' : 'Parcelado'} · para trocar, remova e adicione outra linha.
                    </Text>
                  ) : (
                    <Segmented<'AVISTA' | 'FIXO' | 'PARCELADO'>
                      value={l.modality}
                      onChange={(v) => updateLine(l.key, { modality: v })}
                      options={[
                        { value: 'AVISTA', label: `${ICONS.avista} À vista` },
                        { value: 'FIXO', label: `${ICONS.fixo} Fixo` },
                        { value: 'PARCELADO', label: `${ICONS.parcelado} Parcelado` },
                      ]}
                      activeBg="bg-violet-600"
                    />
                  )}
                  {/* v21 (melhoria 1): CÁLCULO da linha parcelada — Dividir total
                      ou Parcela fixa (as mesmas opções do Parcelado simples) */}
                  {l.modality === 'PARCELADO' ? (
                    l.persistedKind === 'PARCELADO' && (l.pendingInstallments ?? 0) === 0 ? (
                      <Text className="text-sm font-medium text-slate-600">
                        Cálculo: {l.planMode === 'DIVIDE_TOTAL' ? 'Dividir total' : 'Parcela fixa'} · sem parcelas em aberto.
                      </Text>
                    ) : (
                      <Segmented<'DIVIDE_TOTAL' | 'FIXED_PER_MONTH'>
                        value={l.planMode}
                        onChange={(v) => updateLine(l.key, { planMode: v })}
                        options={[
                          { value: 'DIVIDE_TOTAL', label: 'Dividir total' },
                          { value: 'FIXED_PER_MONTH', label: 'Parcela fixa' },
                        ]}
                        activeBg="bg-violet-600"
                      />
                    )
                  ) : null}
                  {/* v69: "Repetir" da LINHA (Fixo/Parcelado) — BOTÕES com o
                      esquema de cores da direção (débito rose / crédito emerald) */}
                  {l.modality !== 'AVISTA' ? (
                    <>
                      <Text className={`text-sm font-medium ${theme.textMuted}`}>Repetir</Text>
                      {l.persistedKind ? (
                        <Text className="text-sm text-slate-600">
                          {REPEAT_BUTTONS.find((option) => option.value === l.repeat)?.label ?? 'Mensal'}
                        </Text>
                      ) : (
                        <RepeatButtons
                          value={l.repeat}
                          onChange={(v) => updateLine(l.key, { repeat: v })}
                          tone={l.dir === 'CREDIT' ? 'emerald' : 'rose'}
                        />
                      )}
                    </>
                  ) : null}
                  {/* v13 (bug 1.C): DESTINO da linha Fixo/Parcelado — conta do grupo
                      ou CARTÃO DE CRÉDITO (as parcelas/ocorrências vão para a fatura) */}
                  {l.modality !== 'AVISTA' ? (
                    <>
                      {destinationLocked ? (
                        <Text className="text-sm font-medium text-slate-600">
                          Destino: {l.target === 'CARD' ? 'Cartão de crédito' : 'Conta do grupo'}
                        </Text>
                      ) : (
                        <Segmented<'ACCOUNT' | 'CARD'>
                          value={l.target}
                          onChange={(v) => updateLine(l.key, { target: v, invoiceMonth: null })}
                          options={[
                            { value: 'ACCOUNT', label: `${ICONS.contaDoGrupo} Conta do grupo` },
                            { value: 'CARD', label: `${ICONS.cartoes} Cartão de crédito` },
                          ]}
                          activeBg="bg-violet-600"
                        />
                      )}
                      {l.target === 'CARD' && destinationLocked ? (
                        <Text className="text-sm text-slate-600">
                          Cartão: {cards.find((card) => card.id === l.cardId)?.label ?? 'cartão vinculado'}
                        </Text>
                      ) : l.target === 'CARD' ? (
                        <Select
                          label="Cartão de crédito (destino da linha)"
                          items={cards}
                          selectedId={l.cardId}
                          onSelect={(id) => updateLine(l.key, { cardId: id, invoiceMonth: null })}
                        />
                      ) : null}
                      {/* v26: "Mês da fatura" também para linhas Fixo/Parcelado no cartão */}
                      {l.target === 'CARD' && l.cardId && l.persistedKind ? (
                        <Text className="text-xs text-slate-500">
                          A fatura das ocorrências/parcelas existentes acompanha as respectivas datas de vencimento.
                        </Text>
                      ) : l.target === 'CARD' && l.cardId ? (() => {
                        const lc = cards.find((c) => c.id === l.cardId);
                        if (!lc) return null;
                        const suggested = suggestInvoiceMonth(lc.closingDay, date);
                        const chosen = l.invoiceMonth ?? suggested;
                        const opts: Array<{ id: string; label: string }> = [
                          { id: monthAdd(suggested, -1), label: `${monthLabel(monthAdd(suggested, -1))} (anterior)` },
                          { id: suggested, label: `${monthLabel(suggested)} (sugerida)` },
                        ];
                        for (let i = 1; i <= 6; i++) {
                          const ym = monthAdd(suggested, i);
                          opts.push({ id: ym, label: monthLabel(ym) });
                        }
                        return (
                          <>
                            <Select
                              label="Mês da fatura"
                              items={opts}
                              selectedId={chosen}
                              onSelect={(id) => updateLine(l.key, { invoiceMonth: id })}
                            />
                            <Text className="text-xs text-slate-500 -mt-1">
                              Sugerido pelo fechamento do cartão ({lc.closingDay}).{' '}
                              {l.modality === 'FIXO'
                                ? 'Fixo: vale para todos os meses (mesmo deslocamento).'
                                : 'Parcelado: é a fatura da 1ª parcela; as demais seguem mês a mês.'}
                            </Text>
                          </>
                        );
                      })() : null}
                    </>
                  ) : null}
                  <View className="flex-row items-center gap-1.5">
                    <View className="flex-1">
                      <TextField
                        label="Descrição da linha"
                        value={l.description}
                        onChangeText={(v) => updateLine(l.key, { description: v })}
                        placeholder="Ex.: Feira, Farmácia, Salário extra…"
                      />
                    </View>
                    {lines.length > 1 ? (
                      <Pressable
                        onPress={() => removeLine(l.key)}
                        accessibilityLabel="Remover linha"
                        className="rounded-lg bg-slate-100 px-2.5 py-1.5 self-end"
                      >
                        <Text className="text-sm font-bold text-slate-500">✕</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {l.persistedKind === 'PARCELADO' && (l.pendingInstallments ?? 0) === 0 ? (
                    <Text className="text-sm text-slate-600">
                      Valor: {formatBRL(l.cents)} · sem parcelas em aberto.
                    </Text>
                  ) : (
                    <MoneyInput
                      label={l.modality === 'PARCELADO' && l.planMode === 'FIXED_PER_MONTH' ? 'Valor da parcela (R$)' : l.modality === 'PARCELADO' ? 'Valor total (R$)' : 'Valor'}
                      cents={l.cents}
                      onChangeCents={(c) => updateLine(l.key, { cents: c })}
                      accentTextClass={l.dir === 'DEBIT' ? 'text-rose-700' : 'text-emerald-700'}
                    />
                  )}
                  {/* v10 (Req 4): CATEGORIA na linha — vale para DÉBITO e para CRÉDITO */}
                  <CategorySelect
                    label="Categoria (opcional)"
                    categories={categories}
                    value={l.categoryId}
                    onChange={(v) => updateLine(l.key, { categoryId: v })}
                    filter={l.dir === 'DEBIT' ? 'DEBIT' : 'CREDIT'}
                    allowEmpty
                  />
                  {l.modality === 'PARCELADO' ? (
                    <>
                      {l.persistedKind === 'PARCELADO' && (l.pendingInstallments ?? 0) === 0 ? (
                        <Text className="text-sm text-slate-600">
                          Parcelas: {l.parcelas} · sem parcelas em aberto.
                        </Text>
                      ) : (
                        <TextField
                          label="Número de parcelas (2 ou mais)"
                          value={l.parcelas}
                          onChangeText={(v) => updateLine(l.key, { parcelas: v })}
                          keyboardType="numeric"
                          placeholder="Ex.: 12"
                        />
                      )}
                      {/* v17 (melhoria 1): "Dividir total" mostra o VALOR EXATO de
                          cada parcela enquanto o usuário digita (resto na última).
                          v21 (melhoria 1): na linha do consolidado vale para os DOIS
                          modos (Dividir total e Parcela fixa). */}
                      {(() => {
                        const n = parseInt(l.parcelas, 10);
                        if (!Number.isInteger(n) || n < 2 || l.cents <= 0) return null;
                        if (l.planMode === 'FIXED_PER_MONTH') {
                          return (
                            <Text className="text-xs text-violet-700 bg-violet-50 rounded-lg px-2.5 py-1.5">
                              Total do parcelamento: {formatBRL(l.cents * n)} em {n} parcela(s) · cada parcela: {formatBRL(l.cents)}
                            </Text>
                          );
                        }
                        const parts = divideCents(l.cents, n);
                        const resto = parts[n - 1] !== parts[0];
                        return (
                          <Text className="text-xs text-violet-700 bg-violet-50 rounded-lg px-2.5 py-1.5">
                            Cada parcela: {formatBRL(parts[0])}
                            {resto ? ` · última parcela ${formatBRL(parts[n - 1])} (ajuste de centavos)` : ` × ${n}`}
                          </Text>
                        );
                      })()}
                    </>
                  ) : null}
                </View>
              ) : (
                // v9: linha RETRAÍDA (sanfona) — toque para reabrir
                <Pressable
                  key={l.key}
                  onPress={() => setOpenLineKey(l.key)}
                  accessibilityRole="button"
                  accessibilityLabel={`Abrir linha ${l.description || 'sem descrição'}`}
                  className="rounded-xl border border-dashed border-slate-200 px-2.5 py-2 flex-row items-center gap-2"
                >
                  <Text className={`text-sm font-bold ${l.dir === 'DEBIT' ? 'text-rose-600' : 'text-emerald-600'}`}>
                    {l.dir === 'DEBIT' ? ICONS.despesa : ICONS.receita}
                  </Text>
                  <Text className="text-sm text-slate-700 flex-1" numberOfLines={1}>
                    {l.description.trim() || 'Linha sem descrição'}
                  </Text>
                  {l.modality === 'FIXO' ? (
                    <Text className="text-xs text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded font-semibold">FIXA</Text>
                  ) : null}
                  {l.modality === 'PARCELADO' ? (
                    <Text className="text-xs text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded font-semibold">{l.parcelas}x</Text>
                  ) : null}
                  {l.modality !== 'AVISTA' && l.target === 'CARD' ? (
                    <Text className="text-xs text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded font-semibold">
                      {ICONS.cartoes} {cards.find((c) => c.id === l.cardId)?.label ?? 'CARTÃO'}
                    </Text>
                  ) : null}
                  <Text className={`text-sm font-bold ${l.dir === 'DEBIT' ? 'text-rose-600' : 'text-emerald-600'}`}>
                    {l.dir === 'DEBIT' ? '−' : '+'}
                    {formatBRL(l.cents)}
                  </Text>
                  {lines.length > 1 ? (
                    <Pressable
                      onPress={() => removeLine(l.key)}
                      accessibilityLabel="Remover linha"
                      className="rounded-lg bg-slate-100 px-2 py-1"
                    >
                      <Text className="text-xs font-bold text-slate-500">✕</Text>
                    </Pressable>
                  ) : null}
                  <Text className="text-slate-400">{ICONS.expandir}</Text>
                </Pressable>
              );
            })}
            <Button label={`＋ Adicionar linha`} variant="outline" onPress={addLine} />
            <Text className="text-xs text-slate-500">
              Cada linha à vista vira um lançamento próprio (com descrição e valor próprios) dentro da mesma operação — a CONTA do grupo, definida no cabeçalho, vale para elas. Cada linha também pode ser marcada como FIXA (vira conta fixa mensal) ou PARCELADA (vira parcelamento — despesa OU receita parcelada) e, nessas duas, escolher o DESTINO: a conta do grupo ou um CARTÃO DE CRÉDITO (as ocorrências/parcelas do cartão entram na fatura). Ao adicionar uma linha, as anteriores se retraem; toque nelas para reabrir.
            </Text>
            {fixoCount > 0 || parceladoCount > 0 ? (
              <Text className="text-xs text-violet-700 bg-violet-50 rounded-lg px-2.5 py-2">
                Resumo: {avistaLines.filter((l) => l.cents > 0).length} linha(s) à vista no grupo
                {fixoCount ? ` · ${fixoCount} conta(s) fixa(s)` : ''}
                {parceladoCount ? ` · ${parceladoCount} parcelamento(s)` : ''}.
              </Text>
            ) : null}
          </Card>
        ) : null}

        {/* ---------- TRANSFERÊNCIA ---------- */}
        {isTransfer ? (
          <Card className="gap-3 mt-3">
            <Select label="De (origem)" items={accounts} selectedId={fromId} onSelect={setFromId} />
            <Select label="Para (destino)" items={accounts} selectedId={toId} onSelect={setToId} />
          </Card>
        ) : null}

        {/* ---------- DESPESA/RECEITA: destino e parcelas ---------- */}
        {isPlain ? (
          <Card className="gap-3 mt-3">
            <Segmented<'ACCOUNT' | 'CARD'>
              value={target}
              onChange={(v) => {
                setTarget(v);
                if (v === 'CARD') setInvoiceMonthTouched(false);
              }}
              options={[
                { value: 'ACCOUNT', label: 'Conta' },
                { value: 'CARD', label: 'Cartão' },
              ]}
            />
            {target === 'ACCOUNT' ? (
              <Select label="Conta" items={accounts} selectedId={accountId} onSelect={setAccountId} />
            ) : (
              <View className="gap-1">
                <Select label="Cartão" items={cards} selectedId={cardId} onSelect={setCardId} />
                {modality === 'AVISTA' || modality === 'FIXO' || modality === 'PARCELADO' ? (
                  <>
                    <Select
                      label="Mês da fatura"
                      items={invoiceOptions}
                      selectedId={invoiceMonth}
                      onSelect={(id) => {
                        setInvoiceMonth(id);
                        setInvoiceMonthTouched(true);
                      }}
                    />
                  </>
                ) : null}
              </View>
            )}
            {modality === 'PARCELADO' ? (
              <>
                <TextField
                  label="Número de parcelas (2 ou mais)"
                  value={installments}
                  onChangeText={setInstallments}
                  keyboardType="numeric"
                  placeholder="Ex.: 12"
                />
                {!isEdit ? (
                  <TextField
                    label="Parcela atual (opcional)"
                    value={parcelaAtual}
                    onChangeText={(t) => setParcelaAtual(t.replace(/\D/g, ''))}
                    keyboardType="numeric"
                    placeholder="1"
                  />
                ) : null}
                {emAndamento ? (
                  <Text className="text-xs font-semibold text-slate-600 -mt-1">
                    Começa na parcela {atualParc}/{nParc} · {restantes} parcela(s) restante(s)
                  </Text>
                ) : null}
                {/* v11 (Req 4): no modo "Parcela fixa" o total é calculado automaticamente.
                    v17 (melhoria 1): em AMBOS os modos o valor de cada parcela fica
                    visível — em "Dividir total" é o cálculo exato (resto na última). */}
                {planMode === 'FIXED_PER_MONTH' ? (
                  <Text className="text-xs text-slate-500 -mt-1">
                    Total {emAndamento ? 'restante' : 'do parcelamento'}: {formatBRL(cents * restantes)} em {restantes} parcela(s) · cada parcela: {formatBRL(cents)}
                  </Text>
                ) : (() => {
                  const n = restantes;
                  if (!Number.isInteger(nParc) || nParc < 2 || n < 1 || cents <= 0) return null;
                  const parts = divideCents(cents, n);
                  const resto = parts[n - 1] !== parts[0];
                  return (
                    <Text className="text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg px-2.5 py-1.5 -mt-1">
                      Cada parcela: {formatBRL(parts[0])}
                      {resto ? ` · última parcela ${formatBRL(parts[n - 1])} (ajuste de centavos)` : ` × ${n}`}
                    </Text>
                  );
                })()}
              </>
            ) : null}
            {kind === 'INCOME' && target === 'CARD' && modality === 'AVISTA' ? (
              <Text className="text-xs text-rose-600">
                Receita à vista só em conta. No cartão, use Fixo ou Parcelado.
              </Text>
            ) : null}
          </Card>
        ) : null}

        <View className="mt-4">
          {/* v21 (bug 4): ALTERAR exige confirmação antes de efetivar; criar segue direto */}
          <Button
            label={saveLabel}
            onPress={() => (isEdit ? setConfirmEditOpen(true) : save())}
            loading={saving}
            disabled={saving}
            bg={ks.solid}
          />
        </View>
      </ScrollView>

      <NfceScannerModal
        visible={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={ingestNfce}
        busy={scanning}
        errorMessage={scannerError}
        // v41: a nota NÃO registra sozinha — vem para o formulário
        bottomHint="A nota vem para este formulário: você escolhe categoria, pagamento e o estoque antes de salvar."
      />

      {/* v21 (bug 4): confirmação da ALTERAÇÃO antes de gravar */}
      <ConfirmDialog
        visible={confirmEditOpen}
        title="Confirmar alterações?"
        message={`As mudanças em "${editLabel ?? (description || 'lançamento')}" serão gravadas.${editIsRecurrence && description.trim() !== editOrigDescription.trim() ? '\nA descrição nova vale para a conta fixa inteira (meses seguintes incluídos).' : ''}`}
        buttons={[
          { label: 'Salvar alterações', color: 'green', onPress: save },
          { label: 'Cancelar', color: 'red', onPress: () => setConfirmEditOpen(false) },
        ]}
        onClose={() => setConfirmEditOpen(false)}
      />
    </Screen>
  );
}
