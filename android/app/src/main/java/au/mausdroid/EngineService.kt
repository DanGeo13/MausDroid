package au.mausdroid

import android.app.AlarmManager
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File

/**
 * The always-running part of MausDroid (separate ":engine" process). It
 * hosts the Node.js engine, the background browser, built-in Tailscale and
 * the updater, as a foreground service so Android keeps it alive while you
 * use other apps or the screen is off.
 */
class EngineService : Service(), BridgeServer.Hooks {
    /** Created on first use (on the main thread), so a WebView problem can't stop the engine starting. */
    private val browser: BackgroundBrowser by lazy {
        if (Looper.myLooper() == Looper.getMainLooper()) BackgroundBrowser(this) else {
            val latch = java.util.concurrent.CountDownLatch(1)
            var b: BackgroundBrowser? = null
            main.post { b = BackgroundBrowser(this); latch.countDown() }
            latch.await()
            b!!
        }
    }
    private lateinit var tailscale: TailscaleManager
    private lateinit var updater: Updater
    private var bridge: BridgeServer? = null
    private val main = Handler(Looper.getMainLooper())
    private var busyLock: PowerManager.WakeLock? = null
    @Volatile private var busy = false
    @Volatile private var started = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            Diag.log(this, "CRASH in ${t.name}: ${android.util.Log.getStackTraceString(e)}")
            previous?.uncaughtException(t, e)
        }
        Diag.log(this, "engine service starting")
        try {
            startForeground(1, foregroundNotification())
        } catch (e: Exception) {
            Diag.log(this, "startForeground failed: $e")
        }
        tailscale = TailscaleManager(this)
        updater = Updater(this)
        busyLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MausDroid:busy")
        val bridgeToken = MausApp.secret(this, "bridge-token")
        try {
            bridge = BridgeServer(this, bridgeToken, { browser }, tailscale, updater, this).also { it.start(30_000, true) }
            Diag.log(this, "native bridge listening")
        } catch (e: Exception) {
            Diag.log(this, "native bridge failed: ${android.util.Log.getStackTraceString(e)}")
        }
        startEngine(bridgeToken)
        scheduleHeartbeat(this)
        main.postDelayed(::periodicUpdateCheck, 90_000)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_HEARTBEAT) {
            // Woken by the alarm (works in Doze): stay awake briefly so routines can run.
            getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MausDroid:tick").acquire(90_000)
            scheduleHeartbeat(this)
        }
        return START_STICKY
    }

    private fun foregroundNotification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, MausApp.CH_SERVICE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("MausDroid is ready")
            .setContentText("Your bots keep working in the background")
            .setContentIntent(open)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
    }

    @Volatile private var starts = 0

    private fun startEngine(bridgeToken: String) {
        if (started) return
        started = true
        // Node needs a large stack; Android's default thread stack is too small for it.
        Thread(null, {
          try {
            val dir = updater.engineDirForLaunch()
            val data = File(filesDir, "engine-data").apply { mkdirs() }
            val env = mapOf(
                "MAUSDROID_DATA_DIR" to data.absolutePath,
                "MAUSDROID_UI_DIR" to File(dir, "ui").absolutePath,
                "MAUSDROID_PORT" to MausApp.ENGINE_PORT.toString(),
                "MAUSDROID_TOKEN" to MausApp.secret(this, "ui-token"),
                "MAUSDROID_BRIDGE_URL" to "http://127.0.0.1:${MausApp.BRIDGE_PORT}",
                "MAUSDROID_BRIDGE_TOKEN" to bridgeToken,
                "MAUSDROID_TAILNET_PROXY" to "127.0.0.1:${MausApp.TAILNET_PROXY_PORT}",
                "MAUSDROID_APK_VERSION" to BuildConfig.VERSION_NAME,
                "MAUSDROID_PLATFORM" to "android",
                "MAUSDROID_NATIVE_DIR" to applicationInfo.nativeLibraryDir,
                "HOME" to data.absolutePath,
                "TMPDIR" to cacheDir.absolutePath,
            )
            for ((k, v) in env) NodeRuntime.setEnv(k, v)
            NodeRuntime.setLogFile(Diag.engineLog(this).absolutePath)
            // Counted BEFORE starting: a fatal error in the engine ends the whole process, so
            // nothing after NodeRuntime.start may run. "Ready" clears the count.
            starts = Diag.crashesRecently(this)
            if (starts > 3) {
                if (updater.markBad(dir.name)) {
                    Diag.log(this, "engine ${dir.name} failed to start 3 times; going back to the built-in version")
                    Diag.clearCrashes(this)
                    restartProcess(this)
                } else {
                    Diag.log(this, "engine ${dir.name} failed to start 3 times in 5 minutes; looking for a fixed version online")
                    // The built-in engine is broken: a fixed one may already be published.
                    val st = try { updater.check() } catch (e: Exception) { null }
                    if (st?.optString("state") == "ready" && updater.stageForRestart()) {
                        Diag.log(this, "found engine ${st.optString("available")}; trying it")
                        Diag.clearCrashes(this)
                        restartProcess(this)
                    } else Diag.log(this, "no fixed version found (${st?.optString("state")}: ${st?.optString("message")}); not restarting automatically")
                }
                return@Thread
            }
            Diag.log(this, "starting engine ${dir.name}")
            val code = NodeRuntime.start(arrayOf("node", File(dir, "engine.cjs").absolutePath))
            Diag.log(this, "engine exited with code $code")
          } catch (e: Throwable) {
            Diag.log(this, "engine could not start: ${android.util.Log.getStackTraceString(e)}")
          }
            // Restart, but stop after repeated failures so the problem can be seen and reported.
            if (starts <= 3) restartProcess(this)
            else Diag.log(this, "engine failed 3 times in 5 minutes; not restarting automatically")
        }, "node-engine", 64L * 1024 * 1024).apply { isDaemon = true }.start()
    }

    override fun engineReady(version: String) {
        Diag.log(this, "engine $version ready")
        Diag.clearCrashes(this)
        updater.confirmReady(version)
    }

    override fun setBusy(busy: Boolean) {
        this.busy = busy
        val l = busyLock ?: return
        // Hold the CPU awake only while a bot is actually working (max 30 min per hold).
        if (busy && !l.isHeld) l.acquire(30 * 60_000L) else if (!busy && l.isHeld) l.release()
    }

    override fun applyUpdate(): Boolean {
        if (!updater.stageForRestart()) return false
        main.postDelayed({ restartProcess(this) }, 500)
        return true
    }

    private fun periodicUpdateCheck() {
        Thread {
            val s = updater.check()
            // Install quietly when nothing is running; otherwise try again later.
            if (s.optString("state") == "ready" && !busy) applyUpdate()
        }.start()
        main.postDelayed(::periodicUpdateCheck, 6 * 60 * 60_000L)
    }

    override fun onDestroy() {
        bridge?.stop()
        tailscale.stop()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "MausService"
        const val ACTION_HEARTBEAT = "au.mausdroid.HEARTBEAT"

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, EngineService::class.java))
        }

        /** Wakes the service every ~15 minutes, even in Doze, so routines and alerts run on time. */
        fun scheduleHeartbeat(ctx: Context) {
            val pi = PendingIntent.getForegroundService(ctx, 1, Intent(ctx, EngineService::class.java).setAction(ACTION_HEARTBEAT), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            ctx.getSystemService(AlarmManager::class.java).setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + 15 * 60_000L, pi)
        }

        /** Node can only start once per process, so updates and crashes restart the whole engine process. */
        fun restartProcess(ctx: Context) {
            val pi = PendingIntent.getForegroundService(ctx, 2, Intent(ctx, EngineService::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            ctx.getSystemService(AlarmManager::class.java).setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + 1500, pi)
            android.os.Process.killProcess(android.os.Process.myPid())
        }
    }
}
