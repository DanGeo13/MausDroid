package au.mausdroid

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * Runs the built-in Tailscale node (tsbridge) as a small child process. It
 * joins your tailnet with your auth key, so you never open the Tailscale app.
 */
class TailscaleManager(private val ctx: Context) {
    @Volatile private var proc: Process? = null
    @Volatile private var wanted = false
    private var hostname = "mausdroid"
    private var authKey = ""
    private val stateDir = File(ctx.filesDir, "tailscale")
    private val statusFile = File(stateDir, "status.json")

    @Synchronized
    fun start(host: String, key: String) {
        hostname = host.ifBlank { "mausdroid" }
        if (key.isNotBlank()) authKey = key
        wanted = true
        stopProcess()
        launch()
    }

    @Synchronized
    fun stop() {
        wanted = false
        stopProcess()
    }

    private fun stopProcess() {
        proc?.destroy()
        proc = null
    }

    private fun launch() {
        stateDir.mkdirs()
        val bin = File(ctx.applicationInfo.nativeLibraryDir, "libtsbridge.so")
        val pb = ProcessBuilder(
            bin.absolutePath,
            "--state", stateDir.absolutePath,
            "--hostname", hostname,
            "--forward", "127.0.0.1:${MausApp.ENGINE_PORT}",
            "--proxy", "127.0.0.1:${MausApp.TAILNET_PROXY_PORT}",
            "--status", statusFile.absolutePath,
        ).redirectErrorStream(true)
        pb.environment()["TS_AUTHKEY"] = authKey
        pb.environment()["HOME"] = stateDir.absolutePath
        pb.environment()["TMPDIR"] = ctx.cacheDir.absolutePath
        val p = pb.start()
        proc = p
        Thread {
            p.inputStream.bufferedReader().forEachLine { Log.i("MausTailscale", it) }
            val code = p.waitFor()
            Log.w("MausTailscale", "tsbridge exited with $code")
            // Restart automatically (network changes, crashes) while it's switched on.
            if (wanted && proc === p) {
                Thread.sleep(5000)
                synchronized(this) { if (wanted && proc === p) launch() }
            }
        }.apply { isDaemon = true }.start()
    }

    fun status(): JSONObject {
        if (!wanted) return JSONObject().put("state", "Off")
        return try {
            JSONObject(statusFile.readText())
        } catch (e: Exception) {
            JSONObject().put("state", "Starting")
        }
    }
}
