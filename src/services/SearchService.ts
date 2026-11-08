// v46 — SearchService (só lógica, sem mexer em tela)
// Busca por descrição com LIKE + índice. Fluxo pode chamar sem mudar layout.
import type { DbDriver } from '../db/types';
export interface SearchHit { id: string; description: string; amount_cents: number; occurred_on: string; type: string; status: string; }
export class SearchService {
  constructor(private db: DbDriver) {}
  /** v46 #6 — busca com paginação (v46 #8: LIMIT 50).
   *  v63.1: % e _ do usuário casam LITERALMENTE (escapados com ESCAPE) —
   *  antes eram REMOVIDOS da busca ("100%_teste" virava "100teste" e nunca achava). */
  async searchTransactions(q: string, limit = 50, offset = 0): Promise<SearchHit[]> {
    const like = `%${q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    return this.db.getAllAsync<SearchHit>(
      `SELECT id, description, amount_cents, occurred_on, type, status FROM transactions WHERE status != 'VOIDED' AND description LIKE ? ESCAPE '\\' ORDER BY occurred_on DESC LIMIT ? OFFSET ?`,
      [like, limit, offset]
    );
  }
  /** v46 #8 — paginação genérica para Fluxo: 50 por vez, sem carregar o mês inteiro. */
  async listFlowPage(month: string, limit = 50, offset = 0) {
    const start = `${month}-01`;
    // last day calc simplificado — o chamador passa month YYYY-MM
    return this.db.getAllAsync(
      `SELECT * FROM transactions WHERE occurred_on >= ? AND occurred_on < date(?, '+1 month') AND status != 'VOIDED' ORDER BY occurred_on DESC, id DESC LIMIT ? OFFSET ?`,
      [start, start, limit, offset]
    );
  }
}
