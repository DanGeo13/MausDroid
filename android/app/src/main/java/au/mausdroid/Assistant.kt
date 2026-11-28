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
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * DanDroid as your phone's digital assistant (Settings → Default apps →
 * Digital assistant app). Long-press home or the power button: a panel
 * slides up, listens right away, and the bot you chose answers aloud.
 */
class MausVoiceInteractionService : VoiceInteractionService()

class MausSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession = MausSession(this)
}

/** Required by Android for an assistant app; DanDroid uses the phone's speech recognition. */
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

    // What's on screen when you summon the assistant. Android only shares it
    // when "Use text from screen" / "Use screenshot" are on in the assistant settings.
    @Deprecated("Deprecated in Java")
    override fun onHandleAssist(data: Bundle?, structure: android.app.assist.AssistStructure?, content: android.app.assist.AssistContent?) {
        panel?.setScreen(ScreenReader.read(context, structure, content))
    }

    override fun onHandleAssist(state: AssistState) {
        panel?.setScreen(ScreenReader.read(context, state.assistStructure, state.assistContent))
    }

    override fun onHandleScreenshot(screenshot: android.graphics.Bitmap?) {
        if (screenshot != null) panel?.setScreenshot(screenshot)
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

/** Reads the visible text of the app on screen (never password fields). */
object ScreenReader {
    data class Screen(val app: String?, val url: String?, val text: String)

    fun read(ctx: Context, structure: android.app.assist.AssistStructure?, content: android.app.assist.AssistContent?): Screen? {
        if (structure == null && content == null) return null
        val sb = StringBuilder()
        var domain: String? = null
        fun walk(n: android.app.assist.AssistStructure.ViewNode, depth: Int) {
            if (depth > 60 || sb.length > 8000) return
            val pwd = (n.inputType and android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD) == android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                (n.inputType and android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD) == android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD
            if (!pwd) {
                val t = n.text?.toString()?.trim()
                if (!t.isNullOrEmpty()) sb.append(t).append('\n')
                else n.contentDescription?.toString()?.trim()?.takeIf { it.isNotEmpty() && it.length < 200 }?.let { sb.append(it).append('\n') }
            }
            if (domain == null) n.webDomain?.let { domain = it }
            for (i in 0 until n.childCount) walk(n.getChildAt(i), depth + 1)
        }
        structure?.let { st -> for (w in 0 until st.windowNodeCount) walk(st.getWindowNodeAt(w).rootViewNode, 0) }
        val pkg = structure?.activityComponent?.packageName
        val app = pkg?.let { p ->
            try { ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(p, 0)).toString() } catch (_: Exception) { p }
        }
        val url = content?.webUri?.toString() ?: domain?.let { "https://$it" }
        return Screen(app, url, sb.toString().lines().distinct().joinToString("\n").take(8000))
    }
}

/** Opens the file picker for the assistant and hands the chosen files back. */
class FilePickActivity : Activity() {
    companion object {
        var onPicked: ((List<JSONObject>) -> Unit)? = null
    }
    private var photo: java.io.File? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent.getBooleanExtra("camera", false)) {
            // The phone's camera app saves the photo where we ask (no camera permission needed).
            val dir = java.io.File(cacheDir, "camera").apply { mkdirs() }
            val f = java.io.File(dir, "photo-${System.currentTimeMillis()}.jpg")
            photo = f
            val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.files", f)
            val shoot = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).putExtra(android.provider.MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .also { it.clipData = android.content.ClipData.newRawUri("", uri) }
            try {
                @Suppress("DEPRECATION") startActivityForResult(shoot, 2)
            } catch (e: Exception) {
                onPicked?.invoke(emptyList())
                finish()
            }
            return
        }
        val pick = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        @Suppress("DEPRECATION") startActivityForResult(pick, 1)
    }
    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val uris = mutableListOf<android.net.Uri>()
        if (requestCode == 2) {
            val f = photo
            if (resultCode == RESULT_OK && f != null && f.length() > 0) uris.add(androidx.core.content.FileProvider.getUriForFile(this, "$packageName.files", f))
            else f?.delete()
        } else if (resultCode == RESULT_OK && data != null) {
            data.clipData?.let { cd -> for (i in 0 until cd.itemCount) uris.add(cd.getItemAt(i).uri) }
            if (uris.isEmpty()) data.data?.let { uris.add(it) }
        }
        val cb = onPicked
        Thread {
            val out = uris.mapNotNull { try { Uploads.upload(this, it) } catch (_: Exception) { null } }
            runOnUiThread { cb?.invoke(out); finish() }
        }.start()
        if (uris.isEmpty()) finish()
    }
}

/** The assistant panel: listen → ask the chosen bot → show and speak the answer. */
class AssistPanel(private val ctx: Context, private val close: () -> Unit) {
    private val voice = Voice(ctx)
    private val dp = ctx.resources.displayMetrics.density
    private fun px(v: Int) = (v * dp).toInt()
    private val accent = Color.parseColor("#0B7465")

