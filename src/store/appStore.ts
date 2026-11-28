/**
 * Store global (Zustand) — controle de refresh pós-mutação e estado simples de UI.
 * Dados de negócio NÃO moram aqui: telas leem dos services (ARQ-001).
 */

import { create } from 'zustand';
import type { FlowEntry, ItemFluxo } from '../lib/flowModel';

interface AppState {
  /** Incrementado a cada mutação — telas usam como dependência de refresh. */
  dataVersion: number;
  bump: () => void;
  flowMonth: string | null;
  flowItems: ItemFluxo<FlowEntry>[];
  flowOpeningBalanceCents: number | null;
  setFlowSnapshot: (month: string, items: ItemFluxo<FlowEntry>[], openingBalanceCents: number) => void;
  setFlowItems: (items: ItemFluxo<FlowEntry>[]) => void;
  updateFlowItems: (update: (items: ItemFluxo<FlowEntry>[]) => ItemFluxo<FlowEntry>[]) => void;
}

export const useAppStore = create<AppState>((set) => ({
  dataVersion: 0,
  bump: () => set((state) => ({ dataVersion: state.dataVersion + 1 })),
  flowMonth: null,
  flowItems: [],
  flowOpeningBalanceCents: null,
  setFlowSnapshot: (flowMonth, flowItems, flowOpeningBalanceCents) =>
    set({ flowMonth, flowItems, flowOpeningBalanceCents }),
  setFlowItems: (flowItems) => set({ flowItems }),
  updateFlowItems: (update) => set((state) => ({ flowItems: update(state.flowItems) })),
}));
