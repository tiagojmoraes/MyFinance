/** Componentes base do design system (NativeWind). */

import React from 'react';
import {
  View, Text, TextInput, Pressable, ActivityIndicator, ScrollView, Modal, Switch,
} from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme, STATUS_LABELS } from '../theme';
import {
  ymdToBr, todaySP, monthOf, monthAdd, monthLabel, partsOf, makeYmd,
  firstDayOf, lastDayOfMonth, type Ym,
} from '../lib/dates';
import { ICONS } from '../theme/icons';
import { Footer } from './Footer';

/** Telas "raiz" (rodapé + início): não mostram o botão Voltar. */
const MAIN_SCREENS = ['/', '/lancamento', '/fluxo', '/cadastro', '/ajustes'];

export function Screen({ title, subtitle, children, action, accent, accentTextClass, footerArea, headerArea, scrollable = true }: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  /** Classe bg-* de acento: pinta a barra sob o header e o subtítulo (tema por tipo — v7.0.3). */
  accent?: string;
  /** Classe text-* aplicada ao subtítulo quando `accent` está presente. */
  accentTextClass?: string;
  /** Conteúdo FIXO acima do rodapé (não rola junto com a lista). */
  footerArea?: React.ReactNode;
  /** v10: conteúdo FIXO abaixo do cabeçalho (ex.: saldo consolidado + seletor de mês do Fluxo) —
   *  fica preso no layout e não some quando a lista rola. */
  headerArea?: React.ReactNode;
  /** Desativa o ScrollView interno quando o conteúdo já é virtualizado. */
  scrollable?: boolean;
}) {
  const pathname = usePathname() ?? '/';
  const insets = useSafeAreaInsets();
  const isMain = MAIN_SCREENS.includes(pathname);
  return (
    <View className={`flex-1 ${theme.bg}`}>
      <View
        className={`px-4 pb-3 ${theme.surface} ${theme.border} border-b`}
        // v8: respeita a safe area SUPERIOR (notch/status bar) em qualquer aparelho
        style={{ paddingTop: Math.max(insets.top, 12) + 8 }}
      >
        <View className="flex-row items-center justify-between gap-2">
          <View className="flex-row items-center flex-1 gap-2">
            {/* v8: botão VOLTAR padrão (mesmo pictograma em todas as telas internas) */}
            {!isMain ? (
              <Pressable
                onPress={() => {
                  if (router.canGoBack()) router.back();
                  else router.replace('/');
                }}
                accessibilityRole="button"
                accessibilityLabel="Voltar para a tela principal"
                /* v16 (melhoria 2): área de toque maior — alvo mínimo de 44px
                   (HIG) + hitSlop extra, para voltar sem errar o toque */
                hitSlop={8}
                className="bg-slate-100 rounded-xl min-w-[44px] min-h-[44px] px-3 py-2.5 items-center justify-center"
              >
                <Text className="text-2xl font-bold text-slate-600 leading-7">{ICONS.voltar}</Text>
              </Pressable>
            ) : null}
            <View className="flex-1">
              <Text className={`text-2xl font-bold ${theme.text}`}>{title}</Text>
              {subtitle ? (
                <Text className={`text-sm mt-0.5 font-semibold ${accentTextClass ?? theme.textMuted}`}>{subtitle}</Text>
              ) : null}
            </View>
          </View>
          {action}
        </View>
      </View>
      {accent ? <View className={`h-1.5 ${accent}`} /> : null}
      {/* v10: área fixa abaixo do cabeçalho (não rola) — saldo consolidado + seletor de mês */}
      {headerArea ? <View className="px-4 pt-3 gap-2">{headerArea}</View> : null}
      {scrollable ? (
        <ScrollView className="flex-1" contentContainerClassName="px-4 pt-4 pb-8 gap-3">
          {children}
        </ScrollView>
      ) : (
        <View className="flex-1">{children}</View>
      )}
      {/* v9: área fixa acima do rodapé (não rola) — cards de saldo do Fluxo */}
      {footerArea ? (
        <View className={`${theme.surface} border-t ${theme.border} px-3 pt-2.5 pb-1.5 gap-1.5`}>
          {footerArea}
        </View>
      ) : null}
      {/* v7.1: rodapé de navegação em todas as telas (Lançamento · Fluxo · Cadastro · Ajustes) */}
      <Footer />
    </View>
  );
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <View className={`${theme.surface} ${theme.border} border rounded-2xl p-4 ${className}`}>
      {children}
    </View>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text className={`text-sm font-semibold uppercase tracking-wide ${theme.textMuted} mt-2`}>{children}</Text>;
}

