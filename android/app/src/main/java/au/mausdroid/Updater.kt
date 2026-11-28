package au.mausdroid

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.zip.ZipInputStream

/**
 * Self-updating without reinstalling. The engine (all bot logic and every
 * screen) is a signed bundle the app downloads from the DanDroid repo and
 * swaps in by itself. Only rare changes to the Android shell need a new APK,
 * and then you get one notification to tap.
 *
 * Safety: every update must carry a signature made with the DanDroid
 * update key; a bundle that fails to start is rolled back automatically.
 */
class Updater(private val ctx: Context) {
    private val root = File(ctx.filesDir, "engines").apply { mkdirs() }
    private val currentFile = File(root, "current.txt")
    private val trialFile = File(root, "trial.txt")
    private val triedFile = File(root, "trial-started.txt")
    private val badFile = File(root, "bad.txt")
    private val prefs = ctx.getSharedPreferences("updater", Context.MODE_PRIVATE)

    @Volatile var state = "idle"

    @Volatile var appUpdate: String? = null
    @Volatile var message = ""
    @Volatile var available: String? = null
    @Volatile private var staged: String? = null

    fun bundledVersion(): String = ctx.assets.open("engine-version.txt").bufferedReader().readText().trim()

    /** Picks the engine folder to run now, installing the built-in one when needed. */
    fun engineDirForLaunch(): File {
        // A trial update that already got one chance without saying "ready" is rolled back.
        if (trialFile.exists()) {
            val v = trialFile.readText().trim()
            if (triedFile.exists()) {
                Log.w(TAG, "Engine $v did not start; rolling back")
                badFile.appendText("$v\n")
                trialFile.delete(); triedFile.delete()
                message = "Update $v didn't start properly, so the previous version was kept."
            } else {
                triedFile.writeText(v)
                File(root, v).takeIf { File(it, "engine.cjs").exists() }?.let { return it }
            }
        }
        val bundled = bundledVersion()
        val bad = if (badFile.exists()) badFile.readLines().map { it.trim() } else emptyList()
        val current = currentFile.takeIf { it.exists() }?.readText()?.trim()?.takeIf { it !in bad }
        val use = if (current == null || compare(bundled, current) > 0) bundled else current
        val dir = File(root, use)
        if (use == bundled && !File(dir, "engine.cjs").exists()) {
            dir.deleteRecursively()
            unzip(ctx.assets.open("engine.zip"), dir)
            currentFile.writeText(bundled)
        }
        if (!File(dir, "engine.cjs").exists()) {
            File(root, bundled).deleteRecursively()
            unzip(ctx.assets.open("engine.zip"), File(root, bundled))
            currentFile.writeText(bundled)
            return File(root, bundled)
        }
        return dir
    }

    /**
     * A downloaded engine that keeps crashing is set aside for good and the
     * built-in one is used. False when it is the built-in one (nothing to go back to).
     */
    fun markBad(version: String): Boolean {
        if (version == bundledVersion()) return false
        badFile.appendText("$version\n")
        if (currentFile.exists() && currentFile.readText().trim() == version) currentFile.delete()
        trialFile.delete(); triedFile.delete()
        message = "Update $version didn't start properly, so the built-in version is used."
        return true
    }

    /** The engine said it started fine: keep this version. */
    fun confirmReady(version: String) {
        if (trialFile.exists() && trialFile.readText().trim() == version) {
            currentFile.writeText(version)
            trialFile.delete(); triedFile.delete()
            message = "Updated to $version."
            // Old versions are removed, keeping the current one.
            root.listFiles()?.filter { it.isDirectory && it.name != version }?.forEach { it.deleteRecursively() }
        }
    }

    fun runningVersion(): String = trialFile.takeIf { it.exists() }?.readText()?.trim() ?: currentFile.takeIf { it.exists() }?.readText()?.trim() ?: bundledVersion()

    fun status(): JSONObject = JSONObject()
        .put("state", state).put("message", message).put("available", available ?: JSONObject.NULL)
        .put("appUpdate", appUpdate ?: JSONObject.NULL)
        .put("engineVersion", runningVersion()).put("apkVersion", BuildConfig.VERSION_NAME)
        .put("lastChecked", prefs.getLong("lastChecked", 0).takeIf { it > 0 }?.let { java.time.Instant.ofEpochMilli(it).toString() } ?: JSONObject.NULL)

    private fun get(url: String): ByteArray {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 20_000
        c.readTimeout = 120_000
        c.setRequestProperty("cache-control", "no-cache")
        if (c.responseCode != 200) throw RuntimeException("HTTP ${c.responseCode} for $url")
        return c.inputStream.use { it.readBytes() }
    }

