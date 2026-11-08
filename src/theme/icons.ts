/**
 * MAPA ÚNICO DE PICTOGRAMAS (v7.1 — regra geral de design).
 *
 * REGRA: todo ícone do app vem daqui. É proibido usar emoji/glyph inline
 * nas telas — a mesma funcionalidade/categoria usa SEMPRE o mesmo pictograma.
 */

export const ICONS = {
  // Navegação (rodapé)
  lancamento: '➕',
  fluxo: '≡',
  cadastro: '🗂️',
  ajustes: '⚙️',

  // Tipos de lançamento / direção do dinheiro
  despesa: '💸', // débito — dinheiro que sai
  receita: '💰', // crédito — dinheiro que entra
  transferencia: '⇄',
  consolidado: '🗃️', // operação agrupada (créditos + débitos)

  // Modalidade
  avista: '💵',
  fixo: '📌',
  parcelado: '📦',
  parcelas: '📦',

  // Cadastro
  contas: '🏦',
  cartoes: '💳',
  categorias: '🏷️',
  produtos: '🧺',
  fatura: '🧾',

  // Ações rápidas / integrações
  nfce: '📷',
  ofx: '📥',
  despensa: '🧺',
  recorrencias: '🔁',
  // v42 — Orçamentos e Poupança
  orcamento: '📊',
  poupanca: '🐷',

  // v69 — Mensagens bancárias e Lista de Desejos
  mensagens: '💬',
  listaDesejos: '⭐',
  reserva: '🎁',

  // Utilitários
  expandir: '▸',
  recolher: '▾',
  excluir: '🗑️',
  editar: '✏️',
  check: '✓',
  voltar: '‹',
  avancar: '›',
  // v8 — padrão único em todas as telas
  calendario: '📅',
  arquivar: '🗄️',
  inicio: '🏠',
  limite: '📏',
  contaDoGrupo: '🏦',
} as const;

/** Pictogramas disponíveis para categorias/subcategorias (tela Cadastro > Categorias). */
export const CATEGORY_ICON_OPTIONS: string[] = [
  '🛒', // mercado
  '🍽️', // alimentação
  '🚗', // transporte
  '🏠', // moradia
  '🏥', // saúde
  '🎓', // educação
  '🎮', // lazer
  '🛍️', // compras
  '🔧', // serviços
  '🐶', // pets
  '📱', // tecnologia/assinaturas
  '💡', // contas de consumo
  '💧', // água
  '📺', // streaming
  '🎂', // datas especiais
  '⛽', // combustível
  '✈️', // viagem
  '🏋️', // academia
  '💼', // trabalho
  '📌', // fixo genérico
];

/** Normaliza direção da categoria (coluna categories.direction — migração v3). */
export type CategoryDirection = 'DEBIT' | 'CREDIT' | 'BOTH';

export function categoryDirectionLabel(dir: string | null | undefined): string {
  switch (dir) {
    case 'DEBIT':
      return 'Débito';
    case 'CREDIT':
      return 'Crédito';
    default:
      return 'Ambos';
  }
}

/** Uma categoria pode ser oferecida para o tipo de lançamento informado? */
export function categoryMatchesKind(direction: string | null | undefined, kind: 'EXPENSE' | 'INCOME' | 'TRANSFER' | 'CONSOLIDATED'): boolean {
  if (kind === 'TRANSFER') return false;
  if (!direction || direction === 'BOTH') return true;
  if (kind === 'EXPENSE' || kind === 'CONSOLIDATED') return direction === 'DEBIT';
  return direction === 'CREDIT';
}
