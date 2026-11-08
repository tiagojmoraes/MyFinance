/**
 * MonthScroller (v9/v10/v11) — seletor horizontal de Mês/Ano para o Fluxo.
 *  - REGRA (v10): mês do ANO CORRENTE mostra apenas o NOME do mês ("out");
 *    mês de outro ano mostra MÊS/ANO ("out/2026").
 *  - Inicia no MÊS ATUAL e permite avançar/retroceder rolando a barra
 *    horizontal ou usando as setas das pontas.
 *  - v11: ao TOCAR em um mês (ou usar as setas), o chip selecionado ANIMA e
 *    se move AUTOMATICAMENTE para o CENTRO da barra — sempre, a cada seleção.
 *    O cálculo usa o passo real entre chips (largura + margem), então o chip
 *    selecionado fica exatamente no centro em qualquer posição da lista.
 */

import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { monthOf, todaySP, monthAdd, type Ym } from '../lib/dates';
import { theme } from '../theme';
import { ICONS } from '../theme/icons';

const PAST_MONTHS = 18;
const FUTURE_MONTHS = 18;
const CHIP_W = 84; // px — largura fixa do chip
const CHIP_GAP = 6; // px — mr-1.5 entre chips (passo real = 90)
const PITCH = CHIP_W + CHIP_GAP;
const PAD_X = 4; // paddingHorizontal do conteúdo

/** Mês curto pt-BR sem ponto ("out"). */
export function shortMonthName(ym: Ym): string {
  const [y, m] = ym.split('-').map((x) => parseInt(x, 10));
  const raw = new Intl.DateTimeFormat('pt-BR', { month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 1))
  );
  return raw.replace('.', '');
}

/**
 * Rótulo do chip (v10): ANO CORRENTE -> só o nome do mês ("out");
 * outro ano -> Mês/Ano ("out/2026").
 */
export function shortMonthLabel(ym: Ym): string {
  const currentYear = monthOf(todaySP()).slice(0, 4);
  const name = shortMonthName(ym);
  return ym.slice(0, 4) === currentYear ? name : `${name}/${ym.slice(0, 4)}`;
}

export function MonthScroller({ value, onChange }: {
  value: Ym;
  onChange: (ym: Ym) => void;
}) {
  const current = monthOf(todaySP());
  const months: Ym[] = [];
  for (let i = -PAST_MONTHS; i <= FUTURE_MONTHS; i++) months.push(monthAdd(current, i));
  const selectedIndex = months.indexOf(value);

  const scrollerRef = React.useRef<ScrollView>(null);
  const didInitialScroll = React.useRef(false);
  // v10: largura visível da barra — necessária para CENTRAR o chip selecionado
  const [viewW, setViewW] = React.useState(0);

  /**
   * v11: deslocamento que deixa o chip do índice informado EXATAMENTE NO CENTRO:
   * centro do chip (PAD_X + idx*PITCH + CHIP_W/2) menos metade da largura visível.
   */
  const centerOffset = (idx: number) =>
    Math.max(0, Math.round(PAD_X + idx * PITCH + CHIP_W / 2 - viewW / 2));

  React.useEffect(() => {
    if (selectedIndex < 0 || viewW === 0) return;
    if (!didInitialScroll.current) {
      // Primeira montagem: centraliza sem animação
      didInitialScroll.current = true;
      const target = centerOffset(selectedIndex);
      const t = setTimeout(() => scrollerRef.current?.scrollTo({ x: target, animated: false }), 60);
      return () => clearTimeout(t);
    }
    // v11: mudança de seleção (toque no chip ou setas) — ANIMA até o CENTRO
    const target = centerOffset(selectedIndex);
    const t = setTimeout(() => scrollerRef.current?.scrollTo({ x: target, animated: true }), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex, viewW]);

  const nudge = (dir: -1 | 1) => {
    const nextIndex = Math.min(Math.max(0, selectedIndex + dir), months.length - 1);
    onChange(months[nextIndex]); // o efeito acima re-centra sozinho (animado)
  };

  return (
    <View className="flex-row items-center gap-1.5">
      <Pressable
        onPress={() => nudge(-1)}
        accessibilityLabel="Mês anterior"
        className="bg-slate-100 rounded-lg px-2.5 py-2"
      >
        <Text className="font-bold text-slate-600">{ICONS.voltar}</Text>
      </Pressable>
      <ScrollView
        ref={scrollerRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: PAD_X }}
        className="flex-1"
        onLayout={(e) => setViewW(e.nativeEvent.layout.width)}
      >
        {months.map((ym) => {
          const active = ym === value;
          const isCurrent = ym === current;
          return (
            <Pressable
              key={ym}
              onPress={() => onChange(ym)}
              accessibilityRole="button"
              accessibilityLabel={`Mês ${shortMonthLabel(ym)}`}
              style={{ width: CHIP_W, marginRight: CHIP_GAP }}
              className={`items-center justify-center rounded-xl border py-2 ${
                active
                  ? 'bg-emerald-600 border-transparent'
                  : isCurrent
                    ? `bg-emerald-50 border-emerald-200`
                    : `${theme.surface} ${theme.border} border`
              }`}
            >
              <Text className={`text-sm font-bold ${active ? 'text-white' : isCurrent ? 'text-emerald-700' : theme.text}`}>
                {shortMonthLabel(ym)}
              </Text>
              {isCurrent ? (
                <Text className={`text-[9px] font-semibold ${active ? 'text-emerald-50' : 'text-emerald-600'}`}>
                  atual
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
      <Pressable
        onPress={() => nudge(1)}
        accessibilityLabel="Próximo mês"
        className="bg-slate-100 rounded-lg px-2.5 py-2"
      >
        <Text className="font-bold text-slate-600">{ICONS.avancar}</Text>
      </Pressable>
    </View>
  );
}
