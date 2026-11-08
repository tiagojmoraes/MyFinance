/** Tokens de tema — paleta financeira verde/esmeralda sobre neutros frios. */

export const theme = {
  bg: 'bg-slate-100',
  surface: 'bg-white',
  surfaceAlt: 'bg-slate-50',
  border: 'border-slate-200',
  text: 'text-slate-900',
  textMuted: 'text-slate-500',
  primary: 'bg-emerald-600',
  primarySoft: 'bg-emerald-50',
  primaryText: 'text-emerald-700',
  danger: 'bg-rose-600',
  dangerSoft: 'bg-rose-50',
  dangerText: 'text-rose-700',
  warnSoft: 'bg-amber-50',
  warnText: 'text-amber-700',
};

/**
 * Semântica de cores por tipo de lançamento (v7.0.3):
 *   Despesa        → VERMELHO (rose)
 *   Receita        → VERDE (emerald)
 *   Transferência  → PRETO (slate-900/black)
 *   Consolidado    → VIOLETA (violet) — v7.1: grupo com créditos + débitos
 * Usado no Novo Lançamento (segmentado + botão + barra de acento da tela)
 * e em toda lista que exibe valores por tipo.
 */
export type TxKind = 'EXPENSE' | 'INCOME' | 'TRANSFER' | 'CONSOLIDATED';

export interface KindStyle {
  label: string;
  /** Classe de fundo sólida (botão primário / segmento ativo). */
  solid: string;
  /** Cor de texto sobre fundo sólido. */
  onSolid: string;
  /** Fundo suave (chips, destaques). */
  soft: string;
  /** Texto forte sobre fundo claro. */
  softText: string;
  /** Hex para componentes que não usam Tailwind (QR, ActivityIndicator). */
  hex: string;
}

export const kindTheme: Record<TxKind, KindStyle> = {
  EXPENSE: {
    label: 'Despesa',
    solid: 'bg-rose-600',
    onSolid: 'text-white',
    soft: 'bg-rose-50',
    softText: 'text-rose-700',
    hex: '#e11d48',
  },
  INCOME: {
    label: 'Receita',
    solid: 'bg-emerald-600',
    onSolid: 'text-white',
    soft: 'bg-emerald-50',
    softText: 'text-emerald-700',
    hex: '#059669',
  },
  TRANSFER: {
    label: 'Transferência',
    solid: 'bg-black',
    onSolid: 'text-white',
    soft: 'bg-slate-100',
    softText: 'text-slate-900',
    hex: '#0f172a',
  },
  CONSOLIDATED: {
    label: 'Consolidado',
    solid: 'bg-violet-600',
    onSolid: 'text-white',
    soft: 'bg-violet-50',
    softText: 'text-violet-700',
    hex: '#7c3aed',
  },
};

export const statusStyles: Record<string, string> = {
  OPEN: 'bg-sky-50 text-sky-700',
  CLOSED: 'bg-slate-100 text-slate-600',
  PARTIALLY_PAID: 'bg-amber-50 text-amber-700',
  PAID: 'bg-emerald-50 text-emerald-700',
  OVERDUE: 'bg-rose-50 text-rose-700',
  PENDING: 'bg-amber-50 text-amber-700',
  VOIDED: 'bg-slate-100 text-slate-400 line-through',
  MATCHED_AUTO: 'bg-emerald-50 text-emerald-700',
  AMBIGUOUS: 'bg-amber-50 text-amber-700',
  NEW_TX: 'bg-sky-50 text-sky-700',
  UNPROCESSED: 'bg-slate-100 text-slate-500',
  COMPLETE: 'bg-emerald-50 text-emerald-700',
  PARTIAL: 'bg-amber-50 text-amber-700',
  FAILED: 'bg-rose-50 text-rose-700',
  HEADER_ONLY: 'bg-sky-50 text-sky-700',
  REVIEW: 'bg-violet-50 text-violet-700',
};

export const STATUS_LABELS: Record<string, string> = {
  OPEN: 'Aberta',
  CLOSED: 'Fechada',
  PARTIALLY_PAID: 'Parcialmente paga',
  PAID: 'Paga',
  OVERDUE: 'Vencida',
  PENDING: 'Pendente',
  VOIDED: 'Cancelada',
  MATCHED_AUTO: 'Conciliado',
  AMBIGUOUS: 'Ambíguo',
  NEW_TX: 'Novo lançamento',
  UNPROCESSED: 'Não processado',
  COMPLETE: 'Completa',
  PARTIAL: 'Parcial',
  FAILED: 'Falhou',
  HEADER_ONLY: 'Só cabeçalho',
  REVIEW: 'Revisar',
};