    private val title = TextView(ctx).apply { setTextColor(Color.WHITE); textSize = 16f; setTypeface(typeface, android.graphics.Typeface.BOLD) }
    private val heard = TextView(ctx).apply { setTextColor(Color.parseColor("#C9CEDA")); textSize = 18f; setPadding(0, px(10), 0, px(6)) }
    // At most 8 lines (scrolls), so the screen behind stays visible.
    private val answer = TextView(ctx).apply {
        setTextColor(Color.WHITE); textSize = 17f; setPadding(0, px(6), 0, px(6))
        maxLines = 8
        isVerticalScrollBarEnabled = true
        movementMethod = android.text.method.ScrollingMovementMethod()
    }
    private val statusLine = TextView(ctx).apply { setTextColor(Color.parseColor("#97A7A3")); textSize = 13f }
    private var botId: String? = null
    private var speak = true
    @Volatile private var active = false
    private var screen: ScreenReader.Screen? = null
    private var screenshot: android.graphics.Bitmap? = null
    private val files = mutableListOf<JSONObject>()
    private val prefs = ctx.getSharedPreferences("assistant", Context.MODE_PRIVATE)
    private var includeScreen = prefs.getBoolean("includeScreen", true)
    private val chips = TextView(ctx).apply { setTextColor(Color.parseColor("#C9CEDA")); textSize = 13f; visibility = View.GONE }
    private val screenToggle = TextView(ctx).apply {
        textSize = 13f
        setPadding(0, px(8), 0, 0)
        setOnClickListener {
            includeScreen = !includeScreen
            prefs.edit().putBoolean("includeScreen", includeScreen).apply()
            refreshScreenLabel()
        }
    }

    fun setScreen(s: ScreenReader.Screen?) { screen = s; ui { refreshScreenLabel() } }
    fun setScreenshot(b: android.graphics.Bitmap) { screenshot = b; ui { refreshScreenLabel() } }

    private fun refreshScreenLabel() {
        val what = listOfNotNull(screen?.app, if (screenshot != null) "screenshot" else null).joinToString(" + ")
        screenToggle.setTextColor(if (includeScreen) Color.parseColor("#43C6B0") else Color.parseColor("#7A8294"))
        screenToggle.text = if (screen == null && screenshot == null) "Screen: not shared (turn on “Use text from screen” in assistant settings)"
        else "${if (includeScreen) "☑" else "☐"} Include what's on screen${if (what.isNotEmpty()) " ($what)" else ""}"
    }

    private fun refreshChips() {
        chips.visibility = if (files.isEmpty()) View.GONE else View.VISIBLE
        chips.text = files.joinToString("   ") { (if (it.optString("mime").startsWith("image/") || it.optString("name").startsWith("photo-")) "📷 " else "📎 ") + it.optString("name") }
    }

