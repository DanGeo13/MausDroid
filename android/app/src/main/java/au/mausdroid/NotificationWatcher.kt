package au.mausdroid

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Reads notifications from the apps you choose (by default Meta's Muse) —
 * read-only, never acting in those apps. Only the chosen apps' notifications
 * are passed to MausDroid; for other apps only their names are noted, so you
 * can pick them. Android only lets an app see notifications still in the
 * shade (sent when access is allowed or when asked to re-read) and new ones.
 */
class NotificationWatcher : NotificationListenerService() {
    companion object {
        /** Shared by the app and the engine process (a small file, not preferences). */
        fun watchFile(ctx: Context) = File(ctx.filesDir, "notification-watch.json")

        fun readWatch(ctx: Context): JSONObject =
            runCatching { JSONObject(watchFile(ctx).readText()) }.getOrDefault(JSONObject())

        fun writeWatch(ctx: Context, o: JSONObject) {
            val f = watchFile(ctx)
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeText(o.toString())
            tmp.renameTo(f)
        }

        fun hasAccess(ctx: Context) = androidx.core.app.NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)

        /** Re-reads what's in the shade now (asks Android to reconnect the listener). */
        fun rescan(ctx: Context) = runCatching { requestRebind(ComponentName(ctx, NotificationWatcher::class.java)) }.isSuccess
    }

    override fun onListenerConnected() {
        Thread {
            val pending = runCatching { activeNotifications }.getOrNull() ?: return@Thread
            val batch = JSONArray()
            for (sbn in pending) { note(sbn); if (watched(sbn)) batch.put(toJson(sbn, true)) }
            if (batch.length() > 0) post(batch)
        }.start()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName == packageName) return
        Thread {
            note(sbn)
            if (watched(sbn)) post(JSONArray().put(toJson(sbn, false)))
        }.start()
    }

    private fun label(pkg: String) = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg)

    /** Remembers which apps send notifications (names only) so you can choose them. */
    private fun note(sbn: StatusBarNotification) {
        if (sbn.packageName == packageName) return
        synchronized(NotificationWatcher::class.java) {
            val w = readWatch(this)
            val seen = w.optJSONObject("seen") ?: JSONObject()
            if (!seen.has(sbn.packageName)) {
                seen.put(sbn.packageName, label(sbn.packageName))
                w.put("seen", seen)
                writeWatch(this, w)
            }
        }
    }

    /** The chosen apps; if none chosen yet, any app called Muse. */
    private fun watched(sbn: StatusBarNotification): Boolean {
        if (sbn.packageName == packageName) return false
        val chosen = readWatch(this).optJSONArray("packages")
        if (chosen != null && chosen.length() > 0) {
            for (i in 0 until chosen.length()) if (chosen.optString(i) == sbn.packageName) return true
            return false
        }
        val name = label(sbn.packageName).lowercase()
        return name == "muse" || name.startsWith("muse ") || name.contains("meta muse") || sbn.packageName.lowercase().contains(".muse")
    }

    private fun toJson(sbn: StatusBarNotification, pending: Boolean): JSONObject {
        val ex = sbn.notification.extras
        // Remember how to open this conversation (the app's own action), for Reply Desk's "Open conversation".
        sbn.notification.contentIntent?.let { Conversations.remember(sbn.key, sbn.packageName, it) }
        // Messaging apps: the conversation's name, group or not, and recent messages (context).
        val convo = ex.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()
        val group = ex.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false)
        val msgs = org.json.JSONArray()
        runCatching {
            val arr = ex.getParcelableArray(Notification.EXTRA_MESSAGES)
            arr?.takeLast(8)?.forEach { b ->
                val bundle = b as? android.os.Bundle ?: return@forEach
                val who = bundle.getCharSequence("sender")?.toString() ?: (bundle.get("sender_person") as? android.app.Person)?.name?.toString() ?: ""
                val txt = bundle.getCharSequence("text")?.toString() ?: return@forEach
                msgs.put(JSONObject().put("who", who).put("text", txt.take(1000)).put("at", bundle.getLong("time")))
            }
        }
        val text = ex.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: ex.getCharSequence(Notification.EXTRA_TEXT)
        val lines = ex.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.joinToString("\n")
        return JSONObject()
            .put("key", sbn.key)
            .put("pkg", sbn.packageName)
            .put("app", label(sbn.packageName))
            .put("title", (ex.getCharSequence(Notification.EXTRA_TITLE) ?: "").toString())
            .put("text", listOfNotNull(text?.toString(), lines).joinToString("\n").take(4000))
            .put("subText", (ex.getCharSequence(Notification.EXTRA_SUB_TEXT) ?: "").toString())
            .put("category", sbn.notification.category ?: "")
            .put("postedAt", sbn.postTime)
            .put("pending", pending)
            .put("conversation", convo ?: "")
            .put("group", group)
            .put("messages", msgs)
            .put("summary", (sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY) != 0)
    }

    private fun post(items: JSONArray) {
        for (attempt in 0 until 3) {
            try {
                val c = URL("http://127.0.0.1:${MausApp.ENGINE_PORT}/api/notifications/incoming").openConnection() as HttpURLConnection
                c.requestMethod = "POST"
                c.doOutput = true
                c.connectTimeout = 3000
                c.readTimeout = 10000
                c.setRequestProperty("authorization", "Bearer ${MausApp.secret(this, "ui-token")}")
                c.setRequestProperty("content-type", "application/json")
                c.outputStream.use { it.write(JSONObject().put("items", items).toString().toByteArray()) }
                if (c.responseCode == 200) return
            } catch (_: Exception) {
            }
            Thread.sleep(5000L * (attempt + 1))
        }
        Diag.log(this, "couldn't pass ${items.length()} notification(s) to the engine")
    }
}
