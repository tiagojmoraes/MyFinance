/** Tela Cadastro (v7.1→v70) — menu dedicado do rodapé:
 *  Cartões de Crédito · Contas · Categorias (com pictogramas e direção Débito/Crédito).
 *  v70 (MELHORIA 2.9): sem a pergunta "O que você quer cadastrar" no topo;
 *  "Catálogo de Produtos" (no plural) com o texto dos produtos vindos de NFC-e.
 *  v70 (MELHORIA 2.4): o item se chama "Cartões de Crédito" em todo o app. */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card } from '../src/components/ui';
import { ICONS } from '../src/theme/icons';

const ITEMS = [
  {
    icon: ICONS.cartoes,
    title: 'Cartões de Crédito',
    hint: 'Cartões de crédito, dia de corte e faturas por mês.',
    href: '/cartoes',
  },
  {
    icon: ICONS.contas,
    title: 'Contas',
    hint: 'Contas corrente, poupança e dinheiro (saldos).',
    href: '/contas',
  },
  {
    icon: ICONS.categorias,
    title: 'Categorias',
    hint: 'Categorias e subcategorias com pictograma, associadas a Débito ou Crédito.',
    href: '/categorias',
  },
  {
    // v70 (MELHORIA 2.9): "Catálogo de Produtos" com o texto do usuário
    icon: ICONS.produtos,
    title: 'Catálogo de Produtos',
    hint: 'Produtos importados diretamente das NFC-e',
    href: '/produtos',
  },
] as const;

export default function CadastroScreen() {
  return (
    <Screen title="Cadastro">
      {ITEMS.map((item) => (
        <Pressable key={item.href} onPress={() => router.push(item.href)} accessibilityRole="button" accessibilityLabel={item.title}>
          <Card className="!py-4 mb-1">
            <View className="flex-row items-center gap-3">
              <View className="w-12 h-12 rounded-xl bg-emerald-50 items-center justify-center">
                <Text className="text-2xl">{item.icon}</Text>
              </View>
              <View className="flex-1">
                <Text className="text-base font-bold text-slate-900">{item.title}</Text>
                <Text className="text-xs text-slate-500 mt-0.5">{item.hint}</Text>
              </View>
              <Text className="text-slate-400 text-lg">{ICONS.avancar}</Text>
            </View>
          </Card>
        </Pressable>
      ))}
      <Text className="text-[11px] text-slate-400 text-center px-6">
        Dica: o mesmo pictograma de uma categoria aparece junto ao nome dela nas telas de lançamento e fluxo.
      </Text>
    </Screen>
  );
}
