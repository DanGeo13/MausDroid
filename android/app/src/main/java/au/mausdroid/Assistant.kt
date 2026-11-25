package au.mausdroid

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionService
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * MausDroid as your phone's digital assistant (Settings → Default apps →
 * Digital assistant app). Long-press home or the power button: a panel
 * slides up, listens right away, and the bot you chose answers aloud.
 */
class MausVoiceInteractionService : VoiceInteractionService()

class MausSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession = MausSession(this)
}

/** Required by Android for an assistant app; MausDroid uses the phone's speech recognition. */
class MausRecognitionService : RecognitionService() {
    override fun onStartListening(recognizerIntent: Intent?, listener: Callback?) { listener?.error(android.speech.SpeechRecognizer.ERROR_CLIENT) }
    override fun onCancel(listener: Callback?) {}
    override fun onStopListening(listener: Callback?) {}
}

class MausSession(ctx: Context) : VoiceInteractionSession(ctx) {
    private var panel: AssistPanel? = null
    override fun onCreateContentView(): View {
        val p = AssistPanel(context) { hide() }
        panel = p
        return p.view
    }
    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        panel?.start()
    }
    override fun onHide() {
        panel?.stop()
        super.onHide()
    }
}

/** Fallback for phones that send the Assist action to an app instead of an assistant service. */
class AssistActivity : Activity() {
    private var panel: AssistPanel? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val p = AssistPanel(this) { finish() }
        panel = p
        setContentView(p.view)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
        } else p.start()
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        panel?.start()
    }
    override fun onPause() {
        panel?.stop()
        super.onPause()
        finish()
    }
}

/** The assistant panel: listen → ask the chosen bot → show and speak the answer. */
class AssistPanel(private val ctx: Context, private val close: () -> Unit) {
    private val voice = Voice(ctx)
    private val dp = ctx.resources.displayMetrics.density
    private fun px(v: Int) = (v * dp).toInt()
    private val accent = Color.parseColor("#7C5CFF")

    private val title = TextView(ctx).apply { setTextColor(Color.WHITE); textSize = 16f; setTypeface(typeface, android.graphics.Typeface.BOLD) }
    private val heard = TextView(ctx).apply { setTextColor(Color.parseColor("#C9CEDA")); textSize = 18f; setPadding(0, px(10), 0, px(6)) }
    private val answer = TextView(ctx).apply { setTextColor(Color.WHITE); textSize = 17f; setPadding(0, px(6), 0, px(6)); setTextIsSelectable(true) }
    private val statusLine = TextView(ctx).apply { setTextColor(Color.parseColor("#9AA3B5")); textSize = 13f }
    private var botId: String? = null
    private var speak = true
    @Volatile private var active = false

    private val mic = Button(ctx).apply {
        text = "🎤  Talk"
        isAllCaps = false
        setTextColor(Color.WHITE)
        background = GradientDrawable().apply { cornerRadius = px(24).toFloat(); setColor(accent) }
        setOnClickListener { voice.stopSpeaking(); listen() }
    }
    private val open = Button(ctx).apply {
        text = "Open chat"
        isAllCaps = false
        setTextColor(Color.WHITE)
        background = GradientDrawable().apply { cornerRadius = px(24).toFloat(); setColor(Color.parseColor("#2A2F3D")) }
        setOnClickListener {
            ctx.startActivity(Intent(ctx, MainActivity::class.java).putExtra("botId", botId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            close()
        }
    }

    val view: View = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.BOTTOM
        setBackgroundColor(Color.parseColor("#66000000"))
        setOnClickListener { close() }
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(20), px(18), px(20), px(24))
            background = GradientDrawable().apply {
                cornerRadii = floatArrayOf(px(24).toFloat(), px(24).toFloat(), px(24).toFloat(), px(24).toFloat(), 0f, 0f, 0f, 0f)
                setColor(Color.parseColor("#141821"))
            }
            isClickable = true
            addView(title)
            addView(statusLine)
            addView(heard)
            addView(ScrollView(ctx).apply { addView(answer) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { height = ViewGroup.LayoutParams.WRAP_CONTENT })
            addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, px(12), 0, 0)
                addView(mic, LinearLayout.LayoutParams(0, px(48), 1f).apply { marginEnd = px(8) })
                addView(open, LinearLayout.LayoutParams(0, px(48), 1f))
            })
        }
        addView(card, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    private fun ui(block: () -> Unit) = view.post(block)

    private fun engine(path: String, body: JSONObject?, timeoutMs: Int = 90_000): JSONObject {
        val c = URL("http://127.0.0.1:${MausApp.ENGINE_PORT}$path").openConnection() as HttpURLConnection
        c.connectTimeout = 3000
        c.readTimeout = timeoutMs
        c.setRequestProperty("authorization", "Bearer ${MausApp.secret(ctx, "ui-token")}")
        if (body != null) {
            c.requestMethod = "POST"
            c.doOutput = true
            c.setRequestProperty("content-type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        val text = (if (c.responseCode < 400) c.inputStream else c.errorStream).bufferedReader().readText()
        val o = JSONObject(text.ifBlank { "{}" })
        if (c.responseCode >= 400) throw RuntimeException(o.optString("error", "HTTP ${c.responseCode}"))
        return o
    }

    fun start() {
        active = true
        title.text = "MausDroid"
        statusLine.text = "Getting ready…"
        heard.text = ""
        answer.text = ""
        try { EngineService.start(ctx) } catch (_: Exception) {}
        Thread {
            try {
                val a = engine("/api/assistant", null, 5000)
                botId = a.optString("botId").ifBlank { null }
                speak = a.optBoolean("speak", true)
                ui { title.text = "${a.optString("emoji")} ${a.optString("botName", "MausDroid")}"; listen() }
            } catch (e: Exception) {
                ui { statusLine.text = "MausDroid is still starting. Try again in a moment." }
            }
        }.start()
    }

    private fun listen() {
        if (!active) return
        if (ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            statusLine.text = "Open MausDroid once and allow the microphone, then try again."
            return
        }
        statusLine.text = "Listening…"
        mic.text = "🎤  Listening…"
        voice.listen(object : Voice.Listener {
            override fun onPartial(text: String) { heard.text = "“$text”" }
            override fun onFinal(text: String) {
                heard.text = "“$text”"
                mic.text = "🎤  Talk"
                ask(text)
            }
            override fun onError(message: String) {
                statusLine.text = message
                mic.text = "🎤  Talk"
            }
        })
    }

    private fun ask(text: String) {
        statusLine.text = "Thinking…"
        Thread {
            try {
                val r = engine("/api/assistant/ask", JSONObject().put("text", text))
                val reply = r.optString("reply").takeIf { !r.isNull("reply") }
                ui {
                    if (reply == null) {
                        statusLine.text = "Still working — you'll get a notification when it's done."
                    } else {
                        statusLine.text = ""
                        answer.text = reply
                        if (speak) voice.speak(speakable(reply))
                    }
                }
            } catch (e: Exception) {
                ui { statusLine.text = "Couldn't reach your bot: ${e.message}" }
            }
        }.start()
    }

    private fun speakable(t: String) = t.replace(Regex("```[\\s\\S]*?```"), " (code) ").replace(Regex("\\[([^\\]]+)\\]\\([^)]+\\)"), "$1")
        .replace(Regex("https?://\\S+"), "a link").replace(Regex("[*_#>`|]"), "").replace(Regex("\\s+"), " ").trim()

    fun stop() {
        active = false
        voice.stopListening()
        voice.stopSpeaking()
        voice.shutdown()
    }
}
