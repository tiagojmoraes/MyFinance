/** Tela Recorrências — HISTÓRICO das contas fixas (v11, Req 4):
 *  · A criação mudou de lugar: o submenu "Nova regra" foi EXTINTO. A conta
 *    fixa é criada no Novo Lançamento > Fixo (em CONTA ou em CARTÃO).
 *  · Aqui fica o histórico completo das regras; a edição (vale da competência
 *    atual em diante) abre a TELA PRÓPRIA /recorrencia-alterar?id=ID — v70
 *    (MELHORIA 2.3): o formulário que ficava embaixo da lista saiu daqui.
 *  v17 (melhoria 3): o botão de processamento manual foi REMOVIDO — o
 *    processamento das fixas é automático no abrir do app e na abertura do
 *    Fluxo; o botão não tinha utilidade no fluxo atual.
 *  v17 (bug 2): ao Salvar a alteração da regra, o Fluxo reflete na hora —
 *    as ocorrências da competência atual em diante são sincronizadas
 *    (RecurrenceService.updateRule) e o bump() recarrega todas as telas.
 */

import React from 'react';
import { View, Text,  Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, EmptyState, Badge, FixedDot } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { formatBRL } from '../src/lib/money';

export default function RecorrenciasScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [rules, setRules] = React.useState<Array<{ id: string; description: string; type: string; amount_cents: number; day_of_month: number; is_active: number; account_id: string | null }>>([]);

  useDataEffect(async (svc) => {
    const list = await svc.recurrences.listRules();
    setRules(list);
  });

  const toggle = async (id: string, active: boolean) => {
    await services.recurrences.setActive(id, !active);
    bump();
  };

  /** v70 (MELHORIA 2.3): edição na TELA PRÓPRIA (nada de form embaixo da lista). */
  const startEdit = (r: { id: string }) => {
    router.push({ pathname: '/recorrencia-alterar', params: { id: r.id } });
  };

  return (
    <Screen title="Recorrências" subtitle="Histórico das contas fixas · criar agora só no Novo Lançamento">
      {rules.length === 0 ? (
        <EmptyState
          icon="🔁"
          title="Nenhuma conta fixa"
          hint="Crie em Novo Lançamento > Fixo (em conta ou no cartão)."
        />
      ) : (
        rules.map((r) => (
          <Card key={r.id} className="!py-3">
            <View className="flex-row justify-between items-center">
              <View className="flex-1 flex-row items-center gap-1.5">
                <FixedDot />
                <View className="flex-1">
                  <Text className="font-semibold text-slate-900">{r.description}</Text>
                  <Text className="text-xs text-slate-500">
                    Todo dia {r.day_of_month} · {r.type === 'INCOME' ? 'entrada' : 'saída'}
                  </Text>
                </View>
              </View>
              <View className="items-end gap-1">
                <Text className={`font-bold ${r.type === 'INCOME' ? 'text-emerald-600' : 'text-rose-600'}`}>
                  {r.type === 'INCOME' ? '+' : '−'}{formatBRL(r.amount_cents)}
                </Text>
                <View className="flex-row items-center gap-1">
                  <Pressable onPress={() => startEdit(r)} className="px-2 py-1 rounded-lg bg-slate-100">
                    <Text className="text-xs font-semibold text-slate-600">Alterar</Text>
                  </Pressable>
                  <Pressable onPress={() => toggle(r.id, r.is_active === 1)} className="px-2 py-0.5">
                    <Badge status={r.is_active ? 'OPEN' : 'VOIDED'} />
                  </Pressable>
                </View>
              </View>
            </View>
          </Card>
        ))
      )}

      {/* v70 (MELHORIA 2.3): o formulário de alteração virou a TELA PRÓPRIA
          /recorrencia-alterar?id=ID — aberta pelo botão "Alterar" acima. */}
    </Screen>
  );
}
