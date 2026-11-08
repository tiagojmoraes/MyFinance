// v46 — DashboardService (só dados, ZERO layout)
// Fornece Previsto x Efetivado por dia para qualquer gráfico futuro.
// Reusa o cache do BalanceService (v44) — não recalcula.
import type { BalanceService } from './BalanceService';
export interface DashboardDay { date: string; efetivado: number; previsto: number; }
export class DashboardService {
  constructor(private balance: BalanceService) {}
  async getMonthSeries(month: string, dataVersion?: number): Promise<DashboardDay[]> {
    const dual = await this.balance.getDailyBalancesDual(month, dataVersion);
    return Object.keys(dual.efetivado).sort().map((d) => ({ date: d, efetivado: dual.efetivado[d], previsto: dual.previsto[d] }));
  }
  async getMonthTotals(month: string, dataVersion?: number) {
    const s = await this.getMonthSeries(month, dataVersion);
    const last = s[s.length-1];
    return { dias: s.length, efetivadoFinal: last?.efetivado ?? 0, previstoFinal: last?.previsto ?? 0, min: Math.min(...s.map(x=>x.efetivado)), max: Math.max(...s.map(x=>x.efetivado)) };
  }
}
