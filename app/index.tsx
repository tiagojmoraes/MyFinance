/** Tela Início — LIQUIDEZ ATUAL (spec v7) + CARTÕES com a fatura do mês vigente (v9).
 *  v9: seção "PRÓXIMOS COMPROMISSOS" removida; nova seção CARTÕES lista os cartões
 *  cadastrados e o valor a pagar da fatura do mês vigente (vence, status, valor).
 *  Ações Rápidas = NFC-e · OFX · Despensa + Orçamento/Poupança quando ligados.
 *  v42 — ORÇAMENTO e POUPANÇA entram em "Ações rápidas" QUANDO o usuário liga
 *  a opção na tela Ajustes (persistida no banco — sempre visível após reabrir).
 *  v68 — NFC-e, OFX e Despensa viraram TOGGLES em Ajustes › Preferencias e a
 *  seção "AÇÕES RÁPIDAS" só é formada com ALGUMA opção ativada — se nenhuma
 *  estiver, a seção some.
 *  v69 — NOVOS ATALHOS "Mensagens bancárias" e "Lista de Desejos" (toggles em
 *  Ajustes) e, na seção CONTAS, a FECHINHA das contas que guardam reserva da
 *  Lista de Desejos: expande e separa "Poupança normal" / "Reserva Lista de
 *  Desejos" (caixinha fora do saldo geral) com a barrinha de cada item
 *  (valor total do item, quanto já reservou e quanto falta).
 */

import React from 'react'; // v48 #2 — useMemo para totais da Home
import { View, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, SectionTitle, EmptyState, Badge, ProgressBar } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { formatBRL } from '../src/lib/money';
import { ymdToBr } from '../src/lib/dates';
import { ICONS } from '../src/theme/icons';
import { SETTING_KEYS } from '../src/services/SettingsService';
import type { AccountBalance } from '../src/services/BalanceService';
import { RESERVA_ACCOUNT_NAME } from '../src/services/WishlistService';

interface CardInvoiceSummary {
  cardId: string;
  cardName: string;
  lastFour: string | null;
  closingDay: number;
  dueDay: number;
  hasInvoice: boolean;
  dueCents: number;
  dueDate: string | null;
  liveStatus: string | null;
  referenceMonth: string;
}

interface ReservaAccountInfo {
  totalCents: number;
  items: Array<{ itemId: string; description: string; targetCents: number; reservedCents: number }>;
}

