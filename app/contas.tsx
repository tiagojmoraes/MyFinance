/** Tela Contas (v8→v70) — lista de contas com saldo inicial (MoneyInput pt-BR).
 *  Regras de ciclo de vida (regra geral v8):
 *   - Alterar: sempre permitido — v70: abre a TELA PRÓPRIA /conta-nova?edit=ID
 *     (o formulário que ficava inline abaixo da lista saiu daqui).
 *   - Excluir: APENAS se a conta não tem movimentações E saldo zerado;
 *     caso contrário a exclusão é BLOQUEADA e resta a opção ARQUIVAR.
 *   - Arquivar: a conta sai das escolhas (Lançamento, Fluxo, filtros) e do
 *     saldo geral; o histórico é preservado. Pode ser desarquivada.
 *   - Toggle "Aparece no saldo do Fluxo" (coluna include_in_general_balance).
 *  v70 (MELHORIA 2.3): o botão "＋" do cabeçalho abre a TELA DE CADASTRAMENTO
 *  /conta-nova (antes abria o formulário embaixo da lista — fora do padrão).
 *  v20 (bug do saldo do dia): o saldo inicial ganha DATA ÂNCORA — o valor
 *  informado vale NO INÍCIO do dia escolhido (tela /conta-nova). */

import React from 'react';
import { View, Text,  Pressable } from 'react-native';
import { router } from 'expo-router';
import { showToast } from '../lib/toast';
import { Screen, Card, EmptyState, ToggleRow } from '../src/components/ui';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { formatBRL } from '../src/lib/money';
import { nowIso, todaySP, ymdToBr } from '../src/lib/dates';
import { ICONS } from '../src/theme/icons';

interface AccountItem {
  id: string;
  name: string;
  type: string;
  initial: number;
  initialDate: string | null;
  include: boolean;
  archived: boolean;
  balance: number;
  moves: number;
}

const TYPE_LABELS: Record<string, string> = {
  CHECKING: 'Corrente',
  SAVINGS: 'Poupança',
  CASH: 'Dinheiro',
};

