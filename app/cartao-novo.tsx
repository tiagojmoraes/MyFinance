/**
 * Tela NOVO CARTÃO DE CRÉDITO (v70 — MELHORIA 2.3) — cadastro em TELA PRÓPRIA.
 *
 * O botão "＋" da tela Cartões de Crédito abria o formulário EMBASSO da lista
 * (violava o padrão do app). Agora abre esta tela de cadastramento.
 * v70 (MELHORIA 2.4): campos "Dia do fechamento" e "Dia do vencimento"
 * (sem "(1-31)" — a validação continua garantindo 1 a 31).
 */

import React from 'react';
import { View, Text } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, TextField, Select, Button } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { showToast } from '../lib/toast';
import { genId } from '../src/lib/id';
import { ICONS } from '../src/theme/icons';

export default function CartaoNovoScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [name, setName] = React.useState('');
  const [last4, setLast4] = React.useState('');
  const [closingDay, setClosingDay] = React.useState('15');
  const [dueDay, setDueDay] = React.useState('10');
  const [linkedId, setLinkedId] = React.useState<string | null>(null);
  const [accounts, setAccounts] = React.useState<Array<{ id: string; label: string }>>([]);
  const [saving, setSaving] = React.useState(false);

  useDataEffect(async (svc) => {
    const accs = await svc.db.getAllAsync<{ id: string; name: string }>(
      'SELECT id, name FROM accounts WHERE archived_at IS NULL ORDER BY name'
    );
    setAccounts(accs.map((a) => ({ id: a.id, label: a.name })));
  });

  const save = async () => {
    try {
      const closing = parseInt(closingDay, 10);
      const due = parseInt(dueDay, 10);
      if (!name.trim()) throw new Error('Informe o nome do cartão');
      if (!Number.isInteger(closing) || closing < 1 || closing > 31) throw new Error('Dia do fechamento entre 1 e 31');
      if (!Number.isInteger(due) || due < 1 || due > 31) throw new Error('Dia do vencimento entre 1 e 31');
      await services.db.runAsync(
        'INSERT INTO cards (id, name, last_four_digits, closing_day, due_day, linked_account_id, limit_cents, archived_at) VALUES (?,?,?,?,?,?,NULL,NULL)',
        [genId(), name.trim(), last4.trim() || null, closing, due, linkedId]
      );
      showToast('Cartão criado');
      bump();
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  return (
    <Screen title="Novo cartão de crédito" subtitle="Fechamento, vencimento e conta de pagamento">
      <Card className="gap-3">
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
        <Text className="text-[11px] text-slate-400 leading-4 -mt-1">
          Fechamento = dia em que as compras saem da fatura; vencimento = dia de pagar. Os dois vão de 1 a 31.
        </Text>
        <Select label="Conta de pagamento (opcional)" items={accounts} selectedId={linkedId} onSelect={setLinkedId} allowEmpty />
        <View className="flex-row gap-2 mt-1">
          <View className="flex-1">
            <Button label="Cancelar" variant="outline" onPress={() => router.back()} />
          </View>
          <View className="flex-1">
            <Button label="Criar cartão" onPress={save} loading={saving} />
          </View>
        </View>
      </Card>
      <Text className="text-[11px] text-slate-400 text-center px-6">
        {ICONS.cartoes} Depois de criar, o limite e o arquivamento ficam no detalhe do cartão (toque no cartão na lista).
      </Text>
    </Screen>
  );
}