export default function HomeScreen() {
  const services = useDataEffect();
  const [general, setGeneral] = React.useState<number | null>(null);
  const [accounts, setAccounts] = React.useState<AccountBalance[]>([]);
  const [cardsSummary, setCardsSummary] = React.useState<CardInvoiceSummary[]>([]);
  // v42: flags dos módulos (Orçamento / Poupança aparecem só quando ligados em Ajustes)
  const [showBudgets, setShowBudgets] = React.useState(false);
  const [showSavings, setShowSavings] = React.useState(false);
  // v68: atalhos NFC-e / OFX / Despensa — toggles em Ajustes › Preferencias
  const [showNfce, setShowNfce] = React.useState(true);
  const [showOfx, setShowOfx] = React.useState(true);
  const [showDespensa, setShowDespensa] = React.useState(true);
  // v69: atalhos Mensagens bancárias / Lista de Desejos + reservas por conta
  const [showMensagens, setShowMensagens] = React.useState(false);
  const [showWishlist, setShowWishlist] = React.useState(false);
  const [reservas, setReservas] = React.useState<Record<string, ReservaAccountInfo>>({});
  const [accountOpen, setAccountOpen] = React.useState<Record<string, boolean>>({});
  const [loading, setLoading] = React.useState(true);
  // v48 #2 — totais memoizados: recalcula só quando accounts/cards mudam, não a cada setState
  const totalAccounts = React.useMemo(() => accounts.reduce((s, a) => s + a.balanceCents, 0), [accounts]);
  const totalCardsDue = React.useMemo(() => cardsSummary.reduce((s, c) => s + (c.dueCents || 0), 0), [cardsSummary]);

  useDataEffect(async (svc) => {
    const [g, list, cards, bFlag, sFlag, nFlag, oFlag, dFlag, mFlag, wFlag, reservasMap] = await Promise.all([
      svc.balance.getGeneralBalance(),
      svc.balance.listAccountBalances(),
      svc.invoices.listCardsWithCurrentInvoice(),
      svc.settings.getBool(SETTING_KEYS.budgetsAtivado, false),
      svc.settings.getBool(SETTING_KEYS.poupancaAtivado, false),
      svc.settings.getBool(SETTING_KEYS.nfceNaHome, true),
      svc.settings.getBool(SETTING_KEYS.ofxNaHome, true),
      svc.settings.getBool(SETTING_KEYS.despensaNaHome, true),
      svc.settings.getBool(SETTING_KEYS.mensagensNaHome, false),
      svc.settings.getBool(SETTING_KEYS.wishlistNaHome, false),
      svc.wishlist.reservesByAccount(),
    ]);
    setGeneral(g);
    setAccounts(list);
    setCardsSummary(cards as unknown as CardInvoiceSummary[]);
    setShowBudgets(bFlag);
    setShowSavings(sFlag);
    setShowNfce(nFlag);
    setShowOfx(oFlag);
    setShowDespensa(dFlag);
    setShowMensagens(mFlag);
    setShowWishlist(wFlag);
    setReservas(reservasMap as Record<string, ReservaAccountInfo>);
    setLoading(false);
  });

  // v68: "AÇÕES RÁPIDAS" só é formada se estiver alguma opção ativada —
  // se nenhuma estiver, a seção INTEIRA some. v69: + Mensagens / Lista de Desejos.
  const anyQuickAction = showNfce || showOfx || showDespensa || showBudgets || showSavings || showMensagens || showWishlist;
  const quickActions = React.useMemo(() => (
    <View className="flex-row flex-wrap gap-2">
      {showNfce ? <QuickAction icon={ICONS.nfce} label="NFC-e" onPress={() => router.push('/nfce')} /> : null}
      {showOfx ? <QuickAction icon={ICONS.ofx} label="OFX" onPress={() => router.push('/ofx')} /> : null}
      {showDespensa ? <QuickAction icon={ICONS.despensa} label="Despensa" onPress={() => router.push('/despensa')} /> : null}
      {/* v42: ligados em Ajustes › Orçamento e Poupança */}
      {showBudgets ? (
        <QuickAction icon={ICONS.orcamento} label="Orçamento" onPress={() => router.push('/orcamento')} />
      ) : null}
      {showSavings ? (
        <QuickAction icon={ICONS.poupanca} label="Poupança" onPress={() => router.push('/poupanca')} />
      ) : null}
      {/* v69→v70: Notificações do banco e Lista de Desejos (toggles em Ajustes) */}
      {showMensagens ? (
        <QuickAction icon={ICONS.mensagens} label="Notificações do banco" onPress={() => router.push('/mensagens')} />
      ) : null}
      {showWishlist ? (
        <QuickAction icon={ICONS.listaDesejos} label="Lista de Desejos" onPress={() => router.push('/lista-desejos')} />
      ) : null}
    </View>
  ), [showNfce, showOfx, showDespensa, showBudgets, showSavings, showMensagens, showWishlist]);

  return (
    <Screen title="MyFinance & Pantry" subtitle="Liquidez atual">
      {loading || general == null ? (
        <Card><Text className="text-slate-500">Calculando saldos...</Text></Card>
      ) : (
        <Card className="items-center py-6">
          <Text className="text-slate-500 text-sm">Saldo geral (liquidez)</Text>
          <Text className="text-4xl font-bold text-emerald-700 mt-1">{formatBRL(general)}</Text>
        </Card>
      )}

      <SectionTitle>Contas</SectionTitle>
      {accounts.length === 0 ? (
        <EmptyState icon={ICONS.contas} title="Nenhuma conta" hint="Toque em Cadastro (rodapé) › Contas para criar a primeira." />
      ) : (
        accounts.map((acc) => (
          <Card key={acc.accountId} className="!py-3">
            <View className="flex-row justify-between items-center">
              <View>
                <Text className="font-semibold text-slate-900">{acc.name}</Text>
                <Text className="text-xs text-slate-500">
                  {acc.type === 'CHECKING' ? 'Corrente' : acc.type === 'SAVINGS' ? 'Poupança' : 'Dinheiro'}
                  {acc.includeInGeneral ? '' : ' (fora do saldo geral)'}
                </Text>
              </View>
              <Text className={`font-bold ${acc.balanceCents < 0 ? 'text-rose-600' : 'text-slate-900'}`}>
                {formatBRL(acc.balanceCents)}
              </Text>
            </View>
            {/* v69 (5.5): FECHINHA da conta que guarda reserva da Lista de Desejos —
                separa "Poupança normal" / "Reserva Lista de Desejos" (a caixinha
                "Reserva · Lista de Desejos" fica fora do saldo geral) e mostra a
                barrinha de cada item: valor total, quanto já reservou e quanto falta. */}
            {reservas[acc.accountId] ? (
              <ReservaChevron
                accName={acc.name}
                accBalance={acc.balanceCents}
                info={reservas[acc.accountId]}
                open={!!accountOpen[acc.accountId]}
                onToggle={() => setAccountOpen((cur) => ({ ...cur, [acc.accountId]: !cur[acc.accountId] }))}
              />
            ) : null}
          </Card>
        ))
      )}

      {/* v9: seção CARTÕES — fatura do mês vigente de cada cartão */}
      <SectionTitle>Cartões de Crédito</SectionTitle>
      {cardsSummary.length === 0 ? (
        <EmptyState icon={ICONS.cartoes} title="Nenhum cartão de crédito" hint="Toque em Cadastro (rodapé) › Cartões de Crédito para cadastrar o primeiro." />
      ) : (
        cardsSummary.map((c) => (
          <Card key={c.cardId} className="!py-3">
            <Pressable onPress={() => router.push(`/cartoes/${c.cardId}`)}>
              <View className="flex-row justify-between items-center gap-2">
                <View className="flex-1">
                  <View className="flex-row items-center gap-1.5">
                    <Text className="text-base">{ICONS.cartoes}</Text>
                    <Text className="font-semibold text-slate-900" numberOfLines={1}>
                      {c.cardName}
                      {c.lastFour ? ` ••${c.lastFour}` : ''}
                    </Text>
                  </View>
                  <Text className="text-xs text-slate-500 mt-0.5">
                    {c.hasInvoice
                      ? `Fatura ${c.referenceMonth.split('-')[1]}/${c.referenceMonth.split('-')[0]} · fecha dia ${c.closingDay} · vence ${c.dueDate ? ymdToBr(c.dueDate) : '—'}`
                      : `Fecha dia ${c.closingDay} · sem fatura no mês vigente`}
                  </Text>
                  <View className="flex-row gap-1 mt-1 items-center flex-wrap">
                    {c.hasInvoice && c.liveStatus ? <Badge status={c.liveStatus} /> : null}
                  </View>
                </View>
                <View className="items-end gap-0.5">
                  <Text className="text-[10px] font-semibold uppercase text-slate-400">A pagar</Text>
                  <Text
                    className={`font-bold ${
                      !c.hasInvoice ? 'text-slate-400' : c.dueCents > 0 ? 'text-rose-600' : 'text-emerald-600'
                    }`}
                  >
                    {c.hasInvoice ? formatBRL(c.dueCents) : '—'}
                  </Text>
                </View>
              </View>
            </Pressable>
          </Card>
        ))
      )}

      {/* v68: a seção só existe quando há pelo menos UMA opção ativada em
          Ajustes › Preferencias — sem nenhuma, "Ações rápidas" some. */}
      {anyQuickAction ? (
        <>
          <SectionTitle>Ações rápidas</SectionTitle>
          {quickActions}
        </>
      ) : null}
    </Screen>
  );
}

