package au.mausdroid

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.app.ActivityManager
import android.content.ClipData
import android.content.ClipboardManager
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL

/**
 * The screen you see. It shows the engine's web interface (which updates
 * itself), so closing this screen never stops the bots.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private var pendingBot: String? = null
    private var loaded = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            EngineService.start(this)
        } catch (e: Exception) {
            Diag.log(this, "could not start engine service: $e")
        }
        window.statusBarColor = Color.parseColor("#0B0D12")
        window.navigationBarColor = Color.parseColor("#0B0D12")
        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#0B0D12"))
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == "127.0.0.1" && u.port == MausApp.ENGINE_PORT) return false
                // Links in chats open in your normal browser.
                startActivity(Intent(Intent.ACTION_VIEW, u))
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                loaded = true
                pendingBot?.let { openBot(it) }
            }
        }
        pendingBot = intent.getStringExtra("botId")
        askMicrophoneOnce()
        showSplash()
        waitForEngine()
    }

    private val bg = Color.parseColor("#0B0D12")
    private var waiting = false

    private fun showSplash() {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(bg)
            addView(ImageView(context).apply {
                setImageResource(R.mipmap.ic_launcher)
                layoutParams = LinearLayout.LayoutParams(dp(96), dp(96))
            })
            addView(TextView(context).apply {
                text = "MausDroid"
                setTextColor(Color.WHITE)
                textSize = 24f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                setPadding(0, dp(16), 0, dp(4))
                gravity = Gravity.CENTER
            })
            addView(TextView(context).apply {
                id = android.R.id.text1
                text = "Starting your bots…"
                setTextColor(Color.parseColor("#9AA3AF"))
                textSize = 15f
                gravity = Gravity.CENTER
            })
            addView(ProgressBar(context).apply { setPadding(0, dp(24), 0, 0) })
        }
        setContentView(box)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun engineUp(): Boolean = try {
        val c = URL("http://127.0.0.1:${MausApp.ENGINE_PORT}/api/whoami").openConnection() as HttpURLConnection
        c.connectTimeout = 700
        c.readTimeout = 2000
        c.responseCode == 200
    } catch (_: Exception) {
        false
    }

    private fun waitForEngine() {
        if (waiting) return
        waiting = true
        Thread {
            val start = System.currentTimeMillis()
            var shownHelp = false
            while (true) {
                if (engineUp()) {
                    runOnUiThread { waiting = false; showWeb() }
                    return@Thread
                }
                val secs = (System.currentTimeMillis() - start) / 1000
                if (secs in 8..24) runOnUiThread { findViewById<TextView>(android.R.id.text1)?.text = "First start takes a little longer…" }
                if (secs >= 25 && !shownHelp) {
                    shownHelp = true
                    runOnUiThread { showDiagnostics() }
                }
                Thread.sleep(500)
            }
        }.start()
    }

    private fun showWeb() {
        if (web.parent == null) setContentView(web)
        web.loadUrl("http://127.0.0.1:${MausApp.ENGINE_PORT}/?t=${MausApp.secret(this, "ui-token")}")
    }

    /** Shown when the engine doesn't start: what went wrong, and buttons to retry or send the report. */
    private fun showDiagnostics() {
        val report = Diag.report(this)
        val text = TextView(this).apply {
            this.text = report
            setTextColor(Color.parseColor("#D1D5DB"))
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            setTextIsSelectable(true)
            setPadding(dp(16), dp(8), dp(16), dp(16))
        }
        fun btn(label: String, onClick: () -> Unit) = Button(this).apply {
            this.text = label
            isAllCaps = false
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(8), 0, dp(8), dp(8))
            addView(btn("Try again") { restartEngine() })
            addView(btn("Copy report") {
                getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("MausDroid report", Diag.report(this@MainActivity)))
                Toast.makeText(this@MainActivity, "Copied — paste it to Claude", Toast.LENGTH_SHORT).show()
            })
            addView(btn("Share report") {
                startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, Diag.report(this@MainActivity)), "Share report"))
            })
        }
        val title = TextView(this).apply {
            this.text = "MausDroid is taking too long to start"
            setTextColor(Color.WHITE)
            textSize = 18f
            setPadding(dp(16), dp(48), dp(16), dp(4))
        }
        val sub = TextView(this).apply {
            this.text = "It keeps trying in the background and will open by itself. If it doesn't, tap Try again, or Copy report and send it so it can be fixed."
            setTextColor(Color.parseColor("#9AA3AF"))
            setPadding(dp(16), 0, dp(16), dp(12))
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(bg)
            addView(title)
            addView(sub)
            addView(buttons)
            addView(ScrollView(context).apply { addView(text) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        })
    }

    private fun restartEngine() {
        Diag.clearCrashes(this)
        Diag.log(this, "user tapped Try again")
        val am = getSystemService(ActivityManager::class.java)
        am.runningAppProcesses?.firstOrNull { it.processName.endsWith(":engine") }?.let { android.os.Process.killProcess(it.pid) }
        Thread {
            Thread.sleep(800)
            runOnUiThread {
                EngineService.start(this)
                showSplash()
                waiting = false
                waitForEngine()
            }
        }.start()
    }

    /** Microphone for talking to bots and the assistant; asked once, or when Settings asks again. */
    private fun askMicrophoneOnce(force: Boolean = false) {
        val prefs = getSharedPreferences("ui", MODE_PRIVATE)
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) return
        if (!force && prefs.getBoolean("askedMic", false)) return
        prefs.edit().putBoolean("askedMic", true).apply()
        requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), 9)
    }

    private fun openBot(botId: String) {
        web.evaluateJavascript("window.mausdroidOpen && window.mausdroidOpen(${org.json.JSONObject.quote(botId)})", null)
        pendingBot = null
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra("askMic", false)) askMicrophoneOnce(force = true)
        intent.getStringExtra("botId")?.let { if (loaded) openBot(it) else pendingBot = it }
    }

    private var lastBackAt = 0L

    /**
     * Phone Back button / back gesture: go back one screen inside MausDroid.
     * On the home screen, the first press only shows a hint; a second press
     * within 2 seconds leaves (the bots keep working in the background).
     */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (!loaded) return leaveOrHint()
        web.evaluateJavascript("window.mausdroidBack ? window.mausdroidBack() : false") { r ->
            if (r != "true") leaveOrHint()
        }
    }

    private fun leaveOrHint() {
        val now = System.currentTimeMillis()
        if (now - lastBackAt < 2000) {
            moveTaskToBack(true) // never closes MausDroid; it just goes to the background
        } else {
            lastBackAt = now
            Toast.makeText(this, "Press back again to leave — your bots keep working", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onResume() {
        super.onResume()
        if (loaded) web.evaluateJavascript("document.dispatchEvent(new Event('visibilitychange'))", null)
    }
}
