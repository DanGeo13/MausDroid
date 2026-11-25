package au.mausdroid

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.webkit.WebView
import java.io.File
import java.security.SecureRandom

/** App start-up: separate WebView storage per process and the notification channels. */
class MausApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val proc = if (Build.VERSION.SDK_INT >= 28) getProcessName() else packageName
        // The UI (main process) and the engine/background browser (":engine")
        // both use WebView; Android requires a separate data folder for each.
        if (proc.endsWith(":engine").not()) WebView.setDataDirectorySuffix("ui")
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_SERVICE, "Running in background", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Keeps your bots working while you use other apps"
            setShowBadge(false)
        })
        nm.createNotificationChannel(NotificationChannel(CH_ALERTS, "Bot alerts", NotificationManager.IMPORTANCE_DEFAULT))
        nm.createNotificationChannel(NotificationChannel(CH_APPROVALS, "Approvals & questions", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CH_QUIET, "Low-priority updates", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CH_CALLS, "Calls from Maus", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Maus calling you (never during calendar events or lock-out times)"
            setSound(null, null) // the call screen plays your ringtone itself
        })
    }

    companion object {
        const val CH_SERVICE = "service"
        const val CH_ALERTS = "alerts"
        const val CH_APPROVALS = "approvals"
        const val CH_QUIET = "quiet"
        const val CH_CALLS = "calls"
        const val ENGINE_PORT = 8737
        const val BRIDGE_PORT = 8738
        const val TAILNET_PROXY_PORT = 8739

        /** Secret shared by the app's own processes; other apps on the phone can't read it. */
        fun secret(app: android.content.Context, name: String): String {
            val f = File(app.filesDir, "$name.secret")
            if (f.exists()) return f.readText()
            val b = ByteArray(24).also { SecureRandom().nextBytes(it) }
            val s = b.joinToString("") { "%02x".format(it) }
            f.writeText(s)
            return s
        }
    }
}
