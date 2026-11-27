package au.mausdroid

import android.content.Context
import android.content.Intent
import android.net.Uri
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject

/**
 * The engine's way to use phone features. Listens on 127.0.0.1 only and
 * requires a secret token, so other apps on the phone can't use it.
 */
class BridgeServer(
    private val ctx: Context,
    private val token: String,
    private val browserProvider: () -> BackgroundBrowser,
    private val tailscale: TailscaleManager,
    private val updater: Updater,
    private val hooks: Hooks,
) : NanoHTTPD("127.0.0.1", MausApp.BRIDGE_PORT) {

    interface Hooks {
        fun engineReady(version: String)
        fun setBusy(busy: Boolean)
        fun applyUpdate(): Boolean
    }

    private val browser: BackgroundBrowser get() = browserProvider()
    private val voice by lazy { Voice(ctx) }
    private val watch by lazy { VoiceWatch(ctx, voice) }
    private val recorder by lazy { VoiceRecorder(ctx) }

    private fun ok(o: Any = JSONObject().put("ok", true)) = newFixedLengthResponse(Response.Status.OK, "application/json", o.toString())
    private fun err(status: Response.Status, msg: String) = newFixedLengthResponse(status, "application/json", JSONObject().put("error", msg).toString())

    override fun serve(session: IHTTPSession): Response {
        if (session.headers["x-bridge-token"] != token) return err(Response.Status.UNAUTHORIZED, "bad token")
        val body: JSONObject = try {
            val files = HashMap<String, String>()
            if (session.method == Method.POST) session.parseBody(files)
            files["postData"]?.let { JSONObject(it) } ?: JSONObject()
        } catch (e: Exception) {
            JSONObject()
        }
        return try {
            when (session.uri) {
                "/notify" -> { Notifier.show(ctx, body); ok() }
                "/secret/encrypt" -> ok(JSONObject().put("cipher", Keystore.encrypt(body.getString("plain"))))
                "/secret/decrypt" -> ok(JSONObject().put("plain", Keystore.decrypt(body.getString("cipher"))))
                "/browser/open" -> ok(browser.open(body.getString("url"), body.optString("tab").ifBlank { null }))
                "/browser/read" -> ok(browser.read(body.getString("tab"), body.optString("mode", "text")))
                "/browser/click" -> ok(browser.click(body.getString("tab"), body.optString("selector").ifBlank { null }, body.optString("text").ifBlank { null }))
                "/browser/type" -> ok(browser.type(body.getString("tab"), body.getString("selector"), body.getString("text"), body.optBoolean("submit")))
                "/browser/scroll" -> ok(browser.scroll(body.getString("tab"), body.optString("direction", "down") != "up"))
                "/browser/screenshot" -> ok(browser.screenshot(body.getString("tab")))
                "/browser/close" -> { browser.close(body.getString("tab")); ok() }
                "/browser/tabs" -> ok(JSONObject().put("tabs", browser.list()))
                "/login/show" -> {
                    ctx.startActivity(
                        Intent(ctx, LoginActivity::class.java).putExtra("url", body.getString("url"))
                            .putExtra("reason", body.optString("reason")).putExtra("bot", body.optString("bot"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                    ok()
                }
                "/open-url" -> {
                    ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(body.getString("url"))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    ok()
                }
                "/tailscale/start" -> { tailscale.start(body.optString("hostname"), body.optString("authKey")); ok() }
                "/tailscale/stop" -> { tailscale.stop(); ok() }
                "/tailscale/status" -> ok(tailscale.status())
                "/update/status" -> ok(updater.status())
                "/update/check" -> ok(updater.check())
                "/update/apply" -> ok(JSONObject().put("restarting", hooks.applyUpdate()))
                "/engine/ready" -> { hooks.engineReady(body.optString("version")); ok() }
                "/busy" -> { hooks.setBusy(body.optBoolean("busy")); ok() }
                "/voice/listen" -> {
                    // The microphone can only be used by one listener: stop the interruption watcher first.
                    watch.stop()
                    val (text, error, code) = voice.listenBlocking(body.optLong("timeoutSec", 45), body.optLong("silenceMs", 0))
                    val missed = code == android.speech.SpeechRecognizer.ERROR_NO_MATCH || code == android.speech.SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                    when {
                        text != null -> ok(JSONObject().put("text", text))
                        missed -> ok(JSONObject().put("text", "").put("missed", true))
                        body.optBoolean("soft") -> ok(JSONObject().put("text", "").put("error", error ?: "No speech").put("code", code))
                        else -> err(Response.Status.BAD_REQUEST, error ?: "No speech")
                    }
                }
                "/voice/speak" -> {
                    configureVoice(body)
                    if (body.optBoolean("wait")) voice.speakBlocking(body.optString("text"), body.optDouble("rate", 1.0).toFloat())
                    else voice.speak(body.optString("text"), body.optDouble("rate", 1.0).toFloat())
                    ok()
                }
                "/voice/say" -> {
                    configureVoice(body)
                    if (body.optBoolean("flush")) voice.stopSpeaking()
                    voice.say(body.optString("text"), body.optDouble("rate", 1.0).toFloat())
                    ok()
                }
                "/voice/state" -> ok(JSONObject().put("speaking", voice.isSpeaking()))
                "/voice/await-speech" -> {
                    val (heard, speaking, problem) = watch.awaitSpeech(body.optLong("maxMs", 300), body.optBoolean("bargeIn", true))
                    ok(JSONObject().put("speech", heard).put("speaking", speaking).put("level", watch.level()).apply { if (problem != null) put("error", problem) })
                }
                "/voice/watch-stop" -> { watch.stop(); ok() }
                "/voice/call-mode" -> { voice.setCallMode(body.optBoolean("on")); if (!body.optBoolean("on")) watch.stop(); ok() }
                "/voice/synthesize" -> {
                    val out = java.io.File(body.getString("out"))
                    // Only into MausDroid's own storage.
                    if (!out.canonicalPath.startsWith(ctx.filesDir.parentFile!!.canonicalPath)) return err(Response.Status.FORBIDDEN, "Not allowed there")
                    val size = recorder.record(body.getString("text"), body.optString("engine"), body.optString("voice"), body.optDouble("pitch", 1.0).toFloat(), body.optDouble("rate", 1.0).toFloat(), out)
                    ok(JSONObject().put("ok", true).put("bytes", size))
                }
                "/files/save-download" -> {
                    val src = java.io.File(body.getString("path"))
                    if (!src.canonicalPath.startsWith(ctx.filesDir.parentFile!!.canonicalPath)) return err(Response.Status.FORBIDDEN, "Only MausDroid's own files")
                    ok(Downloads.save(ctx, src.path, body.optString("name", src.name), body.optString("mime"), body.optString("folder", "MausDroid")))
                }
                "/voice/engines" -> ok(JSONObject().put("engines", voice.engines()))
                "/voice/voices" -> ok(voice.voices(body.optString("engine").takeIf { it.isNotBlank() }))
                "/call/ring" -> { CallRinger.ring(ctx, body.getString("callId"), body.optString("name", "Maus"), body.optString("emoji", "🐭"), body.optString("reason")); ok() }
                "/call/stop-ring" -> { CallRinger.stop(ctx); ok() }
                "/voice/stop" -> { voice.stopSpeaking(); voice.stopListening(); watch.stop(); ok() }
                "/location/get" -> ok(DeviceLocation.get(ctx, body.optLong("maxAgeMs", 120_000), body.optLong("timeoutMs", 20_000)))
                "/location/permission" -> ok(JSONObject().put("permission", DeviceLocation.permissionState(ctx)))
                "/device/info" -> ok(DeviceSettings.info(ctx))
                "/notifications/status" -> {
                    val w = NotificationWatcher.readWatch(ctx)
                    ok(JSONObject().put("access", NotificationWatcher.hasAccess(ctx)).put("packages", w.optJSONArray("packages") ?: org.json.JSONArray()).put("seen", w.optJSONObject("seen") ?: JSONObject()))
                }
                "/notifications/open-settings" -> {
                    ctx.startActivity(Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    ok()
                }
                "/notifications/watch" -> {
                    synchronized(NotificationWatcher::class.java) {
                        val w = NotificationWatcher.readWatch(ctx)
                        w.put("packages", body.optJSONArray("packages") ?: org.json.JSONArray())
                        NotificationWatcher.writeWatch(ctx, w)
                    }
                    ok()
                }
                "/notifications/rescan" -> ok(JSONObject().put("asked", NotificationWatcher.rescan(ctx)))
                else -> if (session.uri.startsWith("/device/")) ok(JSONObject().put("opened", DeviceSettings.open(ctx, session.uri.removePrefix("/device/"))))
                else err(Response.Status.NOT_FOUND, "unknown ${session.uri}")
            }
        } catch (e: Exception) {
            err(Response.Status.INTERNAL_ERROR, e.message ?: e.toString())
        }
    }

    /** Voice engine, voice and pitch chosen in Settings (sent with each request). */
    private fun configureVoice(body: JSONObject) {
        if (body.has("engine") || body.has("voice") || body.has("pitch"))
            voice.configure(body.optString("engine"), body.optString("voice").takeIf { it.isNotBlank() }, body.optDouble("pitch", 1.0).toFloat())
    }
}
