/** v26 — fila global de cargas de dados (ver useDataEffect). Lógica pura, testável. */

let loadQueue: Promise<void> = Promise.resolve();

/** Enfileira uma carga (uma por vez). Trava de segurança: uma carga que nunca
 *  termina libera a fila após `maxMs` para não congelar as demais telas. */
export function enqueueLoad(run: () => Promise<void>, maxMs = 20000): Promise<void> {
  const task = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, maxMs);
      run().then(
        () => { clearTimeout(timer); resolve(); },
        () => { clearTimeout(timer); resolve(); }
      );
    });
  loadQueue = loadQueue.then(task, task);
  return loadQueue;
}

