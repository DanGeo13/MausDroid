package au.mausdroid

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Start-up diagnostics. Both processes write here, and the start screen
 * shows it if the engine doesn't come up, so problems can be reported.
 */
object Diag {
    fun file(ctx: Context) = File(ctx.filesDir, "diag.log")
    fun engineLog(ctx: Context) = File(ctx.filesDir, "engine.log")
    fun engineStatus(ctx: Context) = File(File(ctx.filesDir, "engine-data"), "engine-status.json")

    @Synchronized
    fun log(ctx: Context, msg: String) {
        try {
            val f = file(ctx)
            if (f.length() > 200_000) f.writeText(f.readText().takeLast(100_000))
            val t = SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(Date())
            f.appendText("$t [${android.os.Process.myPid()}] $msg\n")
        } catch (_: Exception) {
        }
    }

    fun report(ctx: Context): String {
        fun tail(f: File, n: Int) = if (f.exists()) f.readText().takeLast(n) else "(none)"
        return buildString {
            val page = try { android.system.Os.sysconf(android.system.OsConstants._SC_PAGESIZE) } catch (_: Exception) { -1L }
            append("DanDroid ${BuildConfig.VERSION_NAME} · ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} · Android ${android.os.Build.VERSION.RELEASE} · page ${page / 1024} KB\n\n")
            append("== App log ==\n").append(tail(file(ctx), 6000)).append("\n\n")
            append("== Engine start-up ==\n").append(tail(engineStatus(ctx), 6000)).append("\n\n")
            append("== Engine output ==\n").append(tail(engineLog(ctx), 8000))
        }
    }

    /** Counts recent engine crashes so a broken engine doesn't restart forever. */
    fun crashesRecently(ctx: Context): Int {
        val f = File(ctx.filesDir, "crash-times.txt")
        val now = System.currentTimeMillis()
        val recent = (if (f.exists()) f.readLines().mapNotNull { it.toLongOrNull() } else emptyList()).filter { now - it < 5 * 60_000 } + now
        f.writeText(recent.joinToString("\n"))
        return recent.size
    }

    fun clearCrashes(ctx: Context) = File(ctx.filesDir, "crash-times.txt").delete()
}
