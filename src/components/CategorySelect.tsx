/**
 * CategorySelect (v8) — seletor de categoria/subcategoria PADRONIZADO.
 *
 * REGRA GERAL DE DADOS/DESIGN (v8):
 *  - O campo de categoria SEMPRE traz, dinamicamente, as categorias cadastradas
 *    para o tipo de operação selecionado:
 *      · Débito (despesa)  -> categorias de DÉBITO (vermelho)
 *      · Crédito (receita) -> categorias de CRÉDITO (verde)
 *      · 'ANY'             -> todas (usado na "Categoria (opcional)" do grupo)
 *  - Mesmo pictograma e mesma hierarquia (Pai › Sub) em TODAS as telas —
 *    proibido conceito duplo.
 */

import React from 'react';
import { Select } from './ui';
import { ICONS } from '../theme/icons';
import { categoryMatchesFilter } from '../lib/categories';

export interface CategoryOption {
  id: string;
  name: string;
  parent_id: string | null;
  icon: string | null;
  direction: string | null;
}

export type CategoryFilter = 'DEBIT' | 'CREDIT' | 'ANY';

const iconOf = (c: CategoryOption) => c.icon ?? ICONS.categorias;

/**
 * v67 (BUG 5) — o critério de direção vive em src/lib/categories.ts (puro,
 * testável sem React Native); aqui fica só o RE-EXPORT para as telas.
 */
export { categoryMatchesFilter } from '../lib/categories';

/** Constrói os itens hierárquicos (Pai › Sub) já filtrados pela direção. */
export function buildCategoryItems(cats: CategoryOption[], filter: CategoryFilter): Array<{ id: string; label: string }> {
  const matches = (c: CategoryOption): boolean => categoryMatchesFilter(c, filter);
  const parents = cats
    .filter((c) => !c.parent_id && matches(c))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const items: Array<{ id: string; label: string }> = [];
  for (const p of parents) {
    items.push({ id: p.id, label: `${iconOf(p)} ${p.name}` });
    const subs = cats
      .filter((c) => c.parent_id === p.id && matches(c))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    for (const s of subs) {
      items.push({ id: s.id, label: `${iconOf(s)} ${p.name} › ${s.name}` });
    }
  }
  return items;
}

export function CategorySelect({ label, categories, value, onChange, filter, allowEmpty, emptyLabel }: {
  label: string;
  /** Lista completa de categorias (carregada do banco — nunca estática). */
  categories: CategoryOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  /** Direção da operação: DEBIT (despesa), CREDIT (receita) ou ANY (todas). */
  filter: CategoryFilter;
  allowEmpty?: boolean;
  emptyLabel?: string;
}) {
  const items = React.useMemo(() => buildCategoryItems(categories, filter), [categories, filter]);
  return (
    <Select
      label={label}
      items={items}
      selectedId={value}
      onSelect={onChange}
      allowEmpty={allowEmpty}
      emptyLabel={emptyLabel}
    />
  );
}
