package expo.modules.banknotifications

import android.app.Notification
import android.content.Context
import android.content.Intent
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/** Broadcast local (só dentro do app) disparado quando uma notificação
 *  bancária entra ou muda no grid — o módulo retransmite para o JS como
 *  evento "onBankNotificationsChanged". */
const val ACTION_BANK_NOTIFICATIONS_CHANGED = "expo.modules.banknotifications.CHANGED"

/** Pacotes de apps bancários/fintechs brasileiras conhecidos. A lista é
 *  SEMENTE: o filtro principal é a HEURÍSTICA pelo nome do app (qualquer app
 *  cujo nome tenha "banco", "bank", "inter" ou "btg" entra — "Banco Inter",
 *  "Nubank", "Banco do Brasil", "Agibank", "BTG Pactual"…). */
internal val KNOWN_BANK_PACKAGES = setOf(
  "br.com.intermedium",        // Banco Inter
  "com.nu.production",         // Nubank
  "br.com.bb.android",         // Banco do Brasil
  "br.gov.caixa",              // Caixa
  "br.gov.caixa.tem",          // Caixa Tem
  "br.com.bradesco",           // Bradesco
  "br.com.bradesco.next",      // next
  "com.santander.app",         // Santander
  "br.com.itau",               // Itaú
  "br.com.itau.itaubanking",   // Itaú (pacote antigo)
  "com.c6bank.app",            // C6 Bank
  "br.com.sicredi",            // Sicredi
  "br.com.banrisul",           // Banrisul
  "br.com.neon",               // Neon
  "br.com.pagseguro",          // PagBank
  "com.picpay",                // PicPay
  "com.mercadopago.wallet",    // Mercado Pago
  "com.btg.piggypiggy",        // BTG Pactual
  "br.com.willbank"            // Will Bank
)

/**
 * BankNotificationListenerService (v71) — CAPTURA DAS NOTIFICAÇÕES DO BANCO.
 *
 * Serviço do Android que o sistema liga AUTOMATICAMENTE quando o usuário
 * autoriza o app em "Acesso às notificações". Nada roda antes disso.
 *
 *  · onListenerConnected → captura as notificações que JÁ ESTÃO na barra
 *    (getActiveNotifications) — resolve o caso do usuário que hoje tem 09
 *    notificações do banco acumuladas;
 *  · onNotificationPosted → captura as que CHEGAREM depois (tempo real).
 *
 * Cada notificação passa pelo filtro bancário (pacote conhecido ou nome do app
 * com "banco/bank/inter/btg"), é guardada no BankNotificationStore (local, só
 * as mais recentes) e o app é avisado por broadcast. NÃO cancela notificação
 * da barra, NÃO cria lançamento: o grid da tela "Notificações do banco" mostra
 * tudo e o usuário decide "Lançar" ou "Excluir".
 */
class BankNotificationListenerService : NotificationListenerService() {

  override fun onListenerConnected() {
    super.onListenerConnected()
    captureActive()
  }

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    if (sbn == null) return
    if (capture(this, sbn)) notifyChanged(this)
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification?) {
    // intencional: o "Excluir" é DECISÃO DO USUÁRIO dentro do app — a
    // notificação removida da barra pelo próprio usuário sai do grid só
    // quando ele exclui no app ou expira pelo limite do repositório.
  }

  /** Captura as notificações JÁ PRESENTES na barra (conexão inicial). */
  private fun captureActive() {
    var mudou = false
    try {
      val ativas = activeNotifications ?: return
      for (sbn in ativas) {
        if (capture(this, sbn)) mudou = true
      }
    } catch (_: Exception) {
      // getActiveNotifications pode falhar logo na conexão — a próxima
      // notificação que chegar reconstrói o grid.
    }
    if (mudou) notifyChanged(this)
  }

  companion object {
    /** Guarda a notificação se for de app bancário; true quando NOVA no grid. */
    fun capture(context: Context, sbn: StatusBarNotification): Boolean {
      val pkg = sbn.packageName ?: return false
      if (pkg == context.packageName) return false
      // notificações "em andamento" (progresso/serviço em foreground) e não
      // descartáveis não são avisos do banco — fora do grid.
      if (sbn.isOngoing || !sbn.isClearable) return false
      val extras = sbn.notification?.extras ?: return false
      val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
      val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
        ?: extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
      if (text.isNullOrBlank()) return false
      if (!isBankApp(context, pkg)) return false
      return BankNotificationStore.add(
        context, pkg, appName(context, pkg), title, text.trim(), sbn.postTime
      )
    }

    /** Filtro bancário: pacote conhecido OU nome do app com pista de banco. */
    fun isBankApp(context: Context, pkg: String): Boolean {
      if (pkg in KNOWN_BANK_PACKAGES) return true
      val label = appName(context, pkg)?.lowercase() ?: return false
      return label.contains("banco") || label.contains("bank") ||
        label.contains("inter") || label.contains("btg")
    }

    fun appName(context: Context, pkg: String): String? = try {
      val info = context.packageManager.getApplicationInfo(pkg, 0)
      context.packageManager.getApplicationLabel(info)?.toString()
    } catch (_: Exception) {
      null
    }

    fun notifyChanged(context: Context) {
      context.sendBroadcast(
        Intent(ACTION_BANK_NOTIFICATIONS_CHANGED).setPackage(context.packageName)
      )
    }
  }
}
