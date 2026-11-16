/**
 * Store global (Zustand) — controle de refresh pós-mutação e estado simples de UI.
 * Dados de negócio NÃO moram aqui: telas leem dos services (ARQ-001).
 */

import { create } from 'zustand';

interface AppState {
  /** Incrementado a cada mutação — telas usam como dependência de refresh. */
  dataVersion: number;
  bump: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  dataVersion: 0,
  bump: () => set((state) => ({ dataVersion: state.dataVersion + 1 })),
}));
