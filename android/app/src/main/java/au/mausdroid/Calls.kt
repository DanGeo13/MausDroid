package au.mausdroid

import android.app.Activity
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Maus calling you: a ringing, full-screen incoming call (also on the lock screen). */
object CallRinger {
    private var ringtone: Ringtone? = null
    private const val NOTIF = 4242

    fun ring(ctx: Context, callId: String, name: String, emoji: String, reason: String) {
        val full = PendingIntent.getActivity(
            ctx, 9, Intent(ctx, IncomingCallActivity::class.java)
                .putExtra("callId", callId).putExtra("name", name).putExtra("emoji", emoji).putExtra("reason", reason)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(ctx, MausApp.CH_CALLS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("$emoji $name is calling")
            .setContentText(reason)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setFullScreenIntent(full, true)
            .setContentIntent(full)
            .setOngoing(true)
            .setTimeoutAfter(45_000)
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify(NOTIF, n)
        try {
            ringtone = RingtoneManager.getRingtone(ctx, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))?.apply {
                audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build()
                if (Build.VERSION.SDK_INT >= 28) isLooping = true
                play()
            }
            ctx.getSystemService(Vibrator::class.java)?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 800), 0))
        } catch (_: Exception) {
        }
    }

    fun stop(ctx: Context) {
        ringtone?.stop()
        ringtone = null
        ctx.getSystemService(Vibrator::class.java)?.cancel()
        ctx.getSystemService(NotificationManager::class.java).cancel(NOTIF)
    }
}

class IncomingCallActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val callId = intent.getStringExtra("callId") ?: return finish()
        val dp = resources.displayMetrics.density
        fun px(v: Int) = (v * dp).toInt()
        fun round(color: String) = GradientDrawable().apply { cornerRadius = px(40).toFloat(); setColor(Color.parseColor(color)) }
        fun answer(yes: Boolean) {
            Thread {
                try {
                    val c = URL("http://127.0.0.1:${MausApp.ENGINE_PORT}/api/calls/$callId/answer").openConnection() as HttpURLConnection
                    c.requestMethod = "POST"
                    c.doOutput = true
                    c.setRequestProperty("authorization", "Bearer ${MausApp.secret(this, "ui-token")}")
                    c.setRequestProperty("content-type", "application/json")
                    c.outputStream.use { it.write(JSONObject().put("answer", yes).toString().toByteArray()) }
                    c.responseCode
                } catch (_: Exception) {
                }
            }.start()
            if (yes) startActivity(Intent(this, MainActivity::class.java).putExtra("link", "call:$callId").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            finish()
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#0B0B0B"))
            setPadding(px(24), px(24), px(24), px(24))
            addView(TextView(context).apply { text = intent.getStringExtra("emoji") ?: "🐭"; textSize = 64f; gravity = Gravity.CENTER })
            addView(TextView(context).apply { text = "${intent.getStringExtra("name") ?: "Maus"} is calling"; setTextColor(Color.WHITE); textSize = 26f; gravity = Gravity.CENTER; setPadding(0, px(12), 0, px(8)) })
            addView(TextView(context).apply { text = intent.getStringExtra("reason") ?: ""; setTextColor(Color.parseColor("#C9CEDA")); textSize = 17f; gravity = Gravity.CENTER; setPadding(0, 0, 0, px(48)) })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                addView(Button(context).apply { text = "Decline"; setTextColor(Color.WHITE); background = round("#E5484D"); isAllCaps = false; textSize = 18f; setOnClickListener { answer(false) } }, LinearLayout.LayoutParams(px(140), px(72)).apply { marginEnd = px(24) })
                addView(Button(context).apply { text = "Answer"; setTextColor(Color.WHITE); background = round("#1F9D6A"); isAllCaps = false; textSize = 18f; setOnClickListener { answer(true) } }, LinearLayout.LayoutParams(px(140), px(72)))
            })
        })
    }
}