    private val mic = Button(ctx).apply {
        text = "🎤  Talk"
        isAllCaps = false
        setTextColor(Color.WHITE)
        background = GradientDrawable().apply { cornerRadius = px(24).toFloat(); setColor(accent) }
        setOnClickListener { voice.stopSpeaking(); listen() }
    }
    private val addFile = Button(ctx).apply {
        text = "📎"
        setTextColor(Color.WHITE)
        background = GradientDrawable().apply { cornerRadius = px(24).toFloat(); setColor(Color.parseColor("#22302D")) }
        setOnClickListener {
            FilePickActivity.onPicked = { picked -> files.addAll(picked); refreshChips(); statusLine.text = if (picked.isEmpty()) "" else "Added. Tap Talk and say what to do with it." }
            ctx.startActivity(Intent(ctx, FilePickActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
    private val takePhoto = Button(ctx).apply {
        text = "📷"
        setTextColor(Color.WHITE)
        background = GradientDrawable().apply { cornerRadius = px(24).toFloat(); setColor(Color.parseColor("#22302D")) }
        setOnClickListener {
            FilePickActivity.onPicked = { picked -> files.addAll(picked); refreshChips(); statusLine.text = if (picked.isEmpty()) "" else "Photo added. Tap Talk and say what to do with it." }
            ctx.startActivity(Intent(ctx, FilePickActivity::class.java).putExtra("camera", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
    private val open = Button(ctx).apply {
        text = "Open chat"
        isAllCaps = false
        setTextColor(Color.WHITE)
        background = GradientDrawable().apply { cornerRadius = px(24).toFloat(); setColor(Color.parseColor("#22302D")) }
        setOnClickListener {
            ctx.startActivity(Intent(ctx, MainActivity::class.java).putExtra("botId", botId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            close()
        }
    }

    val view: View = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.BOTTOM
        // Clear background: the screen you were on stays visible above the panel.
        setBackgroundColor(Color.TRANSPARENT)
        setOnClickListener { close() }
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(20), px(18), px(20), px(24))
            background = GradientDrawable().apply {
                cornerRadii = floatArrayOf(px(24).toFloat(), px(24).toFloat(), px(24).toFloat(), px(24).toFloat(), 0f, 0f, 0f, 0f)
                setColor(Color.parseColor("#111A18"))
            }
            isClickable = true
            addView(title)
            addView(statusLine)
            addView(screenToggle)
            addView(chips)
            addView(heard)
            // Answers scroll inside a short area so most of the screen stays visible.
            addView(answer)
            addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, px(12), 0, 0)
                addView(addFile, LinearLayout.LayoutParams(px(52), px(48)).apply { marginEnd = px(6) })
                addView(takePhoto, LinearLayout.LayoutParams(px(52), px(48)).apply { marginEnd = px(6) })
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
        title.text = "DanDroid"
        statusLine.text = "Getting ready…"
        heard.text = ""
        answer.text = ""
        files.clear()
        refreshChips()
        refreshScreenLabel()
        try { EngineService.start(ctx) } catch (_: Exception) {}
        Thread {
            try {
                val a = engine("/api/assistant", null, 5000)
                botId = a.optString("botId").ifBlank { null }
                speak = a.optBoolean("speak", true)
                // The speech service chosen in Settings (else Google's first).
                voice.chosen = a.optString("recognizer").takeIf { it.isNotBlank() }?.let { android.content.ComponentName.unflattenFromString(it) }
                ui { title.text = "${a.optString("emoji")} ${a.optString("botName", "DanDroid")}"; listen() }
            } catch (e: Exception) {
                ui { statusLine.text = "DanDroid is still starting. Try again in a moment." }
            }
        }.start()
    }

    private fun listen() {
        if (!active) return
        if (ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            statusLine.text = "Open DanDroid once and allow the microphone, then try again."
            return
        }
        statusLine.text = "Listening…"
        mic.text = "🎤  Listening…"
        voice.listenWithFallback(object : Voice.Listener {
            override fun onPartial(text: String) { heard.text = "“$text”" }
            override fun onFinal(text: String) {
                heard.text = "“$text”"
                mic.text = "🎤  Talk"
                ask(text)
            }
            override fun onError(message: String, code: Int) {
                statusLine.text = message
                mic.text = "🎤  Talk"
            }
        })
    }

    private fun ask(text: String) {
        statusLine.text = "Thinking…"
        Thread {
            try {
                val body = JSONObject().put("text", text)
                val ids = org.json.JSONArray()
                files.forEach { ids.put(it.optString("id")) }
                if (includeScreen) {
                    screen?.let { body.put("screen", JSONObject().put("app", it.app).put("url", it.url).put("text", it.text)) }
                    screenshot?.let { bmp ->
                        val out = java.io.ByteArrayOutputStream()
                        android.graphics.Bitmap.createScaledBitmap(bmp, bmp.width / 2, bmp.height / 2, true).compress(android.graphics.Bitmap.CompressFormat.JPEG, 75, out)
                        try { ids.put(Uploads.uploadBytes(ctx, "screenshot.jpg", "image/jpeg", out.toByteArray()).optString("id")) } catch (_: Exception) {}
                    }
                }
                body.put("attachments", ids)
                val r = engine("/api/assistant/ask", body)
                val reply = r.optString("reply").takeIf { !r.isNull("reply") }
                ui {
                    if (reply == null) {
                        statusLine.text = "Still working — you'll get a notification when it's done."
                    } else {
                        statusLine.text = ""
                        answer.text = hideCues(reply)
                        // Spoken by the engine: your chosen voice engine (e.g. Phonon) and natural delivery.
                        if (speak) Thread {
                            try { engine("/api/voice/speak", JSONObject().put("text", reply), 20_000) }
                            catch (_: Exception) { ui { voice.speak(speakable(hideCues(reply))) } }
                        }.start()
                    }
                }
            } catch (e: Exception) {
                ui { statusLine.text = "Couldn't reach your bot: ${e.message}" }
            }
        }.start()
    }

    /** Delivery cues ("{pause 300}") are for the voice only. */
    private fun hideCues(t: String) = t.replace(Regex("\\{\\s*(?:pause\\s+\\d+(?:ms)?|faster|slower|higher|lower|warm|excited|gentle|serious|laugh|chuckle|sigh|breath|(?:rate|speed|pitch)\\s+[\\d.]+|react\\s+[a-z-]+|source\\s+[^{}]*)\\s*\\}", RegexOption.IGNORE_CASE), "").replace(Regex(" {2,}"), " ")

    private fun speakable(t: String) = t.replace(Regex("```[\\s\\S]*?```"), " (code) ").replace(Regex("\\[([^\\]]+)\\]\\([^)]+\\)"), "$1")
        .replace(Regex("https?://\\S+"), "a link").replace(Regex("[*_#>`|]"), "").replace(Regex("\\s+"), " ").trim()

    fun stop() {
        active = false
        voice.stopListening()
        voice.stopSpeaking()
        Thread { runCatching { engine("/api/voice/stop", JSONObject(), 5_000) } }.start()
        voice.shutdown()
    }
}
