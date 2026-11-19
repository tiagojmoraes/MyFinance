/**
 * versionedCache (v98 — DESEMPENHO DO FLUXO):
 * cache por chave + `dataVersion`. Quando uma chamada traz `version`, o cache
 * devolve o valor cacheado para a MESMA versão; versão diferente → recalcula.
 * Deduplica chamadas em voo (a 2ª chamada com a mesma chave+versão espera o
 * resultado da 1ª em vez de duplicar o trabalho).
 *
 *   - Usado em serviços para memoizar `getMonthSummary`, `getMonthOverview`,
 *     `listOpen`, metodologia/projeção da Programação de Compra, etc.
 *   - Quando `version` é `undefined` (testes, ou quando a tela não conhece o
 *     bump), o cache é IGNORADO: sempre recalcula. Isso preserva o
 *     comportamento atual dos testes que mutam o banco sem chamar `bump()`.
 *   - Os valores devolvidos são compartilhados entre chamadas: quem consome
 *     deve tratá-los como imutáveis (os serviços já retornam objetos READ-ONLY).
 */

export interface CacheEntry<T> {
  version: number;
  value: T;
}

export class VersionedCache<T> {
  private map = new Map<string, CacheEntry<T>>();
  private inflight = new Map<string, Promise<T>>();

  /** Retorna o valor cacheado se a versão bate; senão chama `compute`. */
  async get(key: string, version: number | undefined, compute: () => Promise<T>): Promise<T> {
    if (typeof version !== 'number') return compute();
    const hit = this.map.get(key);
    if (hit && hit.version === version) return hit.value;
    const inflightKey = `${key}|${version}`;
    const running = this.inflight.get(inflightKey);
    if (running) return running;
    const p = compute()
      .then((value) => {
        this.map.set(key, { version, value });
        this.inflight.delete(inflightKey);
        return value;
      })
      .catch((err) => {
        this.inflight.delete(inflightKey);
        throw err;
      });
    this.inflight.set(inflightKey, p);
    return p;
  }

  /** Invalida todas as entradas com a chave dada (ex.: após uma escrita). */
  invalidate(key: string): void {
    this.map.delete(key);
  }

  /** Esvazia o cache (usado por testes). */
  clear(): void {
    this.map.clear();
    this.inflight.clear();
  }
}
