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
 *
 * v86 — CARGA SÓ QUANDO PRECISA:
 *  O Stack do expo-router mantém as telas anteriores MONTADAS (só a de cima
 *  está em foco). Antes, cada `bump()` de dados disparava a carga de TODAS as
 *  telas montadas — e o Fluxo ainda somava um `focusTick` do useFocusEffect,
 *  resultando em duas cargas completas a cada volta.
 *  Agora:
 *   · tela FORA DE FOCO não recarrega nada (ela recarrega ao ganhar foco);
 *   · a mesma `dataVersion` (e as mesmas deps, ex.: mês) não é recarregada
 *     duas vezes — voltar para uma tela sem mudanças é instantâneo;
 *   · cargas pedidas no mesmo instante (bump + foco) são agrupadas (30 ms)
 *     numa única carga.
 */

import React from 'react';
import { useFocusEffect } from 'expo-router';
import { getServices, type Services } from '../services';
import { useAppStore } from '../store/appStore';
import { enqueueLoad } from '../lib/loadQueue';
import { startLoad } from '../lib/perf';

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
export function useDataEffect(
  fn?: (services: Services, isCurrent: IsCurrent) => void | Promise<void>,
  deps: unknown[] = [],
  /** v86: nome da tela para a linha de tempo do `[perf]` em desenvolvimento. */
  label?: string
) {
  const services = useServices();
  const dataVersion = useAppStore((s) => s.dataVersion);
  // Foco da tela via API pública do expo-router (não depende de pacote transitivo).
  const [isFocused, setIsFocused] = React.useState(true);
  useFocusEffect(
    React.useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, [])
  );
  // Número da carga mais recente pedida para ESTA tela (bump/foco/mudança de deps).
  const runRef = React.useRef(0);
  // O que esta tela já carregou com sucesso (evita recarga repetida).
  const loadedVersionRef = React.useRef<number | null>(null);
  const loadedKeyRef = React.useRef<string | null>(null);
  // Função de carga sempre atual, sem re-disparar o efeito a cada render.
  const fnRef = React.useRef(fn);
  fnRef.current = fn;
  // Assinatura das deps (são valores simples: mês, tick de foco...).
  const depsKey = JSON.stringify(deps);

  React.useEffect(() => {
    if (!isFocused) return; // tela fora de foco: nada de carga
    if (loadedVersionRef.current === dataVersion && loadedKeyRef.current === depsKey) return;

    const myRun = ++runRef.current;
    let alive = true;
    const isCurrent: IsCurrent = () => alive && myRun === runRef.current;

    // v86: agrupa pedidos que chegam juntos (bump + foco) numa carga só.
    const timer = setTimeout(() => {
      enqueueLoad(async () => {
        const perf = startLoad(label ?? 'tela');
        try {
          await services.ready;
          if (!isCurrent()) return;
          if (fnRef.current) await fnRef.current(services, isCurrent);
          if (isCurrent()) {
            loadedVersionRef.current = dataVersion;
            loadedKeyRef.current = depsKey;
          }
          perf.end();
        } catch (err) {
          // Uma carga que falha NUNCA deixa a tela em estado velho travado:
          // registra e deixa a próxima carga (bump/foco) recompor tudo.
          loadedVersionRef.current = null;
          if (isCurrent()) {
            console.warn('[useDataEffect] carga de dados falhou:', err);
          }
        }
      });
    }, 30);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion, isFocused, services, depsKey]);

  return services;
}
