/** Tela Transferência — atômica: 1 transação TRANSFER + 2 financial_moves (ARQ-004).
 *  v7.0.4: tema PRETO (botão + acento), coerente com o tipo Transferência do Lançamento. */

import React from 'react';
import { View, ScrollView,  } from 'react-native';
import { showToast } from '../lib/toast';
import { router } from 'expo-router';
import { Screen, Card, TextField, Select, Button, DateField } from '../src/components/ui';
import { MoneyInput } from '../src/components/MoneyInput';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { todaySP } from '../src/lib/dates';

export default function TransferenciaScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [cents, setCents] = React.useState(0);
  const [description, setDescription] = React.useState('');
  const [date, setDate] = React.useState(todaySP());
  const [fromId, setFromId] = React.useState<string | null>(null);
  const [toId, setToId] = React.useState<string | null>(null);
  const [accounts, setAccounts] = React.useState<Array<{ id: string; label: string }>>([]);
  const [saving, setSaving] = React.useState(false);

  useDataEffect(async (svc) => {
    const accs = await svc.db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM accounts WHERE archived_at IS NULL ORDER BY name');
    setAccounts(accs.map((a) => ({ id: a.id, label: a.name })));
  });

  const save = async () => {
    try {
      if (cents <= 0) throw new Error('Informe um valor maior que zero');
      if (!fromId || !toId) throw new Error('Selecione origem e destino');
      await services.transactions.createTransfer({
        description: description.trim() || 'Transferência',
        amountCents: cents,
        date,
        fromAccountId: fromId,
        toAccountId: toId,
      });
      bump();
      // v10: SEM alerta de sucesso — direto para o FLUXO
      router.replace('/fluxo');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  return (
    <Screen title="Transferência" subtitle="Entre contas — atômica" accent="bg-black" accentTextClass="text-slate-900">
      <ScrollView showsVerticalScrollIndicator={false}>
        <Card className="gap-3">
          <MoneyInput label="Valor" cents={cents} onChangeCents={setCents} autoFocus accentTextClass="text-slate-900" />
          <TextField label="Descrição (opcional)" value={description} onChangeText={setDescription} placeholder="Ex.: Guardando na poupança" />
          <DateField label="Data" value={date} onChange={setDate} />
          <Select label="De (origem)" items={accounts} selectedId={fromId} onSelect={setFromId} />
          <Select label="Para (destino)" items={accounts} selectedId={toId} onSelect={setToId} />
        </Card>
        <View className="mt-4">
          <Button label="Transferir" onPress={save} loading={saving} bg="bg-black" />
        </View>
      </ScrollView>
    </Screen>
  );
}
