/**
 * Tela POUPANÇA (v42) — cadastro dos planos de poupança. O usuário liga o
 * módulo em Ajustes; a ação "Poupança" da tela inicial vem para cá.
 *
 * DUAS FORMAS DE CRIAR (pedido do usuário):
 *  · MENSAL — cadastra um valor para o mês e ele SE REPETE todo mês (no dia
 *    escolhido): o app gera a PREVISÃO de transferência origem → destino
 *    (mesma mecânica das contas fixas; ao chegar o dia, efetiva sozinho);
 *  · FECHAMENTO DE MÊS — pega o saldo do dia previsto do FIM do mês: quando
 *    positivo, a diferença vira a ESTIMATIVA de poupança, que o usuário
 *    confirma (aqui ou no card do Fluxo) e vira transferência no último dia.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import {
  Screen, Card, Button, SectionTitle, EmptyState, Segmented, Select, TextField,
} from '../src/components/ui';
import { MoneyInput } from '../src/components/MoneyInput';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { showToast } from '../lib/toast';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { formatBRL } from '../src/lib/money';
import { todaySP, monthOf, monthLabel } from '../src/lib/dates';
import type { SavingsPlanRow, SavingsMode } from '../src/services/SavingsService';

interface AccOption { id: string; label: string }

export default function PoupancaScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);

  const [mode, setMode] = React.useState<SavingsMode>('MONTHLY');
  const [amount, setAmount] = React.useState(0);
  const [dayText, setDayText] = React.useState('5');
  const [fromId, setFromId] = React.useState<string | null>(null);
  const [toId, setToId] = React.useState<string | null>(null);
  const [accounts, setAccounts] = React.useState<AccOption[]>([]);
  const [plans, setPlans] = React.useState<SavingsPlanRow[]>([]);
  const [suggestion, setSuggestion] = React.useState<number | null>(null);
  const [deleting, setDeleting] = React.useState<SavingsPlanRow | null>(null);
  const [busy, setBusy] = React.useState(false);

  const month = monthOf(todaySP());

  const load = React.useCallback(async () => {
    const accs = await services.db.getAllAsync<{ id: string; name: string; type: string }>(
      'SELECT id, name, type FROM accounts WHERE archived_at IS NULL ORDER BY name'
    );
    setAccounts(accs.map((a) => ({ id: a.id, label: a.name })));
    setPlans(await services.savings.listPlans());
    try {
      const sug = await services.savings.getClosingSuggestion(month);
      setSuggestion(sug ? sug.amountCents : null);
    } catch {
      setSuggestion(null);
    }
  }, [services, month]);

  useDataEffect(load);

  const resetForm = () => {
    setAmount(0);
    setDayText('5');
    setFromId(null);
    setToId(null);
  };

  const save = async () => {
    setBusy(true);
    try {
      if (!fromId || !toId) {
        showToast('Escolha a conta de origem e o destino (conta poupança)', 'err');
        return;
      }
      if (mode === 'MONTHLY') {
        const day = parseInt(dayText, 10);
        await services.savings.createMonthlyPlan({ amountCents: amount, dayOfMonth: day, fromAccountId: fromId, toAccountId: toId });
        showToast('Poupança mensal criada — a previsão do mês já entrou no Fluxo');
      } else {
        await services.savings.createClosingPlan({ fromAccountId: fromId, toAccountId: toId });
        showToast('Fechamento de mês ativado — a estimativa aparece no card da Poupança');
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

  const confirmSuggestion = async () => {
    if (suggestion == null) return;
    setBusy(true);
    try {
      await services.savings.confirmClosing(month, suggestion);
      showToast(`Poupança de ${formatBRL(suggestion)} criada (transferência no fim de ${monthLabel(month)})`);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (p: SavingsPlanRow) => {
    try {
      await services.savings.setActive(p.id, p.is_active !== 1);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await services.savings.removePlan(deleting.id);
      showToast('Plano excluído — previsões não efetivadas saíram do Fluxo');
      setDeleting(null);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  return (
    <Screen title="Poupança">
      {/* Estimativa do fechamento do mês vigente (plano CLOSING ativo) */}
      {suggestion != null ? (
        <Card className="border border-emerald-200">
          <Text className="font-semibold text-slate-900">Fechamento de {monthLabel(month)}</Text>
          <Text className="text-sm text-slate-600 mt-0.5">
            O saldo do dia previsto do fim do mês está em {formatBRL(suggestion)} — essa diferença pode virar poupança.
          </Text>
          <View className="mt-2">
            <Button label={`Poupar ${formatBRL(suggestion)} (transferência no fim do mês)`} onPress={confirmSuggestion} loading={busy} />
          </View>
        </Card>
      ) : null}

      <SectionTitle>Novo plano</SectionTitle>
      <Card className="gap-2">
        <Segmented<SavingsMode>
          value={mode}
          onChange={setMode}
          options={[
            { value: 'MONTHLY', label: 'Mensal' },
            { value: 'CLOSING', label: 'Fechamento de mês' },
          ]}
        />
        {mode === 'MONTHLY' ? (
          <Text className="text-xs text-slate-500">
            Um valor para o mês que SE REPETE todo mês: no dia escolhido nasce a previsão de transferência (como conta fixa) e o app efetiva quando chegar o dia.
          </Text>
        ) : (
          <Text className="text-xs text-slate-500">
            No fechamento do mês, o saldo do dia previsto do fim do mês — se POSITIVO — vira a estimativa de poupança; você confirma e a transferência é criada no último dia.
          </Text>
        )}
        {mode === 'MONTHLY' ? (
          <>
            <MoneyInput label="Valor por mês" cents={amount} onChangeCents={setAmount} />
            <TextField
              label="Dia do mês"
              value={dayText}
              onChangeText={(t) => setDayText(t.replace(/\D/g, '').slice(0, 2))}
              placeholder="5"
              keyboardType="numeric"
            />
          </>
        ) : null}
        <Select
          label="Conta de origem (o dinheiro sai daqui)"
          items={accounts}
          selectedId={fromId}
          onSelect={setFromId}
          emptyLabel="Escolha a origem"
        />
        <Select
          label="Destino (conta poupança)"
          items={accounts}
          selectedId={toId}
          onSelect={setToId}
          emptyLabel="Escolha o destino"
        />
        <Button
          label={mode === 'MONTHLY' ? 'Criar poupança mensal' : 'Ativar fechamento de mês'}
          onPress={save}
          loading={busy}
        />
      </Card>

      <SectionTitle>Meus planos ({plans.length})</SectionTitle>
      {plans.length === 0 ? (
        <EmptyState icon="🐷" title="Nenhum plano" hint="Crie um plano mensal ou ative o fechamento de mês acima." />
      ) : (
        plans.map((p) => (
          <Card key={p.id} className="!py-3">
            <View className="flex-row justify-between items-start gap-2">
              <View className="flex-1">
                <Text className="font-semibold text-slate-900" numberOfLines={1}>
                  {p.mode === 'MONTHLY'
                    ? `Mensal · ${formatBRL(p.amount_cents ?? 0)} dia ${p.day_of_month ?? '—'}`
                    : 'Fechamento de mês'}
                  {p.is_active !== 1 ? '  ·  inativo' : ''}
                </Text>
                <Text className="text-xs text-slate-500" numberOfLines={1}>
                  {p.source_name ?? '—'} → {p.target_name ?? '—'}
                </Text>
              </View>
              <Pressable onPress={() => toggleActive(p)} className="bg-slate-100 rounded-lg px-2.5 py-1.5">
                <Text className="text-xs font-semibold text-slate-600">{p.is_active === 1 ? 'Desativar' : 'Ativar'}</Text>
              </Pressable>
              <Pressable onPress={() => setDeleting(p)} className="bg-rose-50 rounded-lg px-2.5 py-1.5">
                <Text className="text-xs font-semibold text-rose-600">Excluir</Text>
              </Pressable>
            </View>
          </Card>
        ))
      )}
      {plans.length > 0 ? (
        <Text className="text-[11px] text-slate-400 px-1">
          As transferências previstas e efetivadas aparecem no Fluxo (card Poupança e lançamento normal) — desfazer uma efetivada: exclua o lançamento no Fluxo.
        </Text>
      ) : null}

      <ConfirmDialog
        visible={deleting != null}
        title="Excluir plano de poupança?"
        message={
          deleting
            ? 'As PREVISÕES ainda não efetivadas saem do Fluxo; transferências JÁ EFETIVADAS permanecem no histórico (exclua lá, se quiser).'
            : undefined
        }
        buttons={[
          { label: 'Excluir', color: 'red', onPress: remove },
          { label: 'Cancelar', color: 'green', onPress: () => setDeleting(null) },
        ]}
        onClose={() => setDeleting(null)}
      />
    </Screen>
  );
}
