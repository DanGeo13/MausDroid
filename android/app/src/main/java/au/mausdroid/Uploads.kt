package au.mausdroid

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** Sends a file (from the share menu, the file picker or the assistant) to the engine's file store. */
object Uploads {
    fun nameOf(ctx: Context, uri: Uri): String {
        try {
            ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0)?.let { return it }
            }
        } catch (_: Exception) {
        }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "file"
    }

    /** Streams the file to the engine; returns the attachment JSON. */
    fun upload(ctx: Context, uri: Uri, nameOverride: String? = null): JSONObject {
        val name = nameOverride ?: nameOf(ctx, uri)
        val mime = ctx.contentResolver.getType(uri) ?: "application/octet-stream"
        return post(ctx, name, mime) { out -> ctx.contentResolver.openInputStream(uri)!!.use { it.copyTo(out, 64 * 1024) } }
    }

    fun uploadBytes(ctx: Context, name: String, mime: String, bytes: ByteArray): JSONObject = post(ctx, name, mime) { it.write(bytes) }

    private fun post(ctx: Context, name: String, mime: String, write: (java.io.OutputStream) -> Unit): JSONObject {
        val c = URL("http://127.0.0.1:${MausApp.ENGINE_PORT}/api/files").openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.doOutput = true
        c.setChunkedStreamingMode(64 * 1024)
        c.connectTimeout = 5000
        c.readTimeout = 120_000
        c.setRequestProperty("authorization", "Bearer ${MausApp.secret(ctx, "ui-token")}")
        c.setRequestProperty("content-type", mime)
        c.setRequestProperty("x-file-name", URLEncoder.encode(name, "UTF-8").replace("+", "%20"))
        c.outputStream.use(write)
        val text = (if (c.responseCode < 400) c.inputStream else c.errorStream).bufferedReader().readText()
        if (c.responseCode >= 400) throw RuntimeException("Upload failed (HTTP ${c.responseCode})")
        return JSONObject(text)
    }
}