export function Button({ label, onPress, variant = 'primary', disabled, loading, bg, outlineClass, outlineTextClass }: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'outline' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  /** Override da classe bg-* do variant primary (tema por tipo — v7.0.3). */
  bg?: string;
  /** v68: override do esqueleto do variant OUTLINE (fundo escuro do scanner —
   *  o "Colar e consultar" ficava preto no preto e o usuário não via). */
  outlineClass?: string;
  /** v68: override da cor do TEXTO do variant OUTLINE. */
  outlineTextClass?: string;
}) {
  const styles: Record<string, string> = {
    primary: `${bg ?? theme.primary} border-0`,
    outline: outlineClass ?? `bg-transparent border ${theme.border}`,
    danger: `${theme.danger} border-0`,
    ghost: 'bg-transparent border-0',
  };
  const textStyles: Record<string, string> = {
    primary: 'text-white',
    outline: outlineTextClass ?? theme.text,
    danger: 'text-white',
    ghost: theme.primaryText,
  };
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      className={`rounded-xl px-4 py-3 items-center justify-center ${styles[variant]} ${disabled ? 'opacity-50' : ''}`}
    >
      {loading ? (
        <ActivityIndicator color="#ffffff" />
      ) : (
        <Text className={`text-base font-semibold ${textStyles[variant]}`}>{label}</Text>
      )}
    </Pressable>
  );
}

export function TextField({ label, value, onChangeText, placeholder, keyboardType, multiline, autoCapitalize, autoCorrect, autoFocus }: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'decimal-pad';
  multiline?: boolean;
  /** v33: teclado "de dados" (chaves de API, e-mails) — sem maiúscula automática. */
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  /** v68: foco automático (ex.: campo da subcategoria inline). */
  autoFocus?: boolean;
}) {
  return (
    <View className="gap-1">
      <Text className={`text-sm font-medium ${theme.textMuted}`}>{label}</Text>
      <TextInput
        className={`${theme.surface} ${theme.border} border rounded-xl px-3 py-2.5 ${theme.text} text-base`}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#94a3b8"
        keyboardType={keyboardType}
        multiline={multiline}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        autoFocus={autoFocus}
      />
    </View>
  );
}

