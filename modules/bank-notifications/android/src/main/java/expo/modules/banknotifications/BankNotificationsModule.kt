package expo.modules.banknotifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Nome do evento JS disparado quando o grid de notificações muda. */
const val EVENT_CHANGED = "onBankNotificationsChanged"

/**
 * BankNotificationsModule (v71) — ponte JS ↔ captura das notificações do banco.
 *
 * Funções expostas ao app (ver src/lib/bankNotifications.ts):
 *  · isListenerEnabled()    — o usuário JÁ autorizou "Acesso às notificações"?
 *  · openListenerSettings() — abre a tela do sistema para o usuário autorizar;
 *  · getCaptured()          — notificações do banco capturadas (grid da tela);
 *  · remove(id)             — botão "Excluir" do grid;
 *  · clearAll()             — limpa o repositório local.
 *
 * Evento "onBankNotificationsChanged": disparado quando o serviço captura
 * notificação nova — o app atualiza o grid na hora ("quando chegar a
 * notificação do banco" ela aparece sozinha).
 *
 * A leitura SÓ EXISTE depois da autorização do usuário em "Acesso às
 * notificações" (tela do sistema Android). Sem ela o serviço nem roda.
 */
class BankNotificationsModule : Module() {

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      try {
        sendEvent(EVENT_CHANGED, mapOf("at" to System.currentTimeMillis()))
      } catch (_: Exception) {
        // app em teardown — nada a fazer
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("BankNotifications")
    Events(EVENT_CHANGED)

    OnCreate {
      val ctx = appContext.reactContext ?: return@OnCreate
      val filter = IntentFilter(ACTION_BANK_NOTIFICATIONS_CHANGED)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        ctx.registerReceiver(receiver, filter)
      }
    }

    OnDestroy {
      try {
        appContext.reactContext?.unregisterReceiver(receiver)
      } catch (_: Exception) {
        // receiver já solto — nada a fazer
      }
    }

    /** O usuário já deu o "Acesso às notificações" ao app? */
    Function("isListenerEnabled") {
      val ctx = appContext.reactContext ?: return@Function false
      try {
        NotificationManagerCompat.getEnabledListenerPackages(ctx)
          .contains(ctx.packageName)
      } catch (_: Exception) {
        false
      }
    }

    /** Abre a tela do sistema "Acesso às notificações" para o usuário autorizar. */
    Function("openListenerSettings") {
      val ctx = appContext.reactContext ?: return@Function false
      val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        ctx.startActivity(intent)
        true
      } catch (_: Exception) {
        false
      }
    }

    /** Notificações do banco capturadas da barra do sistema (mais recentes 1º). */
    Function("getCaptured") {
      val ctx = appContext.reactContext
        ?: return@Function emptyList<Map<String, Any?>>()
      val arr = BankNotificationStore.read(ctx)
      val out = ArrayList<Map<String, Any?>>(arr.length())
      for (i in 0 until arr.length()) {
        val o = arr.getJSONObject(i)
        out.add(
          mapOf(
            "id" to o.optString("id"),
            "appPackage" to o.optString("appPackage"),
            "appName" to (if (o.isNull("appName")) null else o.optString("appName")),
            "title" to (if (o.isNull("title")) null else o.optString("title")),
            "body" to o.optString("body"),
            "postTime" to o.optLong("postTime"),
            "count" to o.optInt("count", 1)
          )
        )
      }
      out
    }

    /** Botão "Excluir" do grid — tira a mensagem (a notificação continua na barra). */
    Function("remove") { id: String ->
      val ctx = appContext.reactContext ?: return@Function false
      BankNotificationStore.remove(ctx, id)
    }

    /** Limpa o repositório local (não mexe na barra do sistema). */
    Function("clearAll") {
      val ctx = appContext.reactContext
      if (ctx != null) {
        BankNotificationStore.clear(ctx)
      }
      true
    }
  }
}
