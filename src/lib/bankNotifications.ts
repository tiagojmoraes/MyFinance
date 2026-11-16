/**
 * bankNotifications (v71) — PONTE JS ↔ módulo nativo de captura das
 * NOTIFICAÇÕES DO BANCO (Android, NotificationListenerService).
 *
 * Fluxo pedido na v71: o usuário autoriza ("Acesso às notificações", tela do
 * sistema — o app pede a permissão com o botão "Permitir acesso às
 * notificações") e, a partir daí, as notificações do banco que estão NA BARRA
 * do aparelho (as 09 acumuladas, por exemplo) e as que CHEGAREM aparecem no
 * GRID da tela — cada uma com "Lançar" e "Excluir".
 *
 * Em plataformas sem o módulo nativo (Expo Go, iOS, web, testes) TUDO degrada
 * com segurança: supported() = false, enabled = null, lista vazia, listener
 * sem efeito — a tela explica a limitação em vez de falhar.
 */

import { Platform } from 'react-native';

/** Nome do evento nativo "o grid mudou" (serviço capturou/atualizou). */
export const BANK_NOTIFICATIONS_CHANGED_EVENT = 'onBankNotificationsChanged';

/** Notificação bancária capturada da barra do sistema. */
export interface CapturedBankNotification {
  /** id estável (pacote + hora + hash do texto) — usado pelo "Excluir". */
  id: string;
  appPackage: string;
  /** Nome do app do banco ("Banco Inter") — null quando o sistema não devolve. */
  appName: string | null;
  title: string | null;
  body: string;
  /** epoch ms da postagem na barra do sistema. */
  postTime: number;
  /** quantas vezes a mesma mensagem foi postada (agrupada). */
  count: number;
}

interface BankNotificationsNativeModule {
  isListenerEnabled(): boolean;
  openListenerSettings(): boolean;
  getCaptured(): CapturedBankNotification[];
  remove(id: string): boolean;
  clearAll(): void;
  addListener(eventName: string, listener: () => void): { remove(): void };
}

let cached: BankNotificationsNativeModule | null | undefined;

/** Módulo nativo ou null (Expo Go / iOS / web / Jest — sem módulo registrado). */
function getNative(): BankNotificationsNativeModule | null {
  if (cached !== undefined) return cached;
  try {
    // requireNativeModule lança quando o módulo não foi registrado no build
    // (Expo Go, web, Jest) — a ponte inteira degrada nesse caso.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireNativeModule } = require('expo-modules-core');
    cached = requireNativeModule('BankNotifications') as BankNotificationsNativeModule;
  } catch {
    cached = null;
  }
  return cached;
}

/** true quando a plataforma tem a captura nativa (módulo Android registrada). */
export function bankNotificationsSupported(): boolean {
  if (Platform.OS !== 'android') return false;
  return getNative() != null;
}

/**
 * O usuário já autorizou o "Acesso às notificações"?
 * `null` = a plataforma não tem a leitura (iOS/web/Expo Go).
 */
export function isBankListenerEnabled(): boolean | null {
  if (!bankNotificationsSupported()) return null;
  try {
    return getNative()!.isListenerEnabled() === true;
  } catch {
    return false;
  }
}

/** Abre a tela do sistema "Acesso às notificações" para o usuário autorizar. */
export function openBankListenerSettings(): void {
  try {
    getNative()?.openListenerSettings();
  } catch {
    // sem suporte — nada a fazer (a tela mostra o aviso de limitação)
  }
}

/** Notificações do banco capturadas (o nativo já entrega mais recentes 1º). */
export function getCapturedBankNotifications(): CapturedBankNotification[] {
  try {
    const list = getNative()?.getCaptured();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** "Excluir" — tira a mensagem do grid (a notificação continua na barra). */
export function removeCapturedBankNotification(id: string): void {
  try {
    getNative()?.remove(id);
  } catch {
    // sem suporte — nada a fazer
  }
}

/**
 * Assina "o grid mudou" (chegou/atualizou notificação bancária). Devolve a
 * função de unsubscribe — sempre segura para chamar no cleanup do useEffect.
 */
export function subscribeBankNotificationsChanged(cb: () => void): () => void {
  const native = getNative();
  if (!native || typeof native.addListener !== 'function') return () => {};
  try {
    const sub = native.addListener(BANK_NOTIFICATIONS_CHANGED_EVENT, cb);
    return () => {
      try {
        sub.remove();
      } catch {
        // assinatura já solta — nada a fazer
      }
    };
  } catch {
    return () => {};
  }
}
