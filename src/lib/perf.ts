/**
 * perf — v86 (DESEMPENHO): cronômetro das cargas de tela.
 *
 * Existe para PROVAR o ganho (e achar o próximo gargalo) sem poluir o app:
 *  · só emite em desenvolvimento (`__DEV__`); em produção é praticamente
 *    no-op (duas leituras de Date.now e nada mais);
 *  · a linha sai no terminal do Metro com o nome da tela e o tempo de cada
 *    estágio — ex.: `[perf] Fluxo · lista 42ms · grupos 118ms · total 213ms`;
 *  · NUNCA lança: instrumentação não pode derrubar tela.
 *
 * Uso:
 *   const t = startLoad('Fluxo');
 *   … await algumaCoisa(); t.lap('preferências');
 *   … await outraCoisa();  t.lap('saldo do dia');
 *   t.end();                                // `total` sai no fim
 */

const ENABLED = (() => {
  try {
    return typeof __DEV__ !== 'undefined' ? !!__DEV__ : false;
  } catch {
    return false;
  }
})();

export interface LoadTimer {
  /** Fecha o estágio atual e inicia o próximo. */
  lap(label: string): void;
  /** Fecha a carga (loga o total). */
  end(extra?: string): void;
}

/** Começa a medição de uma carga de tela. `label` = nome da tela. */
export function startLoad(label: string): LoadTimer {
  const t0 = Date.now();
  let last = t0;
  const marks: string[] = [];
  const add = (name: string, ms: number) => {
    if (ms >= 1) marks.push(`${name} ${Math.round(ms)}ms`);
  };
  return {
    lap(name: string) {
      if (!ENABLED) return;
      try {
        const now = Date.now();
        add(name, now - last);
        last = now;
      } catch {
        // nunca derruba
      }
    },
    end(extra?: string) {
      if (!ENABLED) return;
      try {
        add('total', Date.now() - t0);
        const tail = extra ? ` · ${extra}` : '';
        // eslint-disable-next-line no-console
        console.log(`[perf] ${label} · ${marks.join(' · ')}${tail}`);
      } catch {
        // nunca derruba
      }
    },
  };
}
