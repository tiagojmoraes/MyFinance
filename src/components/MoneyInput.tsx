/**
 * Input monetário pt-BR (v10) — MÁSCARA PADRÃO "0,00" COM DIGITAÇÃO DA
 * DIREITA PARA A ESQUERDA (regra geral do app para TODOS os campos de valor).
 *
 * COMPORTAMENTO (v10):
 *  - O campo nasce mostrando "0,00".
 *  - Cada dígito entra à DIREITA, empurrando os valores: os DOIS ÚLTIMOS
 *    dígitos são sempre os CENTAVOS (fixos):
 *      digitou "1"   -> 0,01
 *      digitou "10"  -> 0,10
 *      digitou "100" -> 1,00
 *      digitou "150000" -> 1.500,00
 *  - Separador de MILHAR com PONTO (1.234.567,89).
 *  - Backspace remove o último dígito (da direita).
 *  - Valor MÁXIMO aceito: 999.999.999,00 (dígitos excedentes são ignorados).
 *
 * O valor trafega em CENTAVOS (fonte única — ARQ-001). O texto exibido é
 * sempre derivado do estado.
 * v16 (melhoria 5): o CURSOR fica PINADO NO FIM por render (selection
 * derivado do display) e o loop de feedback com o retorno de seleção do
 * teclado foi REMOVIDO — era ele que fazia a barra "pular" durante a
 * digitação no Android (seleção obsoleta aplicada depois do novo texto).
 * Agora a digitação é estável, sempre da direita para a esquerda.
 */

import React from 'react';
import { Text, TextInput, View } from 'react-native';
import { theme } from '../theme';
import { formatCentsInput } from '../lib/money';

/** Teto da regra: R$ 999.999.999,00 (9 dígitos inteiros + 2 centavos). */
const MAX_CENTS = 999_999_999_00;
/** 9 inteiros + 2 decimais = 11 dígitos no máximo. */
const MAX_DIGITS = 11;

/** Dígitos -> centavos (com teto). "150000" -> 1.500,00 = 150000 cents. */
function digitsToCents(digits: string): number {
  if (!digits) return 0;
  const value = parseInt(digits, 10);
  if (!Number.isFinite(value)) return 0;
  return Math.min(value, MAX_CENTS);
}

/** Extrai o estado de digitação a partir de qualquer texto digitado/vindo do teclado. */
function digitsFromText(v: string): string {
  return v.replace(/\D/g, '');
}

export function MoneyInput({ label, cents, onChangeCents, autoFocus, accentTextClass }: {
  label: string;
  /** Valor em centavos (fonte única — ARQ-001). */
  cents: number;
  onChangeCents: (cents: number) => void;
  autoFocus?: boolean;
  /** Classe text-* do prefixo R$ (segue a cor do tipo — v7.0.3). */
  accentTextClass?: string;
}) {
  /** Estado interno: SOMENTE os dígitos digitados (direita -> esquerda). */
  const [digits, setDigits] = React.useState<string>(() => (cents > 0 ? String(cents) : ''));
  const display = formatCentsInput(digitsToCents(digits));
  // v16 (melhoria 5): cursor PINADO no fim — derivado do display a cada render,
  // sem estado de seleção e sem feedback do teclado (fonte do pulo).
  const endSelection = React.useMemo(() => ({ start: display.length, end: display.length }), [display]);

  // Sincroniza com mudanças EXTERNAS do valor (ex.: prefill ao editar/duplicar)
  const lastReported = React.useRef(cents);
  React.useEffect(() => {
    if (cents !== lastReported.current) {
      lastReported.current = cents;
      setDigits(cents > 0 ? String(cents) : '');
    }
  }, [cents]);

  const commit = (nextDigits: string) => {
    // Teto: 11 dígitos (999.999.999,00) — excedentes são descartados
    const capped = nextDigits.replace(/^0+(?=\d)/, '').slice(0, MAX_DIGITS);
    const nextCents = digitsToCents(capped);
    setDigits(capped);
    lastReported.current = nextCents;
    onChangeCents(nextCents);
  };

  const handleChange = (v: string) => {
    const incoming = digitsFromText(v);
    const previous = digits;
    if (incoming === previous) return; // nada mudou (ex.: digitação de separador)
    if (incoming.length > previous.length && incoming.startsWith(previous)) {
      // Dígitos ADICIONADOS à direita: empurra os centavos (right-to-left)
      commit(previous + incoming.slice(previous.length));
      return;
    }
    if (incoming.length < previous.length && previous.startsWith(incoming)) {
      // BACKSPACE: remove o último dígito da direita
      commit(incoming);
      return;
    }
    // Edição arbitrária (colar/seleção): reconstrói a partir dos dígitos recebidos
    commit(incoming);
  };

  return (
    <View className="gap-1">
      <Text className={`text-sm font-medium ${theme.textMuted}`}>{label}</Text>
      {/* v22 (melhoria 1): caixa de valor com ALTURA FIXA — o ícone de QR Code
          (e qualquer elemento lateral) alinha perfeitamente ao CENTRO da caixa */}
      <View className={`${theme.surface} ${theme.border} border rounded-xl px-3 h-[52px] flex-row items-center`}>
        <Text className={`text-lg font-bold mr-2 ${accentTextClass ?? theme.primaryText}`}>R$</Text>
        <TextInput
          className={`${theme.text} text-xl flex-1`}
          value={display}
          onChangeText={handleChange}
          selection={endSelection}
          placeholder="0,00"
          placeholderTextColor="#94a3b8"
          keyboardType="number-pad"
          autoFocus={autoFocus}
          contextMenuHidden
          accessibilityLabel={label}
        />
      </View>
    </View>
  );
}
