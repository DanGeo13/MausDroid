package au.mausdroid

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.provider.MediaStore
import android.speech.RecognizerIntent
import android.webkit.JavascriptInterface
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
    companion object {
        private const val DICTATE = 4712
        const val PICK_FILES = 41
    }

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
        // Always load the current engine's screens, never ones saved from an older version.
        web.clearCache(true)
        web.webChromeClient = object : WebChromeClient() {
            // The 📎 button: Android's file picker (any type, several at once), with the camera offered too.
            // The 📷 button (capture): straight to the camera.
            override fun onShowFileChooser(view: WebView, callback: android.webkit.ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val accept = params.acceptTypes.joinToString(",")
                val video = accept.contains("video") && !accept.contains("image")
                val cameraIntent = cameraIntent(video)
                return try {
                    if (params.isCaptureEnabled && cameraIntent != null) {
                        startActivityForResult(cameraIntent, PICK_FILES)
                    } else {
                        val pick = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                        val chooser = Intent.createChooser(pick, "Add files")
                        val extras = listOfNotNull(cameraIntent(false), cameraIntent(true))
                        if (extras.isNotEmpty()) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, extras.toTypedArray())
                        startActivityForResult(chooser, PICK_FILES)
                    }
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }
        web.addJavascriptInterface(Shell(), "MausDroidShell")
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
                // Links win over plain bot chats (a briefing notification also names its bot).
                val l = pendingLink
                if (l != null) view.postDelayed({ openLink(l) }, 400) else pendingBot?.let { openBot(it) }
                view.postDelayed({ deliverShare() }, 800)
            }
        }
        pendingBot = intent.getStringExtra("botId")
        pendingLink = intent.getStringExtra("link")?.takeIf { it.isNotBlank() }
        askMicrophoneOnce()
        handleShare(intent)
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

    /** Location for bots that need it, asked only when you tap Allow in Settings (never silently). */
    private fun askLocation() {
        val p = DeviceLocation.permissionState(this)
        if (p == "granted") return
        if (p == "permanently_denied") {
            DeviceSettings.open(this, "app")
            Toast.makeText(this, "Location is blocked for MausDroid. Allow it under Permissions → Location.", Toast.LENGTH_LONG).show()
            return
        }
        requestPermissions(arrayOf(android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION), 12)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != 12) return
        val granted = grantResults.any { it == android.content.pm.PackageManager.PERMISSION_GRANTED }
        val canAskAgain = shouldShowRequestPermissionRationale(android.Manifest.permission.ACCESS_FINE_LOCATION)
        DeviceLocation.recordAnswer(this, if (granted) "granted" else if (canAskAgain) "denied" else "permanently_denied")
    }

    private fun openBot(botId: String) {
        web.evaluateJavascript("window.mausdroidOpen && window.mausdroidOpen(${org.json.JSONObject.quote(botId)})", null)
        pendingBot = null
    }

    /** Notification links such as "briefing:<id>" open that screen. */
    private var pendingLink: String? = null
    private fun openLink(link: String) {
        web.evaluateJavascript("window.mausdroidLink && window.mausdroidLink(${org.json.JSONObject.quote(link)})", null)
        pendingLink = null
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra("askMic", false)) askMicrophoneOnce(force = true)
        if (intent.getBooleanExtra("askLocation", false)) askLocation()
        handleShare(intent)
        val link = intent.getStringExtra("link")?.takeIf { it.isNotBlank() }
        if (link != null) { if (loaded) openLink(link) else pendingLink = link }
        else intent.getStringExtra("botId")?.let { if (loaded) openBot(it) else pendingBot = it }
    }

    private var fileCallback: android.webkit.ValueCallback<Array<Uri>>? = null
    private var pendingPhoto: java.io.File? = null
    private var pendingVideo: java.io.File? = null

    /** The phone's camera app, saving into MausDroid's cache (no camera permission needed). */
    private fun cameraIntent(video: Boolean): Intent? {
        val i = Intent(if (video) MediaStore.ACTION_VIDEO_CAPTURE else MediaStore.ACTION_IMAGE_CAPTURE)
        if (i.resolveActivity(packageManager) == null) return null
        val dir = java.io.File(cacheDir, "camera").apply { mkdirs() }
        val f = java.io.File(dir, "${if (video) "video" else "photo"}-${System.currentTimeMillis()}.${if (video) "mp4" else "jpg"}")
        val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.files", f)
        if (video) pendingVideo = f else pendingPhoto = f
        return i.putExtra(MediaStore.EXTRA_OUTPUT, uri)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .also { it.clipData = android.content.ClipData.newRawUri("", uri) }
    }

    private fun jsScan(text: String?, error: String?) = web.evaluateJavascript(
        "window.mausdroidScan && window.mausdroidScan(${if (text == null) "null" else org.json.JSONObject.quote(text)}, ${if (error == null) "null" else org.json.JSONObject.quote(error)})", null)

    /** Things the app's screens can ask the phone for. */
    inner class Shell {
        /** Scans a QR code (linking a PC); the text comes back through window.mausdroidScan(text, error). */
        @JavascriptInterface
        fun scanQr(): Boolean {
            runOnUiThread {
                try {
                    val opts = com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions.Builder()
                        .setBarcodeFormats(com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE).build()
                    com.google.mlkit.vision.codescanner.GmsBarcodeScanning.getClient(this@MainActivity, opts).startScan()
                        .addOnSuccessListener { b -> jsScan(b.rawValue ?: "", null) }
                        .addOnCanceledListener { jsScan(null, null) }
                        .addOnFailureListener { e -> jsScan(null, "The scanner couldn't start (${e.message}). Type the code shown on your PC instead.") }
                } catch (e: Throwable) {
                    jsScan(null, "The scanner isn't available on this phone. Type the code shown on your PC instead.")
                }
            }
            return true
        }

        /** Google's speech pop-up; the words come back through window.mausdroidDictation(text, error). */
        @JavascriptInterface
        fun dictate(): Boolean {
            val i = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak to your bot")
            if (i.resolveActivity(packageManager) == null) return false
            runOnUiThread {
                try {
                    startActivityForResult(i, DICTATE)
                } catch (e: Exception) {
                    web.evaluateJavascript("window.mausdroidDictation && window.mausdroidDictation(null, ${org.json.JSONObject.quote("Speech input couldn't start: ${e.message}")})", null)
                }
            }
            return true
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == DICTATE) {
            val text = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            val error = if (resultCode == RESULT_OK || resultCode == RESULT_CANCELED) null else "Speech input failed (code $resultCode)."
            web.evaluateJavascript("window.mausdroidDictation && window.mausdroidDictation(${if (text == null) "null" else org.json.JSONObject.quote(text)}, ${if (error == null) "null" else org.json.JSONObject.quote(error)})", null)
            return
        }
        if (requestCode != PICK_FILES) return
        val uris = mutableListOf<Uri>()
        if (resultCode == RESULT_OK && data != null) {
            data.clipData?.let { cd -> for (i in 0 until cd.itemCount) uris.add(cd.getItemAt(i).uri) }
            if (uris.isEmpty()) data.data?.let { uris.add(it) }
        }
        // A photo or video from the camera is saved where we asked, not returned in data.
        if (resultCode == RESULT_OK && uris.isEmpty()) {
            listOfNotNull(pendingPhoto, pendingVideo).firstOrNull { f -> f.exists() && f.length() > 0 }?.let { f ->
                uris.add(androidx.core.content.FileProvider.getUriForFile(this, "$packageName.files", f))
            }
        }
        listOfNotNull(pendingPhoto, pendingVideo).filter { it.length() == 0L }.forEach { it.delete() }
        pendingPhoto = null
        pendingVideo = null
        fileCallback?.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
        fileCallback = null
    }

    /** Files and links shared to MausDroid from any app: saved, then "which bot?" opens. */
    private fun handleShare(intent: Intent?) {
        if (intent == null || (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE)) return
        val uris = mutableListOf<Uri>()
        if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            @Suppress("DEPRECATION") intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
        } else {
            @Suppress("DEPRECATION") (intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))?.let { uris.add(it) }
        }
        intent.clipData?.let { cd -> for (i in 0 until cd.itemCount) cd.getItemAt(i).uri?.let { if (it !in uris) uris.add(it) } }
        val text = listOfNotNull(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()).joinToString("\n").trim()
        intent.action = null // handle once
        Thread {
            for (i in 0 until 240) { if (engineUp()) break; Thread.sleep(250) }
            val files = org.json.JSONArray()
            for (u in uris) try { files.put(Uploads.upload(this, u)) } catch (e: Exception) { Diag.log(this, "share upload failed: $e") }
            val payload = org.json.JSONObject().put("attachments", files).put("text", text)
            // Straight to Maus, which sorts it into your routines; the old "which bot?" sheet only if that fails.
            val sent = try { postShare(payload) } catch (e: Exception) { Diag.log(this, "share to Maus failed: $e"); null }
            runOnUiThread {
                if (sent != null) {
                    Toast.makeText(this, "Sent to ${sent.optString("botName", "Maus")} (${sent.optString("kind")}) — it'll sort it into your routines", Toast.LENGTH_LONG).show()
                    val botId = sent.optString("botId")
                    if (loaded) openBot(botId) else pendingBot = botId
                } else { pendingShare = payload.toString(); deliverShare() }
            }
        }.start()
    }

    private fun postShare(payload: org.json.JSONObject): org.json.JSONObject? {
        val c = URL("http://127.0.0.1:${MausApp.ENGINE_PORT}/api/share").openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.doOutput = true
        c.connectTimeout = 3000
        c.readTimeout = 15000
        c.setRequestProperty("authorization", "Bearer ${MausApp.secret(this, "ui-token")}")
        c.setRequestProperty("content-type", "application/json")
        c.outputStream.use { it.write(payload.toString().toByteArray()) }
        if (c.responseCode != 200) return null
        return org.json.JSONObject(c.inputStream.bufferedReader().readText())
    }

    private var pendingShare: String? = null
    private fun deliverShare() {
        val p = pendingShare ?: return
        if (!loaded) return
        web.evaluateJavascript("window.mausdroidShare && window.mausdroidShare($p)", null)
        pendingShare = null
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
