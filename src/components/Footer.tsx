/**
 * Footer — barra de navegação inferior (v7.1, safe area v8, Início v9).
 * Itens: Início · Lançamento · Fluxo · Cadastro · Ajustes.
 * Renderizado pelo componente Screen em todas as telas.
 * v8: usa a safe area INFERIOR do aparelho (useSafeAreaInsets) — em celulares
 * com navegação por gestos/barra nativa do Android os botões nunca ficam
 * encavalados: o padding inferior se adapta sozinho.
 * v9: primeiro item "Início" navega direto para a Tela Inicial.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from '../theme';
import { ICONS } from '../theme/icons';

const TABS = [
  { icon: ICONS.inicio, label: 'Início', href: '/' },
  { icon: ICONS.lancamento, label: 'Lançamento', href: '/lancamento' },
  { icon: ICONS.fluxo, label: 'Fluxo', href: '/fluxo' },
  { icon: ICONS.cadastro, label: 'Cadastro', href: '/cadastro' },
  { icon: ICONS.ajustes, label: 'Ajustes', href: '/ajustes' },
] as const;

export function Footer() {
  const pathname = usePathname() ?? '/';
  const insets = useSafeAreaInsets();
  const bottomPad = Math.max(insets.bottom, 8) + 4;
  return (
    <View
      className={`${theme.surface} border-t ${theme.border} flex-row items-stretch px-0.5 pt-1.5`}
      // v8: safe area inferior real (gesture navigation / notch)
      style={{ paddingBottom: bottomPad }}
    >
      {TABS.map((tab) => {
        const active = pathname === tab.href || (tab.href !== '/' && pathname.startsWith(`${tab.href}/`));
        return (
          <Pressable
            key={tab.href}
            onPress={() => {
              if (!active) router.push(tab.href);
            }}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            className="flex-1 items-center justify-center gap-0.5 py-1"
          >
            <Text className={`text-xl leading-7 ${active ? 'opacity-100' : 'opacity-40'}`}>{tab.icon}</Text>
            <Text
              className={`text-[9px] font-semibold ${active ? 'text-emerald-700' : 'text-slate-400'}`}
              numberOfLines={1}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
