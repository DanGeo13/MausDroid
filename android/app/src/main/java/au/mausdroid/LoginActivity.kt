package au.mausdroid

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Where YOU sign in to a website a bot needs (school intranet, Drive, etc.).
 * It runs in the engine's process, so the background browser shares the
 * login afterwards. The bot never sees your password.
 */
class LoginActivity : Activity() {
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra("url") ?: return finish()
        val bot = intent.getStringExtra("bot").orEmpty()
        val reason = intent.getStringExtra("reason").orEmpty()
        val web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = WebViewClient()
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(24, 48, 24, 16)
            addView(TextView(context).apply {
                text = "Sign in for ${bot.ifBlank { "your bot" }}${if (reason.isNotBlank()) " — $reason" else ""}"
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            addView(Button(context).apply {
                text = "Done"
                setOnClickListener {
                    CookieManager.getInstance().flush()
                    finish()
                }
            })
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(bar)
            addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        })
        web.loadUrl(url)
    }

    override fun onPause() {
        CookieManager.getInstance().flush()
        super.onPause()
    }
}
