/**
 * Tela LISTA DE DESEJOS (v69) — visão de como CONSEGUIR comprar cada item.
 *
 * CADASTRO: Prioridade* (classificação: Prioridade / Necessário / Desejo),
 * Descrição*, Valor* e Link (opcional). Tudo que tem * é obrigatório.
 *
 * LAYOUT (mesmo padrão do app — fechinha para expandir):
 *   > Lista de Desejos (metodologia do mês no topo)
 *     > Prioridade — Total R$ 3.000,00 — 2 itens
 *         Item — R$ 2.000,00
 *             [barra de progressão]
 *             [Reservar] [Alterar] [Excluir]
 *     > Necessário — Total — itens
 *     > Desejo — Total — itens
 *
 * METODOLOGIA (hierarquia — 5.2): Orçamento + Poupança Mensal entram primeiro
 * (obrigatórios); a sobra do mês concorre para a Lista de Desejos na ordem
 * Prioridade > Necessário > Desejo (o que não cabe passa para o mês seguinte);
 * o que sobrar depois é da Poupança "Fechamento do Mês". A tela mostra:
 * "Para comprar tudo de Prioridade, você demora X meses. Para comprar tudo, Y meses."
 *
 * BARRA DE PROGRESSÃO: reservado/valor; 100% = "Pronto para comprar"; ao
 * COMPRAR, o item sai da lista e vira lançamento normal.
 *
 * RESERVAR: transferência real para a caixinha "Reserva · Lista de Desejos"
 * (conta que NUNCA entra no saldo geral) ou para a conta POUPANÇA (fatia
 * separada "Reserva Lista de Desejos" na fechinha da conta na tela inicial).
 */

import React from 'react';
import { View, Text, Pressable, Linking, Modal } from 'react-native';
import {
  Screen, Card, Button, EmptyState, Select, TextField, ProgressBar,
} from '../src/components/ui';
import { MoneyInput } from '../src/components/MoneyInput';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { showToast } from '../lib/toast';
import { formatBRL } from '../src/lib/money';
import { monthOf, monthLabel, todaySP } from '../src/lib/dates';
import { ICONS } from '../src/theme/icons';
import type {
  WishlistClass, WishlistClassView, WishlistItemView, WishlistMethodology,
} from '../src/services/WishlistService';
import { RESERVA_ACCOUNT_NAME } from '../src/services/WishlistService';

const CLASSES: Array<{ id: WishlistClass; label: string }> = [
  { id: 'PRIORIDADE', label: 'Prioridade' },
  { id: 'NECESSARIO', label: 'Necessário' },
  { id: 'DESEJO', label: 'Desejo' },
];

