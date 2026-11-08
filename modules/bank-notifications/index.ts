/**
 * Módulo nativo BANK NOTIFICATIONS (v71) — captura das NOTIFICAÇÕES DO BANCO.
 *
 * Módulo local (Expo Modules API) autolinkado pelo prebuild a partir da pasta
 * `modules/`. No Android ele se apoia num NotificationListenerService declarado
 * no próprio módulo — o sistema só liga o serviço quando o usuário autoriza o
 * app em "Acesso às notificações"; antes disso NADA é lido.
 *
 * Este index.ts é o contrato do lado nativo. No app, use o wrapper
 * `src/lib/bankNotifications.ts` — ele degrada com segurança onde o módulo não
 * existe (Expo Go, iOS, web, testes).
 */
import { requireNativeModule } from 'expo-modules-core';

/** Notificação bancária capturada da barra do sistema. */
export interface NativeCapturedNotification {
  /** id estável (pacote + hora + hash do texto) — usado pelo "Excluir". */
  id: string;
  appPackage: string;
  appName: string | null;
  title: string | null;
  body: string;
  /** epoch ms da postagem na barra do sistema. */
  postTime: number;
  /** quantas vezes a mesma mensagem foi postada (agrupada). */
  count: number;
}

interface BankNotificationsNativeModule {
  /** O usuário já autorizou o "Acesso às notificações"? */
  isListenerEnabled(): boolean;
  /** Abre a tela do sistema "Acesso às notificações". */
  openListenerSettings(): boolean;
  /** Notificações do banco capturadas (mais recentes primeiro). */
  getCaptured(): NativeCapturedNotification[];
  /** "Excluir" — tira a mensagem do grid. */
  remove(id: string): boolean;
  clearAll(): void;
}

export default requireNativeModule<BankNotificationsNativeModule>('BankNotifications');
