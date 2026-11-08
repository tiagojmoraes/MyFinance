/**
 * SettingsService (v9) — preferências do usuário PERSISTIDAS no banco (app_settings).
 * Regra geral do app: nada de estado estático de tela — tudo que sobrevive ao
 * reinício mora no SQLite. Chaves conhecidas:
 *   - fluxo_saldo_por_dia ('0'|'1'): exibe o saldo acumulado do dia em cada
 *     agrupamento de datas na tela Fluxo (Ajustes > Preferências).
 */

import type { DbDriver } from '../db/types';

export class SettingsService {
  constructor(private db: DbDriver) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ value: string | null }>(
      'SELECT value FROM app_settings WHERE key = ?',
      [key]
    );
    return row?.value ?? null;
  }

  async getBool(key: string, fallback = false): Promise<boolean> {
    const raw = await this.get(key);
    if (raw == null) return fallback;
    return raw === '1';
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
  }

  async setBool(key: string, value: boolean): Promise<void> {
    await this.set(key, value ? '1' : '0');
  }
}

/** Chaves centralizadas (mapa único — mesma convenção dos ícones). */
export const SETTING_KEYS = {
  fluxoSaldoPorDia: 'fluxo_saldo_por_dia',
  /** v33: provedor do serviço de leitura de NFC-e ('none' | 'scrapingbee' | 'scraperapi'). */
  nfceReaderProvider: 'nfce_reader_provider',
  /** v33: chave da API do serviço de leitura — fica SOMENTE no aparelho do usuário. */
  nfceReaderApiKey: 'nfce_reader_apikey',
  /** v40: histórico das últimas entradas NFC-e (JSON array) — fim da digitação. */
  nfceRecentInputs: 'nfce_recent_inputs',
  /** v42: flag ORÇAMENTOS — liga a ação "Orçamento" na tela inicial e o card no Fluxo. */
  budgetsAtivado: 'orcamentos_ativado',
  /** v42: flag POUPANÇA — liga a ação "Poupança" na tela inicial e o card no Fluxo. */
  poupancaAtivado: 'poupanca_ativado',
  /** v68: atalho NFC-e na tela inicial (Ações rápidas) — ligado por padrão. */
  nfceNaHome: 'nfce_na_home',
  /** v68: atalho OFX na tela inicial (Ações rápidas) — ligado por padrão. */
  ofxNaHome: 'ofx_na_home',
  /** v68: atalho Despensa na tela inicial (Ações rápidas) — ligado por padrão. */
  despensaNaHome: 'despensa_na_home',
  /** v69: atalho Mensagens bancárias na tela inicial (Ações rápidas). */
  mensagensNaHome: 'mensagens_na_home',
  /** v69: atalho Lista de Desejos na tela inicial (Ações rápidas). */
  wishlistNaHome: 'wishlist_na_home',
} as const;
