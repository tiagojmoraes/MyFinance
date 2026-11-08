/**
 * Tela NOVA CONTA (v70 — MELHORIA 2.3) — cadastro em TELA PRÓPRIA.
 *
 * O botão "＋" da tela Contas abria o formulário EMBASSO da lista (violava o
 * padrão do app). Agora abre esta tela de cadastramento de verdade. A MESMA
 * tela serve para ALTERAR (/conta-nova?edit=ID) — o formulário de edição que
 * ficava inline na lista também saiu daí.
 *
 * Campos: Nome*, Tipo (corrente/poupança/dinheiro), Saldo inicial (MoneyInput
 * pt-BR) e Data âncora (v20 — o valor vale NO INÍCIO do dia escolhido).
 */

import React from 'react';
import { View, Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen, Card, TextField, Select, Button, DateField } from '../src/components/ui';
import { MoneyInput } from '../src/components/MoneyInput';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { showToast } from '../lib/toast';
import { genId } from '../src/lib/id';
import { todaySP } from '../src/lib/dates';
import { formatBRL } from '../src/lib/money';
import { ICONS } from '../src/theme/icons';

export default function ContaNovaScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const params = useLocalSearchParams<{ edit?: string }>();
  const editId = params.edit ? String(params.edit) : null;

  const [name, setName] = React.useState('');
  const [type, setType] = React.useState<string | null>('CHECKING');
  const [initialCents, setInitialCents] = React.useState(0);
  // v20: data âncora do saldo inicial — nova conta nasce com HOJE
  const [initialDate, setInitialDate] = React.useState<string>(todaySP());
  const [saving, setSaving] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);

  useDataEffect(async (svc) => {
    if (loaded) return;
    if (editId) {
      const acc = await svc.db.getFirstAsync<{
        name: string; type: string; initial_balance_cents: number; initial_balance_date: string | null;
      }>('SELECT name, type, initial_balance_cents, initial_balance_date FROM accounts WHERE id = ?', [editId]);
      if (acc) {
        setName(acc.name);
        setType(acc.type);
        setInitialCents(acc.initial_balance_cents);
        setInitialDate(acc.initial_balance_date ?? '');
      } else {
        showToast('Conta não encontrada', 'err');
        router.back();
      }
    }
    setLoaded(true);
  });

  const save = async () => {
    if (!name.trim()) {
      showToast('Informe o nome da conta', 'err');
      return;
    }
    if (!type) {
      showToast('Selecione o tipo', 'err');
      return;
    }
    setSaving(true);
    try {
      if (editId) {
        await services.db.runAsync(
          'UPDATE accounts SET name = ?, type = ?, initial_balance_cents = ?, initial_balance_date = ? WHERE id = ?',
          [name.trim(), type, initialCents, initialDate || null, editId]
        );
        showToast('Conta alterada');
      } else {
        await services.db.runAsync(
          'INSERT INTO accounts (id, name, type, initial_balance_cents, initial_balance_date, include_in_general_balance, archived_at) VALUES (?,?,?,?,?,1,NULL)',
          [genId(), name.trim(), type, initialCents, initialDate || null]
        );
        showToast(`Conta criada — saldo inicial ${formatBRL(initialCents)}`);
      }
      bump();
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen title={editId ? 'Alterar conta' : 'Nova conta'} subtitle={editId ? undefined : 'Cadastre corrente, poupança ou dinheiro'}>
      <Card className="gap-3">
        <TextField label="Nome" value={name} onChangeText={setName} placeholder="Ex.: Banco Principal" />
        <Select
          label="Tipo"
          items={[
            { id: 'CHECKING', label: 'Conta corrente' },
            { id: 'SAVINGS', label: 'Poupança' },
            { id: 'CASH', label: 'Dinheiro' },
          ]}
          selectedId={type}
          onSelect={(v) => setType(v)}
        />
        <MoneyInput label="Saldo inicial" cents={initialCents} onChangeCents={setInitialCents} />
        <DateField label="Data do saldo inicial" value={initialDate} onChange={setInitialDate} />
        <Text className="text-[11px] text-slate-400 leading-4 -mt-1">
          O valor acima é o saldo da conta NO INÍCIO do dia escolhido. Lançamentos ANTERIORES a ele já estão dentro do saldo (não somam de novo) e dias anteriores mostram 0,00. Em branco = vale desde sempre.
        </Text>
        <View className="flex-row gap-2 mt-1">
          <View className="flex-1">
            <Button label="Cancelar" variant="outline" onPress={() => router.back()} />
          </View>
          <View className="flex-1">
            <Button label={editId ? 'Salvar' : 'Criar conta'} onPress={save} loading={saving} />
          </View>
        </View>
      </Card>
      <Text className="text-[11px] text-slate-400 text-center px-6">
        {ICONS.contas} A nova conta entra nas escolhas de lançamento e, por padrão, soma no saldo geral da tela Início — o toggle "Aparece no saldo do Fluxo" fica na tela Contas.
      </Text>
    </Screen>
  );
}
