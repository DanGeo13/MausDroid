package au.mausdroid

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.io.File
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records speech to a WAV file with any voice engine on the phone (e.g.
 * Kokoro), for the weekly audio overview. It has its own voice engine
 * connection, so speaking to you (or being interrupted) never cuts a
 * recording short.
 */
class VoiceRecorder(private val ctx: Context) {
    private val main = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    @Volatile private var ready = false
    @Volatile private var enginePkg: String? = null
    private val waiting = ConcurrentHashMap<String, Pair<CountDownLatch, BooleanArray>>()

    private fun connect(engine: String?) {
        if (tts != null && ready && engine == enginePkg) return
        val latch = CountDownLatch(1)
        main.post {
            tts?.shutdown()
            ready = false
            val listener = TextToSpeech.OnInitListener { status ->
                ready = status == TextToSpeech.SUCCESS
                if (ready) tts?.setOnUtteranceProgressListener(progress)
                latch.countDown()
            }
            enginePkg = engine
            tts = if (engine.isNullOrBlank()) TextToSpeech(ctx, listener) else TextToSpeech(ctx, listener, engine)
        }
        latch.await(20, TimeUnit.SECONDS)
        if (!ready) throw IllegalStateException("The voice engine ${engine ?: "(phone default)"} didn't start.")
    }

    private val progress = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {}
        override fun onDone(utteranceId: String?) = done(utteranceId, true)
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) = done(utteranceId, false)
        override fun onError(utteranceId: String?, errorCode: Int) = done(utteranceId, false)
        override fun onStop(utteranceId: String?, interrupted: Boolean) = done(utteranceId, false)
    }

    private fun done(id: String?, ok: Boolean) {
        val w = waiting.remove(id ?: return) ?: return
        w.second[0] = ok
        w.first.countDown()
    }

    /** Records text with the given engine/voice to [out] (WAV). Returns the file size. */
    @Synchronized
    fun record(text: String, engine: String?, voice: String?, pitch: Float, rate: Float, out: File, timeoutSec: Long = 170): Long {
        connect(engine?.takeIf { it.isNotBlank() })
        out.parentFile?.mkdirs()
        out.delete()
        val id = "rec-" + UUID.randomUUID()
        val latch = CountDownLatch(1)
        val result = booleanArrayOf(false)
        waiting[id] = latch to result
        main.post {
            val t = tts
            if (t == null) { done(id, false); return@post }
            t.setPitch(pitch.coerceIn(0.5f, 2f))
            t.setSpeechRate(rate.coerceIn(0.5f, 2f))
            val v = if (voice.isNullOrBlank()) null else runCatching { t.voices?.firstOrNull { it.name == voice } }.getOrNull()
            if (v != null) t.voice = v else runCatching { t.language = Locale.getDefault() }
            val r = t.synthesizeToFile(text.take(3900), Bundle(), out, id)
            if (r != TextToSpeech.SUCCESS) done(id, false)
        }
        if (!latch.await(timeoutSec, TimeUnit.SECONDS)) {
            waiting.remove(id)
            throw IllegalStateException("The voice engine took too long to record.")
        }
        if (!result[0] || !out.exists() || out.length() < 100) throw IllegalStateException("The voice engine couldn't record this line.")
        return out.length()
    }
}
