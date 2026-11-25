package au.mausdroid

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * One short location fix when a bot or routine asks (never continuous
 * tracking, never stored). Uses Android's fused provider (Android 12+),
 * falling back to network/GPS. Never returns made-up coordinates.
 */
object DeviceLocation {
    private const val PREFS = "location"

    /** granted / denied / permanently_denied / not_requested */
    fun permissionState(ctx: Context): String {
        val fine = ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = ctx.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (fine || coarse) return "granted"
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("lastAnswer", "not_requested") ?: "not_requested"
    }

    /** Recorded by MainActivity after the Android permission dialog. */
    fun recordAnswer(ctx: Context, answer: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("lastAnswer", answer).apply()
    }

    private fun json(l: Location, provider: String, stale: Boolean) = JSONObject()
        .put("latitude", l.latitude)
        .put("longitude", l.longitude)
        .put("accuracy_m", if (l.hasAccuracy()) Math.round(l.accuracy.toDouble()) else JSONObject.NULL)
        .put("timestamp", Instant.ofEpochMilli(l.time).toString())
        .put("age_s", (System.currentTimeMillis() - l.time) / 1000)
        .put("provider", provider)
        .put("stale", stale)
        .put("permission", "granted")

    @SuppressLint("MissingPermission")
    fun get(ctx: Context, maxAgeMs: Long, timeoutMs: Long): JSONObject {
        val perm = permissionState(ctx)
        if (perm != "granted") return JSONObject().put("permission", perm).put("error", "permission_" + perm)
        val lm = ctx.getSystemService(LocationManager::class.java)
        if (!lm.isLocationEnabled) return JSONObject().put("permission", "granted").put("error", "location_off")
        val fused = if (Build.VERSION.SDK_INT >= 31 && lm.hasProvider(LocationManager.FUSED_PROVIDER)) LocationManager.FUSED_PROVIDER else null
        val providers = listOfNotNull(fused, LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER).filter { p -> p == fused || lm.isProviderEnabled(p) }
        if (providers.isEmpty()) return JSONObject().put("permission", "granted").put("error", "no_provider")

        // A recent enough fix is used as is (no new request, saves battery).
        var newest: Pair<Location, String>? = null
        for (p in providers) {
            val l = try { lm.getLastKnownLocation(p) } catch (_: Exception) { null } ?: continue
            if (newest == null || l.time > newest.first.time) newest = l to p
        }
        newest?.let { (l, p) -> if (System.currentTimeMillis() - l.time <= maxAgeMs) return json(l, p, false) }

        // Otherwise one fresh fix, with a time limit.
        val provider = providers.first()
        val latch = CountDownLatch(1)
        var fresh: Location? = null
        val cancel = CancellationSignal()
        if (Build.VERSION.SDK_INT >= 30) {
            val exec = Executors.newSingleThreadExecutor()
            lm.getCurrentLocation(provider, cancel, exec) { l -> fresh = l; latch.countDown() }
            if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) cancel.cancel()
            exec.shutdown()
        } else {
            val handler = Handler(Looper.getMainLooper())
            @Suppress("DEPRECATION")
            handler.post { lm.requestSingleUpdate(provider, { l -> fresh = l; latch.countDown() }, Looper.getMainLooper()) }
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        }
        fresh?.let { return json(it, provider, false) }
        // No fresh fix in time: an older real fix is returned, clearly marked stale.
        newest?.let { (l, p) -> return json(l, p, true).put("note", "No fresh fix within ${timeoutMs / 1000}s; this is the last known position.") }
        return JSONObject().put("permission", "granted").put("error", "unavailable")
    }
}