function QuickAction({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="bg-white border border-slate-200 rounded-xl px-3 py-2.5 flex-row items-center gap-1.5"
    >
      <Text className="text-emerald-700 font-bold">{icon}</Text>
      <Text className="text-slate-800 font-medium text-sm">{label}</Text>
    </Pressable>
  );
}

/** v69 (5.5) — fechinha da conta com RESERVA da Lista de Desejos:
 *  expande para separar "Poupança normal" x "Reserva Lista de Desejos" e ver
 *  a barrinha de cada item (total, reservado, falta). */
function ReservaChevron({ accName, accBalance, info, open, onToggle }: {
  accName: string;
  accBalance: number;
  info: ReservaAccountInfo;
  open: boolean;
  onToggle: () => void;
}) {
  const ehCaixinha = accName === RESERVA_ACCOUNT_NAME;
  const normal = Math.max(0, accBalance - info.totalCents);
  return (
    <View className="mt-2 border-t border-dashed border-slate-200 pt-2 gap-1">
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`${open ? 'Recolher' : 'Expandir'} reserva da Lista de Desejos em ${accName}`}
        className="flex-row items-center gap-2 self-start"
      >
        <Text className="text-xs font-bold text-violet-700">{open ? ICONS.recolher : ICONS.expandir}</Text>
        <Text className="text-xs font-semibold text-violet-700">
          {ICONS.reserva} Reserva Lista de Desejos: {formatBRL(info.totalCents)}
        </Text>
      </Pressable>
      {open ? (
        <View className="gap-1.5">
          {!ehCaixinha ? (
            <View className="flex-row justify-between">
              <Text className="text-xs text-slate-600">Poupança normal</Text>
              <Text className="text-xs font-semibold text-slate-800">{formatBRL(normal)}</Text>
            </View>
          ) : null}
          <View className="flex-row justify-between">
            <Text className="text-xs text-slate-600">Reserva Lista de Desejos</Text>
            <Text className="text-xs font-semibold text-violet-700">{formatBRL(info.totalCents)}</Text>
          </View>
          {info.items.map((it) => {
            const falta = Math.max(0, it.targetCents - it.reservedCents);
            const pct = it.targetCents > 0 ? Math.round((it.reservedCents / it.targetCents) * 100) : 0;
            return (
              <View key={it.itemId} className="gap-0.5">
                <Text className="text-[11px] text-slate-700" numberOfLines={1}>
                  {it.description} — total {formatBRL(it.targetCents)} · reservado {formatBRL(it.reservedCents)} · falta {formatBRL(falta)}
                </Text>
                <ProgressBar pct={pct} />
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