export default function ListaDesejosScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const month = monthOf(todaySP());

  const [classes, setClasses] = React.useState<WishlistClassView[]>([]);
  const [method, setMethod] = React.useState<WishlistMethodology | null>(null);
  const [openCls, setOpenCls] = React.useState<Record<string, boolean>>({ PRIORIDADE: true });
  const [accounts, setAccounts] = React.useState<Array<{ id: string; label: string; include: number; type: string }>>([]);
  const [boxId, setBoxId] = React.useState<string | null>(null);

  // cadastro / alteração
  const [formOpen, setFormOpen] = React.useState(false);
  const [editId, setEditId] = React.useState<string | null>(null);
  const [formCls, setFormCls] = React.useState<WishlistClass>('PRIORIDADE');
  const [formDesc, setFormDesc] = React.useState('');
  const [formCents, setFormCents] = React.useState(0);
  const [formLink, setFormLink] = React.useState('');
  // reserva
  const [reserving, setReserving] = React.useState<WishlistItemView | null>(null);
  const [reserveCents, setReserveCents] = React.useState(0);
  const [destino, setDestino] = React.useState<string | null>(null); // 'BOX' | id de conta
  const [origem, setOrigem] = React.useState<string | null>(null);
  // excluir / comprar
  const [deleting, setDeleting] = React.useState<WishlistItemView | null>(null);
  const [buying, setBuying] = React.useState<WishlistItemView | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setClasses(await services.wishlist.listOpen());
    try {
      setMethod(await services.wishlist.getMethodology(month));
    } catch {
      setMethod(null);
    }
    const accs = await services.db.getAllAsync<{ id: string; name: string; type: string; include: number }>(
      `SELECT id, name, type, include_in_general_balance AS include
         FROM accounts WHERE archived_at IS NULL ORDER BY include_in_general_balance DESC, name`
    );
    setAccounts(accs.map((a) => ({ id: a.id, label: a.name, include: a.include, type: a.type })));
    const box = await services.db.getFirstAsync<{ id: string }>(
      'SELECT id FROM accounts WHERE name = ? AND archived_at IS NULL LIMIT 1',
      [RESERVA_ACCOUNT_NAME]
    );
    setBoxId(box?.id ?? null);
    if (!origem && accs.length > 0) setOrigem(accs.find((a) => a.include === 1)?.id ?? accs[0].id);
  }, [services, month, origem]);

  useDataEffect(load);

  const resetForm = () => {
    setFormOpen(false);
    setEditId(null);
    setFormCls('PRIORIDADE');
    setFormDesc('');
    setFormCents(0);
    setFormLink('');
  };

  const novoItem = () => {
    setEditId(null);
    setFormCls('PRIORIDADE');
    setFormDesc('');
    setFormCents(0);
    setFormLink('');
    setFormOpen(true);
  };

  const alterar = (it: WishlistItemView) => {
    setEditId(it.id);
    setFormCls(it.classificacao);
    setFormDesc(it.description);
    setFormCents(it.target_cents);
    setFormLink(it.link ?? '');
    setFormOpen(true);
  };

  const salvarForm = async () => {
    setBusy(true);
    try {
      if (editId) {
        await services.wishlist.updateItem(editId, {
          classificacao: formCls,
          description: formDesc,
          targetCents: formCents,
          link: formLink,
        });
        showToast('Item alterado');
      } else {
        await services.wishlist.addItem({ classificacao: formCls, description: formDesc, targetCents: formCents, link: formLink });
        showToast('Item cadastrado na Lista de Desejos');
      }
      resetForm();
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const abrirReserva = (it: WishlistItemView) => {
    setReserving(it);
    setReserveCents(it.faltaCents);
    setDestino(boxId ?? 'BOX');
  };

  const confirmarReserva = async () => {
    if (!reserving || !origem) {
      showToast('Escolha a conta de origem', 'err');
      return;
    }
    setBusy(true);
    try {
      const destination =
        destino === 'BOX' || destino == null
          ? ({ kind: 'BOX' } as const)
          : ({ kind: 'POUPANCA', accountId: destino } as const);
      await services.wishlist.reserve({
        itemId: reserving.id,
        amountCents: reserveCents,
        fromAccountId: origem,
        destination,
      });
      showToast(`Reserva de ${formatBRL(reserveCents)} feita — o dinheiro saiu do Saldo para a caixinha`);
      setReserving(null);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const excluir = async () => {
    if (!deleting) return;
    try {
      await services.wishlist.removeItem(deleting.id);
      showToast('Item excluído da Lista de Desejos');
      setDeleting(null);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  const comprar = async () => {
    if (!buying) return;
    setBusy(true);
    try {
      await services.wishlist.buy({ itemId: buying.id });
      showToast('Compra lançada — o item saiu da Lista e virou lançamento normal');
      setBuying(null);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const renderItem = (it: WishlistItemView) => (
    <Card key={it.id} className="!py-3 gap-1.5 ml-3">
      <View className="flex-row justify-between items-start gap-2">
        <View className="flex-1">
          <View className="flex-row items-center gap-1.5 flex-wrap">
            <Text className="font-semibold text-slate-900 flex-shrink" numberOfLines={2}>{it.description}</Text>
            {it.link ? (
              <Pressable
                onPress={() => Linking.openURL(it.link!).catch(() => showToast('Não foi possível abrir o link', 'err'))}
                accessibilityRole="link"
                accessibilityLabel="Abrir link do item"
                className="bg-sky-50 rounded px-1.5 py-0.5"
              >
                <Text className="text-[10px] font-semibold text-sky-700">🔗 link</Text>
              </Pressable>
            ) : null}
            {it.pronto ? (
              <Text className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                ✓ Pronto para comprar
              </Text>
            ) : null}
          </View>
          {/* v69 (5.4): barra de progressão — valor do item, quanto já reservou
              e quanto falta reservar */}
          <Text className="text-[11px] text-slate-500 mt-1">
            Valor {formatBRL(it.target_cents)} · reservado {formatBRL(it.reserved_cents)} · falta {formatBRL(it.faltaCents)}
          </Text>
          <ProgressBar pct={it.pct} className="mt-1" />
        </View>
        <Text className={`font-bold ${it.pronto ? 'text-emerald-700' : 'text-slate-900'}`}>{formatBRL(it.target_cents)}</Text>
      </View>
      <View className="flex-row gap-2 justify-end">
        {!it.pronto ? (
          <Pressable
            onPress={() => abrirReserva(it)}
            accessibilityRole="button"
            accessibilityLabel={`Reservar dinheiro para ${it.description}`}
            className="bg-emerald-600 rounded-lg px-3 py-2"
          >
            <Text className="text-xs font-bold text-white">Reservar</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => setBuying(it)}
            accessibilityRole="button"
            accessibilityLabel={`Comprar ${it.description} (virar lançamento)`}
            className="bg-violet-600 rounded-lg px-3 py-2"
          >
            <Text className="text-xs font-bold text-white">Comprar</Text>
          </Pressable>
        )}
        <Pressable
          onPress={() => alterar(it)}
          accessibilityRole="button"
          accessibilityLabel={`Alterar ${it.description}`}
          className="bg-slate-100 rounded-lg px-3 py-2"
        >
          <Text className="text-xs font-semibold text-slate-600">Alterar</Text>
        </Pressable>
        <Pressable
          onPress={() => setDeleting(it)}
          accessibilityRole="button"
          accessibilityLabel={`Excluir ${it.description}`}
          className="bg-rose-50 rounded-lg px-3 py-2"
        >
          <Text className="text-xs font-semibold text-rose-600">Excluir</Text>
        </Pressable>
      </View>
    </Card>
  );

  const renderClassGroup = (c: WishlistClassView) => {
    const open = !!openCls[c.cls];
    return (
      <View key={c.cls} className="gap-1.5">
        <Pressable
          onPress={() => setOpenCls((cur) => ({ ...cur, [c.cls]: !open }))}
          accessibilityRole="button"
          accessibilityLabel={`${open ? 'Recolher' : 'Expandir'} ${c.label}`}
          className="flex-row items-center gap-2 bg-white border border-slate-200 rounded-2xl px-3 py-3"
        >
          <Text className="text-sm font-bold text-violet-700 w-4">{open ? ICONS.recolher : ICONS.expandir}</Text>
          <View className="flex-1">
            <Text className="font-semibold text-slate-900">{c.label}</Text>
            <Text className="text-xs text-slate-500">Total {formatBRL(c.totalCents)} — {c.itemCount} item(ns)</Text>
          </View>
          {method ? (
            (() => {
              const mc = method.classes.find((m) => m.cls === c.cls);
              if (!mc || mc.itemCount === 0) return null;
              return (
                <Text className="text-[10px] font-semibold text-violet-700 bg-violet-50 px-1.5 py-0.5 rounded">
                  {mc.startMonth > 0 ? `começa no ${mc.startMonth}º mês` : 'sem sobra'}
                </Text>
              );
            })()
          ) : null}
        </Pressable>
        {open ? (
          c.items.length === 0 ? (
            <Text className="text-xs text-slate-400 ml-4">Nenhum item nesta classificação.</Text>
          ) : (
            c.items.map(renderItem)
          )
        ) : null}
      </View>
    );
  };

  const poupacas = accounts.filter((a) => a.type === 'SAVINGS');

  return (
    <Screen title="Lista de Desejos" subtitle={monthLabel(month)}>
      {/* Metodologia (5.2) — hierarquia e meses para comprar */}
      <Card className="gap-1.5 border-violet-200">
        <Text className="font-semibold text-slate-900">{ICONS.listaDesejos} Como conseguir comprar</Text>
        {method ? (
          <>
            <Text className="text-sm text-slate-700">
              {method.messagePrioridade ?? 'Cadastre itens de Prioridade para começar.'}{' '}
              {method.messageTotal ?? ''}
            </Text>
            <Text className="text-[11px] text-slate-500">
              Sobra do mês {formatBRL(method.sobraCents)} · Orçamento (obrigação, entra primeiro) {method.budgetedCents != null ? formatBRL(method.budgetedCents) : 'desligado'} · Poupança mensal (conta obrigatória) {method.poupancaMensalCents != null ? formatBRL(method.poupancaMensalCents) : 'desligada'} · depois vem a Lista de Desejos (Prioridade › Necessário › Desejo) e por último a Poupança Fechamento do Mês.
            </Text>
            {method.classes.filter((c) => c.itemCount > 0).map((c) => (
              <Text key={c.cls} className="text-[11px] text-slate-600">
                • {c.label}: {formatBRL(c.totalCents)} ({c.itemCount} item(ns)){c.startMonth > 0 ? ` — do ${c.startMonth}º ao ${c.endMonth}º mês` : ' — sem sobra, não começa'}
              </Text>
            ))}
          </>
        ) : (
          <Text className="text-sm text-slate-500">Calculando a sobra do mês…</Text>
        )}
        <Button label="＋ Novo item" onPress={novoItem} />
      </Card>

      {classes.every((c) => c.itemCount === 0) ? (
        <EmptyState
          icon={ICONS.listaDesejos}
          title="Nenhum item na Lista de Desejos"
          hint="Cadastre o primeiro item: Prioridade, Descrição e Valor (link é opcional)."
        />
      ) : (
        classes.map(renderClassGroup)
      )}

      {boxId ? (
        <Text className="text-[11px] text-slate-400 px-1">
          {ICONS.reserva} As reservas saem do Saldo para a caixinha "{RESERVA_ACCOUNT_NAME}" (fora do saldo geral) — ou para a conta Poupança, em fatia separada na fechinha da tela inicial.
        </Text>
      ) : null}

      {/* Cadastro / alteração (modal — a MESMA tela serve pela Ações rápidas) */}
      <Modal visible={formOpen} transparent animationType="fade" onRequestClose={resetForm}>
        <Pressable className="flex-1 bg-black/40 justify-end" onPress={resetForm}>
          <Pressable className="bg-white rounded-t-3xl max-h-[85%] p-4 gap-2" onPress={() => {}}>
            <Text className="text-lg font-bold text-slate-900">
              {editId ? 'Alterar item' : 'Novo item da Lista de Desejos'}
            </Text>
            <View className="gap-1">
              <Text className="text-sm font-medium text-slate-500">Prioridade *</Text>
              <View className="flex-row gap-1.5 flex-wrap">
                {CLASSES.map((c) => {
                  const active = formCls === c.id;
                  return (
                    <Pressable
                      key={c.id}
                      onPress={() => setFormCls(c.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Classificação ${c.label}`}
                      className={`px-3 py-2 rounded-lg border ${active ? 'bg-violet-600 border-transparent' : 'bg-violet-50 border border-violet-200'}`}
                    >
                      <Text className={`text-xs font-bold ${active ? 'text-white' : 'text-violet-700'}`}>{c.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <TextField label="Descrição *" value={formDesc} onChangeText={setFormDesc} placeholder="Ex.: Notebook novo" />
            <MoneyInput label="Valor *" cents={formCents} onChangeCents={setFormCents} />
            <TextField
              label="Link (opcional)"
              value={formLink}
              onChangeText={setFormLink}
              placeholder="https://…"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Button
              label={editId ? 'Salvar alterações' : 'Cadastrar item'}
              onPress={salvarForm}
              loading={busy}
              disabled={!formDesc.trim() || formCents <= 0}
            />
            <Button label="Cancelar" variant="ghost" onPress={resetForm} />
          </Pressable>
        </Pressable>
      </Modal>

      {/* Reserva — destino BOX (fora do saldo) ou POUPANÇA (fatia separada) */}
      <Modal visible={reserving != null} transparent animationType="fade" onRequestClose={() => setReserving(null)}>
        <Pressable className="flex-1 bg-black/40 justify-end" onPress={() => setReserving(null)}>
          <Pressable className="bg-white rounded-t-3xl max-h-[85%] p-4 gap-2" onPress={() => {}}>
            <Text className="text-lg font-bold text-slate-900">Reservar</Text>
            {reserving ? (
              <Text className="text-sm text-slate-600">
                {reserving.description} — valor {formatBRL(reserving.target_cents)} · reservado {formatBRL(reserving.reserved_cents)} · falta {formatBRL(reserving.faltaCents)}
              </Text>
            ) : null}
            <MoneyInput label="Quanto reservar" cents={reserveCents} onChangeCents={setReserveCents} />
            <Select
              label="Destino do dinheiro"
              items={[
                { id: 'BOX', label: `${ICONS.reserva} Reserva · Lista de Desejos (fora do Saldo)` },
                ...poupacas.map((a) => ({ id: a.id, label: `${ICONS.poupanca} Poupança: ${a.label} (fatia separada)` })),
              ]}
              selectedId={destino}
              onSelect={setDestino}
              emptyLabel="Escolha o destino"
            />
            <Select
              label="Conta de origem (o dinheiro sai daqui)"
              items={accounts.filter((a) => a.include === 1).map((a) => ({ id: a.id, label: a.label }))}
              selectedId={origem}
              onSelect={setOrigem}
              emptyLabel="Escolha a origem"
            />
            <Text className="text-[11px] text-slate-500">
              A reserva é uma transferência real: o valor SAI do Saldo (o Fluxo para de contar esse dinheiro como disponível) e fica guardado na caixinha ou na fatia "Reserva Lista de Desejos" da Poupança.
            </Text>
            <Button label="Reservar" onPress={confirmarReserva} loading={busy} />
            <Button label="Cancelar" variant="ghost" onPress={() => setReserving(null)} />
          </Pressable>
        </Pressable>
      </Modal>

      <ConfirmDialog
        visible={deleting != null}
        title="Excluir item da Lista de Desejos?"
        message={deleting ? `"${deleting.description}" sai da lista. Reservas já feitas permanecem no Fluxo como transferências (dinheiro real que saiu).` : undefined}
        buttons={[
          { label: 'Excluir', color: 'red', onPress: excluir },
          { label: 'Cancelar', color: 'green', onPress: () => setDeleting(null) },
        ]}
        onClose={() => setDeleting(null)}
      />
      <ConfirmDialog
        visible={buying != null}
        title="Comprar e virar lançamento?"
        message={buying ? `"${buying.description}" de ${formatBRL(buying.target_cents)} sai da Lista e vira um lançamento normal (despesa pela caixinha de reserva).` : undefined}
        buttons={[
          { label: 'Comprar', color: 'red', onPress: comprar },
          { label: 'Cancelar', color: 'green', onPress: () => setBuying(null) },
        ]}
        onClose={() => setBuying(null)}
      />
    </Screen>
  );
}
