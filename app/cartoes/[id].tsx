/** Detalhe do cartão (v8) — faturas (mês de referência) + EDITAR com LIMITE.
 *  Regras de ciclo de vida (v8):
 *   - Alterar (incl. Limite): sempre permitido.
 *   - Excluir: APENAS se o cartão não tem movimentações (compras/parcelas/pagamentos);
 *     caso contrário exclusão BLOQUEADA — resta ARQUIVAR.
 *   - Arquivar: sai das escolhas de lançamento e da listagem ativa; histórico preservado. */

import React from 'react';
import { View, Text, Pressable,  } from 'react-native';
import { showToast } from '../../lib/toast';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen, Card, EmptyState, Badge, Button, SectionTitle, TextField, Select } from '../../src/components/ui';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { MoneyInput } from '../../src/components/MoneyInput';
import { useDataEffect } from '../../src/components/useDataEffect';
import { useAppStore } from '../../src/store/appStore';
import { formatBRL } from '../../src/lib/money';
import { monthLabel, nowIso } from '../../src/lib/dates';
import { ICONS } from '../../src/theme/icons';

interface CardRow {
  id: string;
  name: string;
  last_four_digits: string | null;
  closing_day: number;
  due_day: number;
  linked_account_id: string | null;
  limit_cents: number | null;
  archived: boolean;
}

/** v67 (BUG 6): próxima fatura em aberto do cartão (saldo do topo). */
interface NextOpenInvoice {
  dueCents: number;
  liveStatus: string;
  referenceMonth: string;
}

