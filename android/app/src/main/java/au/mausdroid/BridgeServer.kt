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
                    val (text, error) = voice.listenBlocking()
                    if (text != null) ok(JSONObject().put("text", text)) else err(Response.Status.BAD_REQUEST, error ?: "No speech")
                }
                "/voice/speak" -> { voice.speak(body.optString("text"), body.optDouble("rate", 1.0).toFloat()); ok() }
                "/voice/stop" -> { voice.stopSpeaking(); voice.stopListening(); ok() }
                "/device/info" -> ok(DeviceSettings.info(ctx))
                else -> if (session.uri.startsWith("/device/")) ok(JSONObject().put("opened", DeviceSettings.open(ctx, session.uri.removePrefix("/device/"))))
                else err(Response.Status.NOT_FOUND, "unknown ${session.uri}")
            }
        } catch (e: Exception) {
            err(Response.Status.INTERNAL_ERROR, e.message ?: e.toString())
        }
    }
}