export default function ContasScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [accounts, setAccounts] = React.useState<AccountItem[]>([]);

  const load = React.useCallback(async (svc: typeof services) => {
    const rows = await svc.db.getAllAsync<{
      id: string; name: string; type: string; initial_balance_cents: number;
      initial_balance_date: string | null;
      include_in_general_balance: number; archived_at: string | null;
      movement_cents: number;
      moves: number;
    }>(`SELECT a.id, a.name, a.type, a.initial_balance_cents, a.initial_balance_date,
               a.include_in_general_balance, a.archived_at,
               COUNT(fm.id) AS moves,
               COALESCE(SUM(CASE
                 WHEN fm.effective_date <= date('now', '+1 day')
                   AND fm.effective_date >= COALESCE(a.initial_balance_date, '0000-01-01')
                 THEN CASE WHEN fm.direction = 'CREDIT' THEN fm.amount_cents ELSE -fm.amount_cents END
                 ELSE 0
               END), 0) AS movement_cents
          FROM accounts a
          LEFT JOIN financial_moves fm ON fm.account_id = a.id AND fm.status = 'CONFIRMED'
         GROUP BY a.id
         ORDER BY a.archived_at IS NOT NULL, a.name`);
    const today = todaySP();
    const items: AccountItem[] = rows.map((r) => {
      // O saldo inicial vale no início da data âncora; antes dela, o saldo é zero.
      const anchored = !r.initial_balance_date || today >= r.initial_balance_date;
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        initial: r.initial_balance_cents,
        initialDate: r.initial_balance_date,
        include: r.include_in_general_balance === 1,
        archived: !!r.archived_at,
        balance: anchored ? r.initial_balance_cents + r.movement_cents : 0,
        moves: r.moves,
      };
    });
    setAccounts(items);
  }, [services]);

  useDataEffect(async (svc) => {
    await load(svc);
  });

  /** Exclusão liberada só sem histórico e sem saldo (regra v8). */
  const canDelete = (a: AccountItem) => a.moves === 0 && a.initial === 0 && a.balance === 0;

  const openEdit = (a: AccountItem) => {
    // v70 (MELHORIA 2.3): edição na TELA PRÓPRIA (mesma tela do cadastro)
    router.push({ pathname: '/conta-nova', params: { edit: a.id } });
  };

  const toggleInclude = async (a: AccountItem, value: boolean) => {
    await services.db.runAsync(
      'UPDATE accounts SET include_in_general_balance = ? WHERE id = ?',
      [value ? 1 : 0, a.id]
    );
    bump();
  };

  /** v21 (bug 4): exclusão de conta com CONFIRMAÇÃO (modal) — o botão só
   *  existe para conta sem movimentações nem saldo; o banco reabre se precisar. */
  const [deleteConfirm, setDeleteConfirm] = React.useState<AccountItem | null>(null);
  const doDelete = async (acc: AccountItem) => {
    try {
      await services.db.runAsync('DELETE FROM accounts WHERE id = ?', [acc.id]);
      setDeleteConfirm(null);
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v19: arquivar/desarquivar direto (sem diálogo). */
  const doArchive = async (acc: AccountItem) => {
    await services.db.runAsync(
      'UPDATE accounts SET archived_at = ? WHERE id = ?',
      [acc.archived ? null : nowIso(), acc.id]
    );
    bump();
  };

  const active = accounts.filter((a) => !a.archived);
  const archived = accounts.filter((a) => a.archived);

  return (
    <Screen
      title="Contas"
      action={
        // v70 (MELHORIA 2.3): o "＋" abre a TELA DE CADASTRAMENTO (padrão do app)
        <Pressable
          onPress={() => router.push('/conta-nova')}
          accessibilityRole="button"
          accessibilityLabel="Adicionar nova conta"
          className="bg-emerald-600 rounded-xl px-4 py-2"
        >
          <Text className="text-white font-bold text-lg leading-6">＋</Text>
        </Pressable>
      }
    >
      {active.length === 0 ? (
        <EmptyState icon={ICONS.contas} title="Nenhuma conta cadastrada" hint="Toque no ＋ para cadastrar a primeira." />
      ) : (
        active.map((acc) => (
          <Card key={acc.id} className="!py-3 gap-2">
            <View className="flex-row justify-between items-center">
              <Pressable onPress={() => openEdit(acc)} accessibilityLabel={`Editar ${acc.name}`}>
                <View className="flex-row items-center gap-1.5">
                  <Text className="font-semibold text-slate-900">{acc.name}</Text>
                  <Text className="text-slate-300">{ICONS.editar}</Text>
                </View>
                <Text className="text-xs text-slate-500">
                  {TYPE_LABELS[acc.type] ?? acc.type} · inicial {formatBRL(acc.initial)}{' '}
                  {acc.initialDate ? `em ${ymdToBr(acc.initialDate)}` : '(desde sempre)'}
                </Text>
              </Pressable>
              <Text className={`font-bold ${acc.balance < 0 ? 'text-rose-600' : 'text-slate-900'}`}>
                {formatBRL(acc.balance)}
              </Text>
            </View>

            <ToggleRow
              label="Aparece no saldo do Fluxo"
              description={acc.include ? 'Esta conta soma no saldo geral da tela Início.' : 'Esta conta NÃO soma no saldo geral.'}
              value={acc.include}
              onChange={(v) => toggleInclude(acc, v)}
            />

            <View className="flex-row gap-2 items-center">
              {canDelete(acc) ? (
                <Pressable
                  onPress={() => setDeleteConfirm(acc)}
                  className="flex-1 bg-rose-50 rounded-xl px-3 py-2 items-center"
                  accessibilityRole="button"
                  accessibilityLabel={`Excluir ${acc.name}`}
                >
                  <Text className="text-rose-600 font-semibold text-sm">{ICONS.excluir} Excluir</Text>
                </Pressable>
              ) : (
                <Text className="flex-1 text-[11px] text-slate-400 leading-4">
                  Possui {'movimentações ou saldo'} — exclusão bloqueada; use ARQUIVAR.
                </Text>
              )}
              <Pressable
                onPress={() => doArchive(acc)}
                className="flex-1 bg-slate-100 rounded-xl px-3 py-2 items-center"
                accessibilityRole="button"
                accessibilityLabel={`Arquivar ${acc.name}`}
              >
                <Text className="text-slate-600 font-semibold text-sm">{ICONS.arquivar} Arquivar</Text>
              </Pressable>
            </View>
          </Card>
        ))
      )}

      {archived.length > 0 ? (
        <>
          <View className="mt-2">
            <Text className="text-sm font-semibold uppercase tracking-wide text-slate-400">Arquivadas</Text>
          </View>
          {archived.map((acc) => (
            <Card key={acc.id} className="!py-3 gap-2 opacity-80">
              <View className="flex-row justify-between items-center">
                <View>
                  <Text className="font-semibold text-slate-500">{acc.name}</Text>
                  <Text className="text-xs text-slate-400">{TYPE_LABELS[acc.type] ?? acc.type} · fora das escolhas e do saldo</Text>
                </View>
                <Pressable
                  onPress={() => doArchive(acc)}
                  className="bg-emerald-50 rounded-xl px-3 py-2"
                  accessibilityRole="button"
                  accessibilityLabel={`Desarquivar ${acc.name}`}
                >
                  <Text className="text-emerald-700 font-semibold text-sm">{ICONS.check} Desarquivar</Text>
                </Pressable>
              </View>
            </Card>
          ))}
        </>
      ) : null}

      <Text className="text-[11px] text-slate-400 text-center px-6">
        {ICONS.arquivar} Arquivar esconde a conta das escolhas de lançamento e do saldo geral, preservando o histórico. O "＋" abre a tela de cadastramento.
      </Text>

      {/* v21 (bug 4): confirmação da exclusão de conta */}
      <ConfirmDialog
        visible={!!deleteConfirm}
        title="Excluir conta?"
        message={deleteConfirm ? `"${deleteConfirm.name}" sai definitivamente do app (só é possível com conta sem movimentações e saldo zerado).` : undefined}
        buttons={[
          { label: 'Excluir conta', color: 'red', onPress: () => { if (deleteConfirm) doDelete(deleteConfirm); } },
          { label: 'Cancelar', color: 'green', onPress: () => setDeleteConfirm(null) },
        ]}
        onClose={() => setDeleteConfirm(null)}
      />

    </Screen>
  );
}