export default function CartaoDetalheScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [card, setCard] = React.useState<CardRow | null>(null);
  const [invoices, setInvoices] = React.useState<Array<{ invoice: { id: string; reference_month: string; total_cents: number }; dueCents: number; liveStatus: string }>>([]);
  /** v67 (BUG 6): saldo do topo = próxima fatura em aberto (null → R$ 0,00). */
  const [nextOpen, setNextOpen] = React.useState<NextOpenInvoice | null>(null);
  const [accounts, setAccounts] = React.useState<Array<{ id: string; label: string }>>([]);

  // Edição (v8)
  const [editOpen, setEditOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [last4, setLast4] = React.useState('');
  const [closingDay, setClosingDay] = React.useState('15');
  const [dueDay, setDueDay] = React.useState('10');
  const [linkedId, setLinkedId] = React.useState<string | null>(null);
  const [limitCents, setLimitCents] = React.useState(0);
  const [hasLimit, setHasLimit] = React.useState(false);
  const [saving, setSaving] = React.useState(false);


  const load = React.useCallback(async (svc: typeof services) => {
    const row = await svc.db.getFirstAsync<{
      id: string; name: string; last_four_digits: string | null; closing_day: number;
      due_day: number; linked_account_id: string | null; limit_cents: number | null; archived_at: string | null;
    }>('SELECT id, name, last_four_digits, closing_day, due_day, linked_account_id, limit_cents, archived_at FROM cards WHERE id = ?', [id]);
    setCard(row ? {
      id: row.id,
      name: row.name,
      last_four_digits: row.last_four_digits,
      closing_day: row.closing_day,
      due_day: row.due_day,
      linked_account_id: row.linked_account_id,
      limit_cents: row.limit_cents,
      archived: !!row.archived_at,
    } : null);
    const list = await svc.invoices.listInvoicesByCard(id);
    setInvoices(list.map((i) => ({
      invoice: { id: i.invoice.id, reference_month: i.invoice.reference_month, total_cents: i.invoice.total_cents },
      dueCents: i.dueCents,
      liveStatus: i.liveStatus,
    })));
    // v67 (BUG 6): topo = a PRÓXIMA fatura em aberto (mais antiga não quitada)
    const next = await svc.invoices.getNextOpenInvoice(id);
    setNextOpen(next ? { dueCents: next.dueCents, liveStatus: next.liveStatus, referenceMonth: next.invoice.reference_month } : null);
    const accs = await svc.db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM accounts WHERE archived_at IS NULL ORDER BY name');
    setAccounts(accs.map((a) => ({ id: a.id, label: a.name })));
  }, [services, id]);

  useDataEffect(async (svc) => {
    await load(svc);
  });

  const openEdit = () => {
    if (!card) return;
    setName(card.name);
    setLast4(card.last_four_digits ?? '');
    setClosingDay(String(card.closing_day));
    setDueDay(String(card.due_day));
    setLinkedId(card.linked_account_id);
    setLimitCents(card.limit_cents ?? 0);
    setHasLimit(card.limit_cents != null);
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!card) return;
    setSaving(true);
    try {
      const closing = parseInt(closingDay, 10);
      const due = parseInt(dueDay, 10);
      if (!name.trim()) throw new Error('Informe o nome do cartão');
      if (!Number.isInteger(closing) || closing < 1 || closing > 31) throw new Error('Dia de fechamento entre 1 e 31');
      if (!Number.isInteger(due) || due < 1 || due > 31) throw new Error('Dia de vencimento entre 1 e 31');
      await services.db.runAsync(
        'UPDATE cards SET name = ?, last_four_digits = ?, closing_day = ?, due_day = ?, linked_account_id = ?, limit_cents = ? WHERE id = ?',
        [name.trim(), last4.trim() || null, closing, due, linkedId, hasLimit ? limitCents : null, card.id]
      );
      setEditOpen(false);
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setSaving(false);
    }
  };

  const doArchive = async () => {
    if (!card) return;
    await services.db.runAsync(
      'UPDATE cards SET archived_at = ? WHERE id = ?',
      [card.archived ? null : nowIso(), card.id]
    );
    bump();
  };

  /** v21 (bug 4): exclusão do cartão com CONFIRMAÇÃO (modal). */
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false);
  const doDelete = async () => {
    if (!card) return;
    try {
      await services.db.runAsync('DELETE FROM cards WHERE id = ?', [card.id]);
      setDeleteConfirmOpen(false);
      bump();
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  const [movements, setMovements] = React.useState(true);
  useDataEffect(async (svc) => {
    const tx = await svc.db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM transactions WHERE card_id = ? AND status != 'VOIDED'",
      [id]
    );
    const pay = await svc.db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id
        WHERE i.card_id = ? AND ip.status = 'CONFIRMED'`,
      [id]
    );
    setMovements((tx?.n ?? 0) > 0 || (pay?.n ?? 0) > 0);
  }, [id]);

  const ensureCurrent = async () => {
    // Garante fatura do mês corrente (útil para pagamento avulso/crédito)
    const ym = new Date().toISOString().slice(0, 7);
    const inv = await services.invoices.ensureInvoice(id, ym);
    await services.invoices.rebuildTotals(inv.id);
    router.push(`/cartoes/${id}/fatura/${ym}`);
  };


  return (
    <Screen
      title={card?.name ?? 'Cartão'}
      subtitle={card ? `Fecha dia ${card.closing_day} · vence dia ${card.due_day}${card.limit_cents != null ? ` · limite ${formatBRL(card.limit_cents)}` : ''}` : undefined}
      action={
        card && !card.archived ? (
          <Pressable onPress={() => router.push({ pathname: '/lancamento', params: { card: id } })} className="bg-emerald-600 rounded-lg px-3 py-1.5">
            <Text className="text-white font-semibold text-sm">+ Compra</Text>
          </Pressable>
        ) : null
      }
    >
      {!card ? <Card><Text className="text-slate-500">Carregando...</Text></Card> : null}

      {/* v67 (BUG 6): SALDO DO TOPO = próxima fatura em aberto do próprio cartão;
          sem fatura em aberto = R$ 0,00 · "Sem fatura em aberto" (não some). */}
      {card ? (
        <Card className="!py-3">
          <Pressable onPress={() => nextOpen && router.push(`/cartoes/${id}/fatura/${nextOpen.referenceMonth}`)}>
            <View className="flex-row justify-between items-center gap-2">
              <View className="flex-1">
                <Text className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Próxima fatura em aberto</Text>
                <Text className="text-xs text-slate-500 mt-0.5">
                  {nextOpen ? `${monthLabel(nextOpen.referenceMonth)} · toque para abrir` : 'Nenhuma fatura em aberto neste cartão'}
                </Text>
              </View>
              <View className="items-end gap-1">
                <Text className={`font-bold text-lg ${nextOpen && nextOpen.dueCents > 0 ? 'text-slate-900' : 'text-slate-400'}`}>
                  {formatBRL(nextOpen?.dueCents ?? 0)}
                </Text>
                {nextOpen ? <Badge status={nextOpen.liveStatus} /> : (
                  <Text className="text-[10px] font-semibold text-slate-400">Sem fatura em aberto</Text>
                )}
              </View>
            </View>
          </Pressable>
        </Card>
      ) : null}

      {card ? (
        <>
          {card.archived ? (
            <Card className="bg-slate-50">
              <Text className="text-sm text-slate-500 font-semibold">
                {ICONS.arquivar} Cartão arquivado — fora das escolhas de lançamento. Desarquive para usar.
              </Text>
            </Card>
          ) : null}

          {/* Ações de ciclo de vida (v8): Alterar · Arquivar · Excluir (só sem histórico) */}
          <Card className="gap-2">
            <View className="flex-row gap-2">
              <Pressable onPress={openEdit} className="flex-1 bg-emerald-50 rounded-xl px-3 py-2.5 items-center">
                <Text className="text-emerald-700 font-semibold text-sm">{ICONS.editar} Alterar</Text>
              </Pressable>
              <Pressable onPress={doArchive} className="flex-1 bg-slate-100 rounded-xl px-3 py-2.5 items-center">
                <Text className="text-slate-600 font-semibold text-sm">
                  {ICONS.arquivar} {card.archived ? 'Desarquivar' : 'Arquivar'}
                </Text>
              </Pressable>
            </View>
            {!movements ? (
              <Pressable onPress={() => setDeleteConfirmOpen(true)} className="bg-rose-50 rounded-xl px-3 py-2.5 items-center">
                <Text className="text-rose-600 font-semibold text-sm">{ICONS.excluir} Excluir cartão</Text>
              </Pressable>
            ) : (
              <Text className="text-[11px] text-slate-400 leading-4">
                Este cartão possui movimentações (compras/pagamentos) — exclusão bloqueada; use ARQUIVAR.
              </Text>
            )}
          </Card>

          {/* Formulário de edição com LIMITE (v8) */}
          {editOpen ? (
            <Card className="gap-3">
              <Text className="font-semibold text-slate-900">Alterar cartão</Text>
              <TextField label="Nome" value={name} onChangeText={setName} placeholder="Ex.: Nubank" />
              <TextField label="Últimos 4 dígitos (opcional)" value={last4} onChangeText={setLast4} placeholder="1234" keyboardType="numeric" />
              <View className="flex-row gap-2">
                <View className="flex-1">
                  <TextField label="Dia do fechamento" value={closingDay} onChangeText={setClosingDay} keyboardType="numeric" />
                </View>
                <View className="flex-1">
                  <TextField label="Dia do vencimento" value={dueDay} onChangeText={setDueDay} keyboardType="numeric" />
                </View>
              </View>
              <Select label="Conta de pagamento (opcional)" items={accounts} selectedId={linkedId} onSelect={setLinkedId} allowEmpty />
              <MoneyInput label={`${ICONS.limite} Limite do cartão`} cents={limitCents} onChangeCents={setLimitCents} />
              <View className="flex-row gap-2">
                <View className="flex-1">
                  <Button label="Cancelar" variant="outline" onPress={() => setEditOpen(false)} />
                </View>
                <View className="flex-1">
                  <Button label="Salvar" onPress={saveEdit} loading={saving} />
                </View>
              </View>
            </Card>
          ) : null}
        </>
      ) : null}

      <SectionTitle>Faturas</SectionTitle>
      {invoices.length === 0 ? (
        <EmptyState icon={ICONS.fatura} title="Sem faturas" hint="Compras e parcelas criam faturas automaticamente." />
      ) : (
        invoices.map((inv) => (
          <Pressable key={inv.invoice.id} onPress={() => router.push(`/cartoes/${id}/fatura/${inv.invoice.reference_month}`)}>
            <Card className="!py-3 mb-1">
              <View className="flex-row justify-between items-center">
                <View>
                  <Text className="font-semibold text-slate-900">{monthLabel(inv.invoice.reference_month)}</Text>
                  <Text className="text-xs text-slate-500">Total {formatBRL(inv.invoice.total_cents)}</Text>
                </View>
                <View className="items-end gap-1">
                  <Text className={`font-bold ${inv.dueCents > 0 ? 'text-slate-900' : 'text-emerald-600'}`}>
                    {inv.dueCents > 0 ? `Devido ${formatBRL(inv.dueCents)}` : 'Quitada'}
                  </Text>
                  <Badge status={inv.liveStatus} />
                </View>
              </View>
            </Card>
          </Pressable>
        ))
      )}

      <View className="mt-2">
        <Button label="Abrir fatura do mês atual" variant="outline" onPress={ensureCurrent} />
      </View>

      {/* v21 (bug 4): confirmação da exclusão do cartão */}
      <ConfirmDialog
        visible={deleteConfirmOpen}
        title="Excluir cartão?"
        message={card ? `"${card.name}" sai definitivamente do app (só é possível sem movimentações).` : undefined}
        buttons={[
          { label: 'Excluir cartão', color: 'red', onPress: doDelete },
          { label: 'Cancelar', color: 'green', onPress: () => setDeleteConfirmOpen(false) },
        ]}
        onClose={() => setDeleteConfirmOpen(false)}
      />

    </Screen>
  );
}
