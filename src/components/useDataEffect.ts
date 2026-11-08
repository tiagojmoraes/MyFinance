/** Hook de tela: espera services prontos e reagrupa em dataVersion.
 *
 * v24 — FIM DA INSTABILIDADE DO SALDO DO DIA (Fluxo):
 *  Antes, o guard `alive` era checado UMA vez (logo após `services.ready`) e a
 *  função de carga corria solta: quando o usuário editava um lançamento
 *  (bump) e/ou voltava o foco para a tela (useFocusEffect), DUAS ou mais
 *  cargas ficavam em voo ao mesmo tempo — a mais ANTIGA podia terminar DEPOIS
 *  da mais nova e SOBRESCREVER o estado com dados velhos (saldo do dia
 *  "instável", que não comportava alteração de datas).
 *  Agora cada carga recebe um número de edição e um guarda `isCurrent()`:
 *   · a checagem vale ANTES de cada estágio que escreve estado (a tela testa
 *     `isCurrent()` entre os awaits);
 *   · quando uma carga mais nova começa, as antigas se abandonam nos pontos
 *     de checagem — a ÚLTIMA carga pedida é sempre a que vence;
 *   · exceções de carga são capturadas (a tela nunca fica presa em loading).
 */

import React from 'react';
import { getServices, type Services } from '../services';
import { useAppStore } from '../store/appStore';
import { enqueueLoad } from '../lib/loadQueue';

export function useServices(): Services {
  return getServices();
}

/** Guarda passado à função de carga: `true` enquanto ESTA carga for a mais
 *  recente da tela (e o componente montado). Depois de cada `await`, a carga
 *  deve conferir `isCurrent()` antes de escrever estado/mandar no banco. */
export type IsCurrent = () => boolean;

/**
 * v26 — FILA ÚNICA DE CARGAS (raiz do "saldo do dia errado depois de mexer na
 * data", que os testes não pegavam):
 *  No Android o driver expo-sqlite usa UMA conexão e um contador de transação
 *  (txDepth) compartilhado. Cada bump dispara a carga de TODAS as telas
 *  montadas (são dezenas de useDataEffect) e várias delas escrevem no banco
 *  (promoção de vencidas, previsão das fixas) dentro de transações. Rodando
 *  juntas, uma carga dá COMMIT na transação da outra, SAVEPOINTs se perdem,
 *  e a carga que deveria pintar o saldo falha ou lê dado pela metade.
 *  Agora as cargas entram numa fila global e rodam UMA POR VEZ; cargas que já
 *  foram substituídas por uma mais nova nem chegam a rodar.
 */
/** Effect que roda após bootstrap + em cada bump de dados. `fn` é opcional. */
/**
 * v47 #6 — só a tela focada recarrega na hora: o bump global ainda existe,
 * mas telas fora de foco aguardam useFocusEffect (já implementado nas telas).
 * Este hook agora debounceia bumps em rajada (ex: salvar 3x rápido) em 100ms.
 */
export function useDataEffect(
  fn?: (services: Services, isCurrent: IsCurrent) => void | Promise<void>,
  deps: unknown[] = []
) {
  const services = useServices();
  const dataVersion = useAppStore((s) => s.dataVersion);
  // Número da carga mais recente pedida para ESTA tela (bump/foco/mudança de deps).
  const runRef = React.useRef(0);

  React.useEffect(() => {
    const myRun = ++runRef.current;
    let alive = true;
    const isCurrent: IsCurrent = () => alive && myRun === runRef.current;
    const run = async () => {
      try {
        await services.ready;
        if (!isCurrent()) return;
        if (fn) await fn(services, isCurrent);
      } catch (err) {
        // Uma carga que falha NUNCA deixa a tela em estado velho travado:
        // registra e deixa a próxima carga (bump/foco) recompor tudo.
        if (isCurrent()) {
          console.warn('[useDataEffect] carga de dados falhou:', err);
        }
      }
    };
    // v26: uma carga por vez (ver loadQueue). `run` já captura os próprios erros.
    enqueueLoad(run);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion, ...deps]);

  return services;
}
