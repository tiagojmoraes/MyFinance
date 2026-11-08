package expo.modules.banknotifications

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * BankNotificationStore (v71) — repositório LOCAL das notificações do banco
 * capturadas da barra do sistema.
 *
 * Guarda em SharedPreferences (JSON) as mais recentes (limite de 60), sempre
 * ordenadas da mais nova para a mais velha. É DEDUPLICADO: a mesma mensagem
 * repostada pelo banco (o Android reenvia notificação igual) não entra duas
 * vezes — atualiza a hora e a contagem.
 *
 * O lado JS lê por cima do módulo (getCaptured) e o usuário decide:
 * "Lançar" (entra na lista do banco de dados e abre o Novo Lançamento) ou
 * "Excluir" (remove daqui — a notificação ORIGINAL continua na barra).
 */
internal object BankNotificationStore {
  private const val PREFS = "bank_notifications_store"
  private const val KEY = "captured"
  private const val MAX = 60

  private fun prefs(context: Context) =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  @Synchronized
  fun read(context: Context): JSONArray = try {
    JSONArray(prefs(context).getString(KEY, "[]") ?: "[]")
  } catch (_: Exception) {
    JSONArray()
  }

  @Synchronized
  private fun write(context: Context, arr: JSONArray) {
    prefs(context).edit().putString(KEY, arr.toString()).apply()
  }

  /** id estável da captura: pacote + hora de postagem + hash do texto. */
  private fun idOf(pkg: String, text: String, postTime: Long) =
    "$pkg|$postTime|${text.hashCode()}"

  /** Guarda a notificação; devolve true quando ela é NOVA no grid. */
  @Synchronized
  fun add(
    context: Context,
    pkg: String,
    appName: String?,
    title: String?,
    text: String,
    postTime: Long
  ): Boolean {
    val arr = read(context)
    val id = idOf(pkg, text, postTime)

    // (1) id igual → é a MESMA postagem (o Android reemite onNotificationPosted
    //     em rotações/updates de rank) — nada muda no grid.
    for (i in 0 until arr.length()) {
      if (arr.getJSONObject(i).optString("id") == id) return false
    }

    // (2) mesmo pacote + mesmo TEXTO (mensagem repostada): atualiza a captura
    //     existente (hora nova + contagem) em vez de criar card repetido.
    val semRepetido = JSONArray()
    var tinhaRepetido = false
    for (i in 0 until arr.length()) {
      val o = arr.getJSONObject(i)
      if (o.optString("appPackage") == pkg && o.optString("body") == text) {
        tinhaRepetido = true
        o.put("id", id)
        o.put("postTime", postTime)
        o.put("count", o.optInt("count", 1) + 1)
      }
      semRepetido.put(o)
    }
    if (tinhaRepetido) {
      write(context, trim(semRepetido))
      return false
    }

    // (3) nova captura — entra no TOPO (mais recente primeiro).
    val item = JSONObject()
    item.put("id", id)
    item.put("appPackage", pkg)
    item.put("appName", appName ?: JSONObject.NULL)
    item.put("title", title ?: JSONObject.NULL)
    item.put("body", text)
    item.put("postTime", postTime)
    item.put("count", 1)
    val novo = JSONArray()
    novo.put(item)
    for (i in 0 until arr.length()) novo.put(arr.getJSONObject(i))
    write(context, trim(novo))
    return true
  }

  /** "Excluir" — tira a mensagem do grid. true quando existia. */
  @Synchronized
  fun remove(context: Context, id: String): Boolean {
    val arr = read(context)
    val novo = JSONArray()
    var achou = false
    for (i in 0 until arr.length()) {
      val o = arr.getJSONObject(i)
      if (o.optString("id") == id) {
        achou = true
        continue
      }
      novo.put(o)
    }
    if (achou) write(context, novo)
    return achou
  }

  /** Limpa o repositório (não mexe nas notificações da barra do sistema). */
  @Synchronized
  fun clear(context: Context) {
    write(context, JSONArray())
  }

  /** Mantém só as MAX mais recentes. */
  private fun trim(arr: JSONArray): JSONArray {
    val novo = JSONArray()
    for (i in 0 until minOf(arr.length(), MAX)) novo.put(arr.getJSONObject(i))
    return novo
  }
}