    private fun verify(payload: String, sigB64: String): Boolean {
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.decode(BuildConfig.UPDATE_PUBLIC_KEY, Base64.DEFAULT)))
        val s = Signature.getInstance("SHA256withECDSA")
        s.initVerify(key)
        s.update(payload.toByteArray())
        return s.verify(Base64.decode(sigB64, Base64.DEFAULT))
    }

    private fun sha256(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    /** Checks for updates; downloads a new engine and stages it. Returns the status. */
    @Synchronized
    fun check(): JSONObject {
        state = "checking"
        try {
            val doc = JSONObject(String(get(BuildConfig.UPDATE_URL + "?t=" + System.currentTimeMillis())))
            val payloadText = doc.getString("payload")
            if (!verify(payloadText, doc.getString("signature"))) throw SecurityException("Update signature is wrong — ignored.")
            val payload = JSONObject(payloadText)
            prefs.edit().putLong("lastChecked", System.currentTimeMillis()).apply()

            // A problem fetching the new app version must never stop the engine update below.
            appUpdate = null
            payload.optJSONObject("apk")?.let { apk ->
                if (apk.getInt("versionCode") > BuildConfig.VERSION_CODE) {
                    appUpdate = try { offerApk(apk); "Version ${apk.optString("versionName")} is ready — tap the notification to install." }
                    catch (e: Exception) { Log.w(TAG, "app update download failed", e); "Version ${apk.optString("versionName")} couldn't be downloaded (${e.message}). Get it from ${apk.getString("url")}" }
                }
            }
            val eng = payload.getJSONObject("engine")
            val v = eng.getString("version")
            val minApk = eng.optInt("minApk", 0)
            val bad = if (badFile.exists()) badFile.readLines() else emptyList()
            available = null
            when {
                compare(v, runningVersion()) <= 0 -> { state = "up to date"; return status() }
                v in bad -> { state = "skipped"; message = "Update $v was rolled back earlier."; return status() }
                minApk > BuildConfig.VERSION_CODE -> { state = "needs app update"; message = "Install the new app version first."; return status() }
            }
            available = v
            if (staged != v) {
                state = "downloading"
                val zip = get(eng.getString("url"))
                if (sha256(zip) != eng.getString("sha256")) throw SecurityException("Downloaded update is damaged — ignored.")
                val dir = File(root, v)
                dir.deleteRecursively()
                unzip(zip.inputStream(), dir)
                if (!File(dir, "engine.cjs").exists()) throw RuntimeException("Update is missing engine.cjs")
                staged = v
            }
            state = "ready"
            message = "Version $v is ready."
        } catch (e: Exception) {
            state = "error"
            message = e.message ?: e.toString()
            Log.w(TAG, "update check failed", e)
        }
        return status()
    }

    /** Switches to the staged engine on the next engine start. */
    fun stageForRestart(): Boolean {
        val v = staged ?: return false
        trialFile.writeText(v)
        triedFile.delete()
        return true
    }

    private fun offerApk(apk: JSONObject) {
        val file = File(ctx.cacheDir, "update.apk")
        // Streamed to a file (the app is ~28 MB), checked before it's offered.
        val part = File(ctx.cacheDir, "update.apk.part")
        val c = URL(apk.getString("url")).openConnection() as HttpURLConnection
        c.connectTimeout = 20_000
        c.readTimeout = 60_000
        if (c.responseCode != 200) throw RuntimeException("HTTP ${c.responseCode}")
        val md = MessageDigest.getInstance("SHA-256")
        c.inputStream.use { input -> part.outputStream().use { out ->
            val buf = ByteArray(64 * 1024)
            while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n); out.write(buf, 0, n) }
        } }
        if (md.digest().joinToString("") { "%02x".format(it) } != apk.getString("sha256")) { part.delete(); throw SecurityException("Downloaded app update is damaged — ignored.") }
        file.delete()
        part.renameTo(file)
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", file)
        val install = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(ctx, 77, install, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(ctx, MausApp.CH_ALERTS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("DanDroid ${apk.getString("versionName")} is ready")
            .setContentText("Tap to install. Your bots, chats and settings stay.")
            .setContentIntent(pi).setAutoCancel(true).build()
        ctx.getSystemService(NotificationManager::class.java).notify(7700, n)
    }

    companion object {
        private const val TAG = "MausUpdater"

        fun compare(a: String, b: String): Int {
            val pa = a.split(".", "-").map { it.toIntOrNull() ?: 0 }
            val pb = b.split(".", "-").map { it.toIntOrNull() ?: 0 }
            for (i in 0 until maxOf(pa.size, pb.size)) {
                val d = (pa.getOrNull(i) ?: 0) - (pb.getOrNull(i) ?: 0)
                if (d != 0) return d
            }
            return 0
        }

        fun unzip(input: java.io.InputStream, dir: File) {
            dir.mkdirs()
            val base = dir.canonicalPath + File.separator
            ZipInputStream(input).use { zip ->
                while (true) {
                    val e = zip.nextEntry ?: break
                    val out = File(dir, e.name)
                    if (!out.canonicalPath.startsWith(base)) throw SecurityException("Bad path in update")
                    if (e.isDirectory) out.mkdirs() else {
                        out.parentFile?.mkdirs()
                        out.outputStream().use { zip.copyTo(it) }
                    }
                }
            }
        }
    }
}
