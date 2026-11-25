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
import android.widget.TextView
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
        EngineService.start(this)
        window.statusBarColor = Color.parseColor("#0f1115")
        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#0f1115"))
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
        val splash = TextView(this).apply {
            text = "🐭 Starting MausDroid…"
            setTextColor(Color.WHITE)
            textSize = 18f
            gravity = android.view.Gravity.CENTER
            setBackgroundColor(Color.parseColor("#0f1115"))
        }
        setContentView(splash)
        pendingBot = intent.getStringExtra("botId")
        Thread {
            // Wait for the engine (first start unpacks it, which takes a few seconds).
            for (i in 0 until 240) {
                try {
                    val c = URL("http://127.0.0.1:${MausApp.ENGINE_PORT}/api/whoami").openConnection() as HttpURLConnection
                    c.connectTimeout = 500
                    if (c.responseCode == 200) break
                } catch (_: Exception) {
                }
                Thread.sleep(250)
            }
            runOnUiThread {
                setContentView(web)
                web.loadUrl("http://127.0.0.1:${MausApp.ENGINE_PORT}/?t=${MausApp.secret(this, "ui-token")}")
            }
        }.start()
    }

    private fun openBot(botId: String) {
        web.evaluateJavascript("window.mausdroidOpen && window.mausdroidOpen(${org.json.JSONObject.quote(botId)})", null)
        pendingBot = null
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra("botId")?.let { if (loaded) openBot(it) else pendingBot = it }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (!loaded) return super.onBackPressed()
        web.evaluateJavascript("window.mausdroidBack ? window.mausdroidBack() : false") { r ->
            if (r != "true") moveTaskToBack(true) // keep running; never kill the app on back
        }
    }

    override fun onResume() {
        super.onResume()
        if (loaded) web.evaluateJavascript("document.dispatchEvent(new Event('visibilitychange'))", null)
    }
}
