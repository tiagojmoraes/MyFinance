/**
 * Tela NOTIFICAÇÕES DO BANCO (v71) — captura AUTOMÁTICA, sem copiar/colar.
 *
 * Até a v70 o texto da notificação entrava na mão (colar) — com dezenas de
 * avisos acumulados virou inviável. v71: com a autorização
 * "Acesso às notificações" (tela do sistema Android, pedida pelo botão
 * "Permitir acesso às notificações"), o app captura as NOTIFICAÇÕES DO BANCO
 * direto da barra do aparelho — as que JÁ ESTÃO lá e as que CHEGAREM
 * (atualização em tempo real). Cada uma aparece no GRID com 02 botões:
 *  · "Lançar"  → entra na lista e abre o Novo Lançamento JÁ PREENCHIDO
 *                (débito = despesa, crédito = receita, valor, data e o cartão
 *                pelo final quando a notificação cita);
 *  · "Excluir" → tira a mensagem do grid (a notificação segue na barra).
 * NUNCA cria lançamento sozinho. Onde o Android não deixa ler as notificações
 * de outros apps (iOS/web/Expo Go), a tela explica a limitação — não falha.
 */

import React from 'react';
import { Text, Pressable, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, Card, Button, EmptyState } from '../src/components/ui';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { showToast } from '../lib/toast';
import { formatBRL } from '../src/lib/money';
import { ymdToBr } from '../src/lib/dates';
import { ICONS } from '../src/theme/icons';
import {
  bankNotificationsSupported,
  getCapturedBankNotifications,
  isBankListenerEnabled,
  openBankListenerSettings,
  removeCapturedBankNotification,
  subscribeBankNotificationsChanged,
} from '../src/lib/bankNotifications';
import { separarCapturadas, type GridBankNotification } from '../src/lib/bankNotificationGrid';
import type { BankMessageRow } from '../src/services/BankMessageService';

/** Estado da autorização de leitura das notificações do banco. */
type Permissao = 'verificando' | 'concedida' | 'pendente' | 'sem-suporte';

