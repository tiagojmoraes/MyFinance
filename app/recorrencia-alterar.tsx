/**
 * Tela ALTERAR CONTA FIXA (v70 — MELHORIA 2.3) — edição em TELA PRÓPRIA.
 *
 * Na tela Recorrências o formulário de alterar a conta fixa abria EMBASSO da
 * lista (mesmo problema do "＋" das Contas). Agora "Alterar" abre ESTA tela.
 * Regra mantida (v21): a alteração vale da competência atual em diante e pede
 * confirmação antes de salvar.
 */

import React from 'react';
import { View, Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen, Card, TextField, Button } from '../src/components/ui';
import { MoneyInput } from '../src/components/MoneyInput';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { showToast } from '../lib/toast';

export default function RecorrenciaAlterarScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const params = useLocalSearchParams<{ id?: string }>();
  const ruleId = params.id ? String(params.id) : null;

  const [description, setDescription] = React.useState('');
  const [cents, setCents] = React.useState(0);
  const [day, setDay] = React.useState('1');
  const [loaded, setLoaded] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  useDataEffect(async (svc) => {
    if (loaded || !ruleId) return;
    const rule = await svc.db.getFirstAsync<{
      description: string; amount_cents: number; day_of_month: number;
    }>('SELECT description, amount_cents, day_of_month FROM recurrence_rules WHERE id = ?', [ruleId]);
    if (rule) {
      setDescription(rule.description);
      setCents(rule.amount_cents);
      setDay(String(rule.day_of_month));
    } else {
      showToast('Conta fixa não encontrada', 'err');
      router.back();
    }
    setLoaded(true);
  });

  const saveEdit = async () => {
    if (!ruleId) return;
    setSaving(true);
    try {
      const d = parseInt(day, 10);
      if (!Number.isInteger(d) || d < 1 || d > 31) throw new Error('Dia do mês entre 1 e 31');
      // v17 (bug 2): updateRule SINCRONIZA as ocorrências da competência atual
      // em diante — o Fluxo reflete na hora (bump ao voltar).
      await services.recurrences.updateRule(ruleId, {
        amountCents: cents,
        dayOfMonth: d,
        description: description.trim() || 'Conta fixa',
      });
      showToast('Conta fixa alterada — vale da competência atual em diante');
      setConfirmOpen(false);
      bump();
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen title="Alterar conta fixa" subtitle="Vale da competência atual em diante">
      <Card className="gap-3">
        <TextField label="Descrição" value={description} onChangeText={setDescription} />
        <MoneyInput label="Novo valor" cents={cents} onChangeCents={setCents} />
        <TextField label="Dia do mês" value={day} onChangeText={setDay} keyboardType="numeric" />
        <Text className="text-xs text-slate-500">
          Lançamentos de meses anteriores NÃO são alterados (histórico preservado). A competência do mês atual e as próximas passam a valer o novo valor.
        </Text>
        <View className="flex-row gap-2 mt-1">
          <View className="flex-1">
            <Button label="Cancelar" variant="outline" onPress={() => router.back()} />
          </View>
          <View className="flex-1">
            {/* v21 (bug 4): salvar pede confirmação */}
            <Button label="Salvar" onPress={() => setConfirmOpen(true)} loading={saving} />
          </View>
        </View>
      </Card>

      <ConfirmDialog
        visible={confirmOpen}
        title="Confirmar alteração da conta fixa?"
        message={`"${description}" muda da competência atual em diante (meses anteriores ficam como estão).`}
        buttons={[
          { label: 'Salvar alteração', color: 'green', onPress: saveEdit },
          { label: 'Cancelar', color: 'red', onPress: () => setConfirmOpen(false) },
        ]}
        onClose={() => setConfirmOpen(false)}
      />
    </Screen>
  );
}
