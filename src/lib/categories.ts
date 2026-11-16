/**
 * v67 (BUG 5) — DIREÇÃO DE CATEGORIA (puro, sem React Native).
 *
 * Débito (despesa) usa categorias DEBIT e BOTH; Crédito (receita) usa CREDIT
 * e BOTH. Cada lado tem a SUA lista — e ao trocar de lado, a categoria
 * selecionada que não pertence ao novo tipo é LIMPA ( CategorySelect e
 * lancamento usam este mesmo helper — proibido conceito duplo).
 */

export type CategoryDirectionLite = 'DEBIT' | 'CREDIT' | 'BOTH' | string | null | undefined;
export type CategoryFilterLite = 'DEBIT' | 'CREDIT' | 'ANY';

/** A categoria pertence à direção pedida? (sem direção gravada = BOTH) */
export function categoryMatchesFilter(cat: { direction?: CategoryDirectionLite }, filter: CategoryFilterLite): boolean {
  if (filter === 'ANY') return true;
  const dir = cat.direction ?? 'BOTH';
  return dir === filter || dir === 'BOTH';
}

/** Direção pedida para um tipo de operação (regra geral de dados). */
export function filterForKind(kind: 'INCOME' | 'EXPENSE' | string): 'DEBIT' | 'CREDIT' | 'ANY' {
  if (kind === 'INCOME') return 'CREDIT';
  if (kind === 'EXPENSE') return 'DEBIT';
  return 'ANY';
}