export function Select<T extends { id: string; label: string }>({ label, items, selectedId, onSelect, allowEmpty, emptyLabel }: {
  label: string;
  items: T[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = items.find((i) => i.id === selectedId);
  return (
    <View className="gap-1">
      <Text className={`text-sm font-medium ${theme.textMuted}`}>{label}</Text>
      <Pressable
        onPress={() => setOpen(true)}
        className={`${theme.surface} ${theme.border} border rounded-xl px-3 py-2.5 flex-row items-center justify-between`}
      >
        <Text className={`${selected ? theme.text : theme.textMuted} text-base`}>
          {selected ? selected.label : (emptyLabel ?? 'Selecione...')}
        </Text>
        <Text className={theme.textMuted}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable className="flex-1 bg-black/40 justify-end" onPress={() => setOpen(false)}>
          <View className={`${theme.surface} rounded-t-3xl max-h-[70%] pb-8`}>
            <Text className={`text-lg font-bold px-4 py-3 ${theme.text}`}>{label}</Text>
            <ScrollView className="px-2">
              {allowEmpty ? (
                <OptionRow
                  label={emptyLabel ?? '— nenhum —'}
                  active={selectedId == null}
                  onPress={() => { onSelect(null); setOpen(false); }}
                />
              ) : null}
              {items.map((item) => (
                <OptionRow
                  key={item.id}
                  label={item.label}
                  active={item.id === selectedId}
                  onPress={() => { onSelect(item.id); setOpen(false); }}
                />
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function OptionRow({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className={`px-4 py-3 rounded-xl flex-row justify-between items-center ${active ? theme.primarySoft : ''}`}
    >
      <Text className={`text-base ${active ? theme.primaryText : theme.text} font-medium`}>{label}</Text>
      {active ? <Text className={theme.primaryText}>✓</Text> : null}
    </Pressable>
  );
}

export function Badge({ status, className = '' }: { status: string; className?: string }) {
  const style = (require('../theme') as typeof import('../theme')).statusStyles[status] ?? theme.surfaceAlt;
  const label = STATUS_LABELS[status] ?? status;
  return (
    <View className={`px-2 py-0.5 rounded-full self-start ${style} ${className}`}>
      <Text className="text-xs font-semibold">{label}</Text>
    </View>
  );
}

/**
 * Bolinha preta com "✓" branco no centro — marca visual de CONTA FIXA.
 * Aparece em toda transação gerada por regra de recorrência (receita ou despesa)
 * e nas próprias regras, para o usuário reconhecer de imediato o lançamento fixo.
 */
export function FixedDot({ size = 18 }: { size?: number }) {
  return (
    <View
      className="rounded-full bg-black items-center justify-center"
      style={{ width: size, height: size }}
    >
      <Text className="text-white font-bold leading-none" style={{ fontSize: Math.round(size * 0.58) }}>
        ✓
      </Text>
    </View>
  );
}

/**
 * Etiqueta preta com letras brancas — "parcela atual / total" (ex.: 3/12).
 * Exibida em TUDO que for parcelado: itens da fatura, fluxo, planos e visão dual.
 */
export function InstallmentPill({ current, total, className = '' }: {
  current: number;
  total: number;
  className?: string;
}) {
  const seq = Math.min(Math.max(1, current), Math.max(1, total));
  return (
    <View className={`bg-black rounded-md px-1.5 py-0.5 self-start ${className}`}>
      <Text className="text-white text-[10px] font-bold leading-tight tracking-wide">
        {seq}/{total}
      </Text>
    </View>
  );
}

/**
 * v42 — BARRA DE PROGRESSO (conclusão do orçamento, progresso da poupança).
 * pct 0-100+ (o excesso não passa da barra); tom por situação:
 *  ok (verde, até 75%) · warn (âmbar, 75-100%) · over (vermelho, estourou).
 */
export function ProgressBar({ pct, className = '' }: { pct: number; className?: string }) {
  const w = Math.max(0, Math.min(100, pct));
  const tone = pct > 100 ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <View className={`h-2 bg-slate-100 rounded-full overflow-hidden ${className}`}>
      <View className={`h-full rounded-full ${tone}`} style={{ width: `${w}%` }} />
    </View>
  );
}

/**
 * Ícone de QR Code desenhado com Views (sem dependência extra de ícones).
 * Usado no atalho "Ler NFC-e" do lançamento e no scanner da tela NFC-e.
 */
export function QrGlyph({ size = 24, color = '#ffffff' }: { size?: number; color?: string }) {
  // Padrão 7x7 com os três "finder patterns" de canto, lembrando um QR real.
  const pattern = [
    [1, 1, 1, 0, 1, 1, 1],
    [1, 0, 1, 0, 1, 0, 1],
    [1, 1, 1, 0, 1, 1, 1],
    [0, 0, 0, 1, 0, 0, 0],
    [1, 1, 1, 0, 1, 0, 0],
    [1, 0, 1, 0, 0, 1, 0],
    [1, 1, 1, 0, 1, 0, 1],
  ];
  const cell = size / 7;
  return (
    <View style={{ width: size, height: size, flexDirection: 'column' }}>
      {pattern.map((row, r) => (
        <View key={r} style={{ flexDirection: 'row', height: cell }}>
          {row.map((on, c) => (
            <View
              key={c}
              style={{
                width: cell,
                height: cell,
                backgroundColor: on ? color : 'transparent',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

export function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <View className="items-center py-10 gap-2">
      <Text className="text-4xl">{icon}</Text>
      <Text className={`text-base font-semibold ${theme.text}`}>{title}</Text>
      {hint ? <Text className={`text-sm text-center px-8 ${theme.textMuted}`}>{hint}</Text> : null}
    </View>
  );
}

export function KeyValue({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <View className="flex-row justify-between py-1">
      <Text className={`${theme.textMuted} text-sm`}>{k}</Text>
      <Text className={`${bold ? 'font-bold' : 'font-medium'} ${theme.text} text-sm`}>{v}</Text>
    </View>
  );
}

/**
 * CALENDÁRIO (v8) — seletor de data em pt-BR, semana iniciando no domingo.
 * Abre obrigatoriamente ao tocar em qualquer campo de data; traz hoje como padrão.
 */
const WEEK_DAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

export function CalendarModal({ visible, onClose, value, onSelect }: {
  visible: boolean;
  onClose: () => void;
  value: string | null;
  onSelect: (ymd: string) => void;
}) {
  const [viewYm, setViewYm] = React.useState<Ym>(monthOf(value ?? todaySP()));
  React.useEffect(() => {
    if (visible) setViewYm(monthOf(value ?? todaySP()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const { y, m } = partsOf(firstDayOf(viewYm));
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = lastDayOfMonth(y, m);
  const cells: (number | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const today = todaySP();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/40 items-center justify-center px-6" onPress={onClose}>
        <Pressable className={`${theme.surface} rounded-2xl p-4 w-full`} onPress={() => {}} accessibilityLabel="Calendário">
          <View className="flex-row items-center justify-between mb-2">
            <Pressable onPress={() => setViewYm(monthAdd(viewYm, -1))} className="bg-slate-100 rounded-lg px-3 py-1.5">
              <Text className="font-bold text-slate-600 text-base">{ICONS.voltar}</Text>
            </Pressable>
            <Text className={`text-base font-bold ${theme.text}`}>{monthLabel(viewYm)}</Text>
            <Pressable onPress={() => setViewYm(monthAdd(viewYm, 1))} className="bg-slate-100 rounded-lg px-3 py-1.5">
              <Text className="font-bold text-slate-600 text-base">{ICONS.avancar}</Text>
            </Pressable>
          </View>
          <View className="flex-row mb-1">
            {WEEK_DAYS.map((d, i) => (
              <Text key={`wd-${i}`} className="flex-1 text-center text-[11px] font-semibold text-slate-400">{d}</Text>
            ))}
          </View>
          {Array.from({ length: cells.length / 7 }, (_, w) => (
            <View key={`w-${w}`} className="flex-row">
              {cells.slice(w * 7, w * 7 + 7).map((day, i) => {
                if (day == null) return <View key={`e-${w}-${i}`} className="flex-1 h-10" />;
                const ymd = makeYmd(y, m, day);
                const selected = value === ymd;
                const isToday = today === ymd;
                return (
                  <Pressable
                    key={`d-${w}-${i}`}
                    onPress={() => { onSelect(ymd); onClose(); }}
                    className={`flex-1 h-10 items-center justify-center rounded-lg mx-0.5 ${
                      selected ? 'bg-emerald-600' : isToday ? 'bg-emerald-50' : ''
                    }`}
                  >
                    <Text
                      className={`text-sm font-semibold ${
                        selected ? 'text-white' : isToday ? 'text-emerald-700' : theme.text
                      }`}
                    >
                      {day}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
          <View className="flex-row justify-between items-center mt-3">
            <Pressable
              onPress={() => { onSelect(today); onClose(); }}
              className="bg-emerald-50 rounded-lg px-3 py-2"
            >
              <Text className="text-emerald-700 font-semibold text-sm">Hoje</Text>
            </Pressable>
            <Pressable onPress={onClose} className="bg-slate-100 rounded-lg px-3 py-2">
              <Text className="text-slate-500 font-semibold text-sm">Cancelar</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * Campo de data (v8): ao TOCAR abre obrigatoriamente o CALENDÁRIO.
 * O valor default das telas continua sendo HOJE; o formato exibido é pt-BR dd/mm/aaaa.
 * O valor trafegado continua sendo 'YYYY-MM-DD' (formato interno do banco).
 */
export function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <View className="gap-1">
      <Text className={`text-sm font-medium ${theme.textMuted}`}>{label}</Text>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label}: abrir calendário`}
        className={`${theme.surface} ${theme.border} border rounded-xl px-3 py-2.5 flex-row items-center justify-between`}
      >
        <Text className={`${theme.text} text-base ${value ? '' : 'opacity-40'}`}>
          {value ? ymdToBr(value) : 'dd/mm/aaaa'}
        </Text>
        <Text className="text-lg">{ICONS.calendario}</Text>
      </Pressable>
      {open ? (
        <CalendarModal
          visible
          onClose={() => setOpen(false)}
          value={value || null}
          onSelect={onChange}
        />
      ) : null}
    </View>
  );
}

/** Interruptor com rótulo (v8) — ex.: "Aparece no saldo do Fluxo" em Contas. */
export function ToggleRow({ label, description, value, onChange }: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View className="flex-row items-center justify-between gap-3 py-1">
      <View className="flex-1">
        <Text className={`text-sm font-medium ${theme.text}`}>{label}</Text>
        {description ? <Text className="text-[11px] text-slate-500 leading-4 mt-0.5">{description}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: '#e2e8f0', true: '#059669' }}
        thumbColor="#ffffff"
        accessibilityLabel={label}
      />
    </View>
  );
}

export function Segmented<T extends string>({ options, value, onChange, activeBg }: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  /** Override da classe bg-* do segmento ativo (tema por tipo — v7.0.3). */
  activeBg?: string;
}) {
  return (
    <View className={`flex-row ${theme.surface} ${theme.border} border rounded-xl p-1 gap-1`}>
      {options.map((opt) => (
        <Pressable
          key={opt.value}
          onPress={() => onChange(opt.value)}
          className={`flex-1 py-2 rounded-lg items-center ${value === opt.value ? (activeBg ?? theme.primary) : 'bg-transparent'}`}
        >
          <Text className={`text-sm font-semibold ${value === opt.value ? 'text-white' : theme.textMuted}`}>
            {opt.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
