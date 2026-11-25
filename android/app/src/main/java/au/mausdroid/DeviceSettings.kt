package au.mausdroid

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/** Opens the phone's settings pages needed for reliable background work (incl. Xiaomi/POCO HyperOS). */
object DeviceSettings {
    fun info(ctx: Context): JSONObject {
        val pm = ctx.getSystemService(PowerManager::class.java)
        return JSONObject()
            .put("ignoringBatteryOptimizations", pm.isIgnoringBatteryOptimizations(ctx.packageName))
            .put("notificationsAllowed", NotificationManagerCompat.from(ctx).areNotificationsEnabled())
            .put("manufacturer", android.os.Build.MANUFACTURER)
            .put("model", android.os.Build.MODEL)
            .put("android", android.os.Build.VERSION.RELEASE)
            .put("apk", BuildConfig.VERSION_NAME)
    }

    private fun launch(ctx: Context, vararg intents: Intent): Boolean {
        for (i in intents) {
            try {
                ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return true
            } catch (_: Exception) {
            }
        }
        return false
    }

    private fun appDetails(ctx: Context) = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}"))

    fun open(ctx: Context, what: String): Boolean = when (what) {
        "battery" -> launch(
            ctx,
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")),
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
            appDetails(ctx),
        )
        "autostart" -> launch(
            ctx,
            Intent().setComponent(ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")),
            Intent("miui.intent.action.OP_AUTO_START").addCategory(Intent.CATEGORY_DEFAULT),
            appDetails(ctx),
        )
        "notifications" -> launch(
            ctx,
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName),
            appDetails(ctx),
        )
        else -> launch(ctx, appDetails(ctx))
    }
}
