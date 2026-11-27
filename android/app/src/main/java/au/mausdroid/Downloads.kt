package au.mausdroid

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import org.json.JSONObject
import java.io.File

/**
 * Saves a file to the phone's Downloads folder (Download/MausDroid) so any
 * app's file picker can find it, then checks the saved copy's size.
 */
object Downloads {
    /** Deletes a file this app saved to Downloads (no permission needed for its own files). */
    fun delete(ctx: Context, uri: String): Boolean = runCatching {
        if (uri.startsWith("content://")) ctx.contentResolver.delete(android.net.Uri.parse(uri), null, null) > 0
        else File(java.net.URI(uri)).delete()
    }.getOrDefault(false)

    fun save(ctx: Context, path: String, name: String, mime: String, folder: String): JSONObject {
        val src = File(path)
        if (!src.isFile) throw IllegalArgumentException("File not found.")
        val safeFolder = folder.replace(Regex("[^A-Za-z0-9 _-]"), "").ifBlank { "MausDroid" }
        val safeName = name.replace(Regex("[\\\\/:*?\"<>|]"), " ").trim().ifBlank { src.name }
        if (Build.VERSION.SDK_INT >= 29) {
            val resolver = ctx.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, safeName)
                put(MediaStore.MediaColumns.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
                put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$safeFolder")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("Android refused to create the file in Downloads.")
            try {
                resolver.openOutputStream(uri)?.use { o -> src.inputStream().use { it.copyTo(o) } } ?: throw IllegalStateException("Couldn't write to Downloads.")
                resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            } catch (e: Exception) {
                resolver.delete(uri, null, null)
                throw e
            }
            // Check what landed (Android may rename it, e.g. "Week 8 (1).pdf").
            var size = -1L
            var finalName = safeName
            resolver.query(uri, arrayOf(MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) { size = c.getLong(0); finalName = c.getString(1) ?: safeName }
            }
            if (size < 0) size = resolver.openInputStream(uri)?.use { it.available().toLong() } ?: -1
            return JSONObject().put("uri", uri.toString()).put("name", finalName).put("location", "Download/$safeFolder/$finalName").put("size", size)
        }
        // Android 9: the public Downloads folder directly.
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), safeFolder)
        dir.mkdirs()
        var dest = File(dir, safeName)
        var n = 1
        while (dest.exists()) dest = File(dir, "${safeName.substringBeforeLast('.')} ($n)${if (safeName.contains('.')) "." + safeName.substringAfterLast('.') else ""}").also { n++ }
        src.copyTo(dest)
        MediaScannerConnection.scanFile(ctx, arrayOf(dest.absolutePath), arrayOf(mime), null)
        return JSONObject().put("uri", dest.toURI().toString()).put("name", dest.name).put("location", "Download/$safeFolder/${dest.name}").put("size", dest.length())
    }
}
