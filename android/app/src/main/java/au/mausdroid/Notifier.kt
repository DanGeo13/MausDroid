package au.mausdroid

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Phone notifications for alerts, approvals (Allow / Deny right in the notification) and questions. */
object Notifier {
    fun show(ctx: Context, o: JSONObject) {
        val id = o.optString("id").hashCode()
        val botId = o.optString("botId")
        val cardId = o.optString("cardId")
        val isCard = cardId.isNotBlank()
        val channel = when {
            isCard || o.optString("priority") == "high" -> MausApp.CH_APPROVALS
            o.optBoolean("silent") -> MausApp.CH_QUIET
            else -> MausApp.CH_ALERTS
        }
        val open = PendingIntent.getActivity(
            ctx, id, Intent(ctx, MainActivity::class.java).putExtra("botId", botId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val b = NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(o.optString("title"))
            .setContentText(o.optString("body"))
            .setStyle(NotificationCompat.BigTextStyle().bigText(o.optString("body")))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(if (isCard) Notification.CATEGORY_REMINDER else Notification.CATEGORY_MESSAGE)
        val actions = o.optJSONArray("actions")
        if (isCard && actions != null) {
            for (allow in listOf(true, false)) {
                val pi = PendingIntent.getBroadcast(
                    ctx, (cardId + allow).hashCode(),
                    Intent(ctx, CardActionReceiver::class.java).putExtra("cardId", cardId).putExtra("allow", allow).putExtra("nid", id),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                b.addAction(0, if (allow) "Allow" else "Deny", pi)
            }
        } else if (isCard) {
            // A question: answer straight from the notification.
            val input = RemoteInput.Builder("answer").setLabel("Your answer").build()
            val pi = PendingIntent.getBroadcast(
                ctx, cardId.hashCode(),
                Intent(ctx, CardActionReceiver::class.java).putExtra("cardId", cardId).putExtra("allow", true).putExtra("nid", id),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
            )
            b.addAction(NotificationCompat.Action.Builder(0, "Answer", pi).addRemoteInput(input).build())
        }
        ctx.getSystemService(NotificationManager::class.java).notify(id, b.build())
    }
}

/** Handles Allow / Deny / Answer taps without opening the app. */
class CardActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val cardId = intent.getStringExtra("cardId") ?: return
        val allow = intent.getBooleanExtra("allow", false)
        val answer = RemoteInput.getResultsFromIntent(intent)?.getCharSequence("answer")?.toString()
        val pending = goAsync()
        Thread {
            try {
                val c = URL("http://127.0.0.1:${MausApp.ENGINE_PORT}/api/cards/$cardId").openConnection() as HttpURLConnection
                c.requestMethod = "POST"
                c.doOutput = true
                c.setRequestProperty("content-type", "application/json")
                c.setRequestProperty("authorization", "Bearer ${MausApp.secret(ctx, "ui-token")}")
                val body = JSONObject().put("allow", allow)
                if (answer != null) body.put("answer", answer)
                c.outputStream.use { it.write(body.toString().toByteArray()) }
                c.responseCode
            } catch (_: Exception) {
            } finally {
                ctx.getSystemService(NotificationManager::class.java).cancel(intent.getIntExtra("nid", 0))
                pending.finish()
            }
        }.start()
    }
}