export default function MensagensScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [msgs, setMsgs] = React.useState<BankMessageRow[]>([]);
  const [bodiesAtivos, setBodiesAtivos] = React.useState<string[]>([]);
  const [capturadas, setCapturadas] = React.useState(
    [] as ReturnType<typeof getCapturedBankNotifications>
  );
  const [permissao, setPermissao] = React.useState<Permissao>('verificando');
  const [deleting, setDeleting] = React.useState<BankMessageRow | null>(null);
  const [busyGridId, setBusyGridId] = React.useState<string | null>(null);
  // recarga ao voltar para a tela (ex.: depois de autorizar no sistema)
  const [focusTick, setFocusTick] = React.useState(0);

  const load = React.useCallback(async () => {
    // permissão + capturas da barra (nativo, sincrônico e barato)
    setPermissao(
      bankNotificationsSupported()
        ? isBankListenerEnabled()
          ? 'concedida'
          : 'pendente'
        : 'sem-suporte'
    );
    setCapturadas(getCapturedBankNotifications());
    // lista do banco (notificações já importadas, esperando o lançamento)
    setMsgs(await services.bankMessages.listPending());
    setBodiesAtivos(await services.bankMessages.listActiveBodies());
  }, [services]);

  useDataEffect(load, [focusTick]);

  // v71: ao voltar para a tela (ex.: depois de autorizar no sistema) re-checa
  // a permissão e recaptura a barra — as notificações JÁ na barra entram no grid.
  useFocusEffect(
    React.useCallback(() => {
      setFocusTick((t) => t + 1);
    }, [])
  );

  // v71: notificação chegou AGORA (app aberto) — grid atualiza sozinho.
  React.useEffect(
    () =>
      subscribeBankNotificationsChanged(() => {
        setPermissao('concedida');
        setCapturadas(getCapturedBankNotifications());
      }),
    []
  );

  const grid = React.useMemo(
    () => separarCapturadas(capturadas, bodiesAtivos),
    [capturadas, bodiesAtivos]
  );

  const permitirAcesso = () => {
    openBankListenerSettings();
    showToast('Ative o MyFinance na lista “Acesso às notificações” e volte aqui');
  };

  /** Botão "Lançar" do GRID: importa a notificação e abre o Novo Lançamento
   *  preenchido (débito = despesa, crédito = receita). NUNCA cria sozinho. */
  const lancarCapturada = async (item: GridBankNotification) => {
    setBusyGridId(item.id);
    try {
      const r = await services.bankMessages.ingest(item.appName ?? item.appPackage, item.body);
      if (!r.id) {
        showToast(r.motivo ?? 'Não encontrei valor (R$) nessa notificação', 'err');
        return;
      }
      if (!r.inserted && r.status === 'LANCADO') {
        showToast('Essa notificação já foi lançada — confira no Fluxo');
        return;
      }
      showToast(
        r.inserted
          ? 'Notificação na lista — revise e salve no Novo Lançamento'
          : 'Já estava na lista — revise e salve no Novo Lançamento'
      );
      router.push({ pathname: '/lancamento', params: { msg: r.id } });
      // sai do grid (agora está no banco) e entra na "Lista para lançar"
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusyGridId(null);
    }
  };

  /** Botão "Excluir" do GRID: tira a mensagem do grid (sem confirmação —
   *  a notificação continua na barra do sistema; nada é apagado do banco). */
  const excluirCapturada = (item: GridBankNotification) => {
    removeCapturedBankNotification(item.id);
    setCapturadas((prev) => prev.filter((c) => c.id !== item.id));
    showToast('Mensagem tirada do grid');
  };

  const removerDaLista = async () => {
    if (!deleting) return;
    try {
      await services.bankMessages.discard(deleting.id);
      showToast('Notificação tirada da lista');
      setDeleting(null);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  const hintGridVazio =
    permissao === 'pendente'
      ? 'Toque em “Permitir acesso às notificações” — as notificações que já estão na barra e as que chegarem aparecem aqui.'
      : permissao === 'concedida'
        ? 'Assim que o banco mandar uma notificação, ela aparece aqui para você decidir Lançar ou Excluir.'
        : 'A captura automática é um recurso do Android.';

  return (
    <Screen title="Notificações do banco">
      <Text className="text-sm text-slate-600 px-1 mt-1">
        As notificações do SEU BANCO aparecem aqui automaticamente — as que já
        estão na barra do aparelho e as que chegarem depois. Você decide:{' '}
        <Text className="font-semibold">Lançar</Text> (preenche o Novo
        Lançamento) ou <Text className="font-semibold">Excluir</Text> (tira do
        grid). Nada é lançado sozinho.
      </Text>

      {/* v71 — AUTORIZAÇÃO/PERMISSÃO (pedida ao usuário, como manda o sistema) */}
      {permissao === 'pendente' ? (
        <Card className="!py-3 gap-2 border border-amber-200 bg-amber-50">
          <Text className="text-sm font-bold text-amber-900">
            Permita o acesso às notificações do aparelho
          </Text>
          <Text className="text-xs text-amber-800">
            Toque no botão, procure “MyFinance &amp; Pantry Manager” na lista
            “Acesso às notificações” do Android e ATIVE. É o Android quem pede a
            autorização — sem ela o app não lê nada.
          </Text>
          <Button label="Permitir acesso às notificações" onPress={permitirAcesso} />
        </Card>
      ) : null}
      {permissao === 'concedida' ? (
        <Text className="text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">
          ✓ Permissão concedida — capturando as notificações do seu banco
        </Text>
      ) : null}
      {permissao === 'sem-suporte' ? (
        <Card className="!py-3">
          <Text className="text-xs text-slate-600">
            A captura automática das notificações é um recurso do ANDROID (o iOS
            não deixa um app ler as notificações de outro). Neste aparelho a
            leitura automática não está disponível.
          </Text>
        </Card>
      ) : null}

      {/* v71 — GRID: notificações do banco capturadas da barra do sistema */}
      <View className="flex-row items-center justify-between mt-2">
        <Text className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Notificações capturadas ({grid.grid.length})
        </Text>
        {grid.jaNaLista > 0 ? (
          <Text className="text-[11px] text-slate-400">+{grid.jaNaLista} já na lista</Text>
        ) : null}
      </View>

      {grid.grid.length === 0 ? (
        <EmptyState icon={ICONS.mensagens} title="Nenhuma notificação capturada" hint={hintGridVazio} />
      ) : (
        grid.grid.map((item) => {
          const p = item.parsed;
          return (
            <Card key={item.id} className="!py-3 gap-1.5">
              <View className="flex-row justify-between items-start gap-2">
                <View className="flex-1">
                  <View className="flex-row items-center gap-1.5 flex-wrap">
                    {p ? (
                      <Text
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          p.kind === 'CREDIT' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                        }`}
                      >
                        {p.kind === 'CREDIT' ? 'ENTRADA · +' : 'SAÍDA · −'}
                      </Text>
                    ) : (
                      <Text className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                        sem valor
                      </Text>
                    )}
                    {p?.paymentMethod ? (
                      <Text className="text-[10px] font-semibold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                        {p.paymentMethod === 'CREDITO' ? 'CARTÃO CRÉDITO' : 'CARTÃO DÉBITO'}
                      </Text>
                    ) : null}
                    {p?.cardFinal ? (
                      <Text className="text-[10px] font-semibold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                        final {p.cardFinal}
                      </Text>
                    ) : null}
                    <Text className="text-[10px] text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">
                      {p?.date ? ymdToBr(p.date) : 'hoje'}
                    </Text>
                    {item.appName ? (
                      <Text className="text-[10px] text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">
                        {item.appName}
                      </Text>
                    ) : null}
                  </View>
                  <Text className="font-semibold text-slate-900 mt-1" numberOfLines={2}>
                    {p?.description ?? item.title ?? 'Notificação do banco'}
                  </Text>
                  <Text className="text-[11px] text-slate-500" numberOfLines={3}>
                    {item.body}
                  </Text>
                </View>
                <Text
                  className={`font-bold ${
                    !p ? 'text-slate-400' : p.kind === 'CREDIT' ? 'text-emerald-600' : 'text-rose-600'
                  }`}
                >
                  {p ? `${p.kind === 'CREDIT' ? '+' : '−'}${formatBRL(p.amountCents)}` : 'R$ ?'}
                </Text>
              </View>
              {/* v71 — 02 botões por notificação: Lançar / Excluir */}
              <View className="flex-row gap-2 justify-end">
                <Pressable
                  onPress={() => lancarCapturada(item)}
                  disabled={busyGridId === item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Lançar notificação${p ? ` de ${formatBRL(p.amountCents)}` : ''}`}
                  className={`rounded-lg px-3 py-2 ${
                    busyGridId === item.id ? 'bg-emerald-300' : 'bg-emerald-600'
                  }`}
                >
                  <Text className="text-xs font-bold text-white">Lançar</Text>
                </Pressable>
                <Pressable
                  onPress={() => excluirCapturada(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`Excluir notificação do grid${p ? ` de ${formatBRL(p.amountCents)}` : ''}`}
                  className="bg-rose-50 rounded-lg px-3 py-2"
                >
                  <Text className="text-xs font-semibold text-rose-600">Excluir</Text>
                </Pressable>
              </View>
            </Card>
          );
        })
      )}

      {/* v70 — LISTA DO BANCO: notificações já importadas, esperando salvar */}
      <View className="flex-row items-center justify-between mt-2">
        <Text className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Lista para lançar ({msgs.length})
        </Text>
      </View>

      {msgs.length === 0 ? (
        <EmptyState
          icon={ICONS.mensagens}
          title="Nenhuma notificação na lista"
          hint="Toque em Lançar no grid acima — a notificação entra aqui e abre o Novo Lançamento preenchido para você salvar."
        />
      ) : (
        msgs.map((m) => (
          <Card key={m.id} className="!py-3 gap-1.5">
            <View className="flex-row justify-between items-start gap-2">
              <View className="flex-1">
                <View className="flex-row items-center gap-1.5 flex-wrap">
                  <Text
                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      m.kind === 'CREDIT' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                    }`}
                  >
                    {m.kind === 'CREDIT' ? 'ENTRADA · +' : 'SAÍDA · −'}
                  </Text>
                  {m.payment_method ? (
                    <Text className="text-[10px] font-semibold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                      {m.payment_method === 'CREDITO' ? 'CARTÃO CRÉDITO' : 'CARTÃO DÉBITO'}
                    </Text>
                  ) : null}
                  {m.card_final ? (
                    <Text className="text-[10px] font-semibold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                      final {m.card_final}
                    </Text>
                  ) : null}
                  <Text className="text-[10px] text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">
                    {m.tx_date ? ymdToBr(m.tx_date) : 'sem data'}
                  </Text>
                  {m.sender ? (
                    <Text className="text-[10px] text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">{m.sender}</Text>
                  ) : null}
                </View>
                <Text className="font-semibold text-slate-900 mt-1" numberOfLines={2}>
                  {m.description ?? 'Notificação bancária'}
                </Text>
                <Text className="text-[11px] text-slate-500" numberOfLines={3}>
                  {m.body}
                </Text>
              </View>
              <Text className={`font-bold ${m.kind === 'CREDIT' ? 'text-emerald-600' : 'text-rose-600'}`}>
                {m.kind === 'CREDIT' ? '+' : '−'}
                {formatBRL(m.amount_cents)}
              </Text>
            </View>
            <View className="flex-row gap-2 justify-end">
              <Pressable
                onPress={() => router.push({ pathname: '/lancamento', params: { msg: m.id } })}
                accessibilityRole="button"
                accessibilityLabel={`Lançar notificação de ${formatBRL(m.amount_cents)}`}
                className="bg-emerald-600 rounded-lg px-3 py-2"
              >
                <Text className="text-xs font-bold text-white">Lançar</Text>
              </Pressable>
              <Pressable
                onPress={() => setDeleting(m)}
                accessibilityRole="button"
                accessibilityLabel={`Excluir notificação de ${formatBRL(m.amount_cents)}`}
                className="bg-rose-50 rounded-lg px-3 py-2"
              >
                <Text className="text-xs font-semibold text-rose-600">Excluir</Text>
              </Pressable>
            </View>
          </Card>
        ))
      )}

      {msgs.length > 0 ? (
        <Text className="text-[11px] text-slate-400 px-1">
          Depois que você lançar, a conciliação com o OFX é automática por data + valor — o extrato não duplica o lançamento.
        </Text>
      ) : null}

      <ConfirmDialog
        visible={deleting != null}
        title="Excluir notificação?"
        message={deleting ? 'A notificação sai da lista de lançamento (ela continua no histórico do banco).' : undefined}
        buttons={[
          { label: 'Excluir', color: 'red', onPress: removerDaLista },
          { label: 'Cancelar', color: 'green', onPress: () => setDeleting(null) },
        ]}
        onClose={() => setDeleting(null)}
      />
    </Screen>
  );
}
