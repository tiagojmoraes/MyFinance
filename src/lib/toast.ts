/**
 * v19 — AVISOS SEM POPUP (melhoria "zero popups no sistema").
 *
 * O app NÃO usa mais Alert.alert nem modais de confirmação: toda ação
 * (salvar, excluir, duplicar, alterar, importar) executa DIRETO. O feedback
 * (sucesso/erro) passa por este canal: um aviso discreto na parte de baixo
 * da tela, que some sozinho — sem interromper, sem pedir confirmação.
 *
 * Uso nas telas:
 *   import { showToast } from '../lib/toast';
 *   showToast('Lançamento salvo');            // sucesso (padrão)
 *   showToast('Informe o valor', 'err');      // erro/validação
 *
 * O ToastHost (src/components/Toast.tsx), montado no layout raiz, registra
 * o listener e renderiza os avisos.
 */

export type ToastKind = 'ok' | 'err';
type Listener = (message: string, kind: ToastKind) => void;

let listener: Listener | null = null;

/** Registra o renderizador (chamado pelo ToastHost no layout raiz). */
export function setToastListener(l: Listener | null): void {
  listener = l;
}

/** Mostra um aviso discreto e não-bloqueante (some sozinho em ~3,5 s). */
export function showToast(message: string | Error, kind: ToastKind = 'ok'): void {
  const text = message instanceof Error ? message.message : String(message ?? '');
  if (!text) return;
  if (listener) listener(text, kind);
}
