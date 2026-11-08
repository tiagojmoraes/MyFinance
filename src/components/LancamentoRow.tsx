/**
 * LancamentoRow (v67 — BUG 2) — ESQUELETO ÚNICO das linhas do Fluxo.
 *
 * Vindo do v14 (bug 4): tudo que NÃO é de cartão (lançamento comum, parcela
 * em conta, grupo consolidado e itens internos do grupo) usava o MESMO card.
 * v67: o esqueleto saiu do corpo da tela e virou COMPONENTE — agora as linhas
 * de Orçamento e Poupança (cards aglutinados v42) usam O MESMO layout do
 * Consolidado/Fatura/Parcela: [setinha] [pictograma] título / detalhes / chips
 * à esquerda; VALOR + Alterar/Incluir/Excluir sempre nos MESMOS pontos à
 * direita. Filhos de grupo mudam só o recuo tracejado. Proibido conceito
 * duplo: nenhuma tela do Fluxo monta card de linha à mão.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Card } from './ui';
import { ICONS } from '../theme/icons';

export interface LancamentoRowProps {
  keyHint?: string;
  /** Recuo tracejado dos itens internos do grupo (padrão v14). */
  dashed?: boolean;
  /** Long-press de 3 s → duplicar (v11, Req 5). */
  longPress?: (() => void) | null;
  disabled?: boolean;
  /** Setinha de expansão (grupo/fatura/poupança/orçamento). */
  arrow?: { open: boolean; onPress: () => void; label: string; tone?: 'violet' | 'rose' } | null;
  /** Pictograma opcional na caixa da setinha (fatura = cartões, poupança…). */
  icon?: string | null;
  title: string;
  voided?: boolean;
  subtitle: string;
  /** v19: marcador do item interno (bolinha ✓ / pill X/N) ANTES da linha de detalhes. */
  subLeading?: React.ReactNode | null;
  chips?: React.ReactNode;
  /** Press no corpo da linha (fatura abre a tela da fatura). */
  onBodyPress?: (() => void) | null;
  amount: string;
  amountClass?: string;
  onAlterar?: (() => void) | null;
  /** v22 (bug 1): "+Incluir" do cabeçalho do consolidado. */
  onIncluir?: (() => void) | null;
  onExcluir?: (() => void) | null;
  /** Cor da borda do card (fatura em aberto usa rose-300). */
  borderClass?: string;
  /** v67: rodapé expansível (itens da fatura / conteúdo do orçamento/poupança). */
  footer?: React.ReactNode | null;
  /** v67 (BUG 3): quando definido, o rodapé só aparece se footerOpen. */
  footerOpen?: boolean;
  /** v67: link "Cadastrar / alterar … ›" no fim do card (orçamento/poupança). */
  onCadastrar?: (() => void) | null;
  cadastrarLabel?: string;
}

export function LancamentoRowBase({
  footerOpen = true,
  onCadastrar,
  cadastrarLabel,
  ...a
}: LancamentoRowProps) {
  const arrowBoxClass = a.arrow?.tone === 'rose' ? 'bg-rose-50' : 'bg-violet-50';
  const arrowTextClass = a.arrow?.tone === 'rose' ? 'text-rose-700' : 'text-violet-700';
  return (
    <Pressable
      onLongPress={a.longPress ?? undefined}
      delayLongPress={3000}
      accessibilityLabel={a.longPress ? `Segurar para duplicar ${a.title}` : a.title}
      disabled={a.disabled}
    >
      <Card className={`!py-3 ${a.dashed ? 'ml-3 border-dashed' : ''} ${a.borderClass ?? ''}`}>
        <View className="flex-row justify-between items-start gap-2">
          {a.arrow || a.icon ? (
            <Pressable
              onPress={a.arrow?.onPress}
              accessibilityLabel={a.arrow?.label}
              disabled={!a.arrow}
              className={`w-8 h-8 rounded-lg items-center justify-center ${a.arrow ? arrowBoxClass : ''}`}
            >
              <Text className={`text-sm font-bold ${a.arrow ? arrowTextClass : 'text-slate-700'}`}>
                {a.arrow ? (a.arrow.open ? ICONS.recolher : ICONS.expandir) : (a.icon ?? '')}
              </Text>
            </Pressable>
          ) : null}
          <Pressable onPress={a.onBodyPress ?? undefined} disabled={!a.onBodyPress} className="flex-1">
            {/* v10: descrição SEM truncamento — sempre legível por inteiro */}
            <Text className={`font-semibold text-slate-900 ${a.voided ? 'line-through text-slate-400' : ''}`}>
              {a.title}
            </Text>
            {/* v19: nos itens internos do consolidado o marcador fica ANTES da
                linha de detalhes, alinhado ao texto — nunca mais solto numa
                linha de chips órfã */}
            {a.subLeading ? (
              <View className="flex-row items-center gap-1.5 mt-0.5">
                {a.subLeading}
                <Text className="text-xs text-slate-500 flex-shrink">{a.subtitle}</Text>
              </View>
            ) : (
              <Text className="text-xs text-slate-500 mt-0.5">{a.subtitle}</Text>
            )}
            {a.chips ? (
              <View className="flex-row gap-1 mt-1 items-center flex-wrap">{a.chips}</View>
            ) : null}
          </Pressable>
          <View className="items-end gap-1">
            <Text className={`font-bold ${a.amountClass ?? 'text-slate-900'}`}>{a.amount}</Text>
            {!a.disabled ? (
              <View className="flex-row gap-1">
                {/* v69: ORDEM DO USUÁRIO — "+Incluir" vem PRIMEIRO, depois
                    "Alterar" e por fim "Excluir" (cabeçalho do consolidado). */}
                {a.onIncluir ? (
                  <Pressable
                    onPress={a.onIncluir}
                    accessibilityLabel={`Incluir lançamento no grupo ${a.title}`}
                    className="px-2 py-1 rounded-lg bg-violet-50"
                  >
                    <Text className="text-xs font-bold text-violet-700">+Incluir</Text>
                  </Pressable>
                ) : null}
                {a.onAlterar ? (
                  <Pressable
                    onPress={a.onAlterar}
                    accessibilityLabel={`Alterar ${a.title}`}
                    className="px-2 py-1 rounded-lg bg-slate-100"
                  >
                    <Text className="text-xs font-semibold text-slate-600">Alterar</Text>
                  </Pressable>
                ) : null}
                {a.onExcluir ? (
                  <Pressable
                    onPress={a.onExcluir}
                    accessibilityLabel={`Excluir ${a.title}`}
                    className="px-2 py-1 rounded-lg bg-rose-50"
                  >
                    <Text className="text-xs font-semibold text-rose-600">Excluir</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
        {a.footer && footerOpen ? (
          <View className="mt-2 gap-1 border-t border-dashed border-slate-200 pt-2">{a.footer}</View>
        ) : null}
        {onCadastrar && footerOpen ? (
          <Text
            onPress={onCadastrar}
            accessibilityRole="button"
            accessibilityLabel={cadastrarLabel ?? 'Cadastrar'}
            className="text-[11px] font-semibold text-emerald-700 mt-1"
          >
            {cadastrarLabel ?? 'Cadastrar ›'}
          </Text>
        ) : null}
      </Card>
    </Pressable>
  );
}

/** v68 (DESEMPENHO): linha memoizada — quando o estado alheio muda (teclado,
 *  expansão de outro card, digitação), as linhas cujas props não mudaram não
 *  re-renderizam. */
export const LancamentoRow = React.memo(LancamentoRowBase);
